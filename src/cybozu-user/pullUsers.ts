import path from "node:path";
import { getEnv, type CybozuEnv } from "../env.js";
import { joinUrl, requestCybozuJson, requestCybozuText, type Query } from "../http.js";
import { writeJson, writeText } from "../fsutil.js";
import { cybozuCommonRootPath } from "../paths.js";
import { sortByNameThenId } from "../normalize.js";
import { createLimiter, mapWithLimit, DEFAULT_CONCURRENCY, type Limiter } from "../limit.js";
import { log } from "../log.js";

// CSV エクスポートは cybozu.com 側の生成に時間がかかることがあるためタイムアウトを延長する。
const CSV_EXPORT_TIMEOUT_MS = 300_000;
const CSV_EXPORT_CONCURRENCY = 3;

interface CodeEntity {
  code?: string;
  [key: string]: unknown;
}

class CybozuCommonClient {
  env: CybozuEnv = getEnv();

  async request(pathname: string, query?: Query): Promise<any> {
    return requestCybozuJson(this.env, joinUrl(this.env.baseUrl, pathname), { method: "GET", query });
  }

  async listAll(pathname: string, resultKey: string, query: Query = {}): Promise<any[]> {
    const size = 100;
    const values: any[] = [];
    const seen = new Set<string>();
    let offset = 0;
    while (true) {
      const payload = await this.request(pathname, { ...query, size, offset });
      if (!payload || !Array.isArray(payload[resultKey])) throw new Error(`${pathname} の応答に ${resultKey} 配列がありません。既存のユーザー情報は更新しません。`);
      const batch = payload[resultKey] as CodeEntity[];
      if (batch.length > size) throw new Error(`${pathname} が size=${size} を超える応答を返しました。既存のユーザー情報は更新しません。`);
      for (const item of batch) {
        if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.code !== "string" || !item.code) {
          throw new Error(`${pathname} に code を持たない項目があります。既存のユーザー情報は更新しません。`);
        }
        if (seen.has(item.code)) throw new Error(`${pathname} のページ間で code ${item.code} が重複しました。既存のユーザー情報は更新しません。`);
        seen.add(item.code);
      }
      values.push(...batch);
      if (batch.length < size) break;
      offset += size;
    }
    return values;
  }

  listUsers(): Promise<CodeEntity[]> {
    return this.listAll("/v1/users.json", "users");
  }
  listGroups(): Promise<CodeEntity[]> {
    return this.listAll("/v1/groups.json", "groups");
  }
  listOrganizations(): Promise<CodeEntity[]> {
    return this.listAll("/v1/organizations.json", "organizations");
  }
  listUserOrganizations(code: string): Promise<any> {
    return this.request("/v1/user/organizations.json", { code });
  }
  listUserGroups(code: string): Promise<any> {
    return this.request("/v1/user/groups.json", { code });
  }
  listUserServices(): Promise<CodeEntity[]> {
    return this.listAll("/v1/users/services.json", "users");
  }
  listOrganizationUsers(code: string): Promise<any[]> {
    return this.listAll("/v1/organization/users.json", "users", { code });
  }
  listGroupUsers(code: string): Promise<any[]> {
    return this.listAll("/v1/group/users.json", "users", { code });
  }
  exportCsv(pathname: string): Promise<string> {
    return requestCybozuText(this.env, joinUrl(this.env.baseUrl, pathname), { method: "GET", timeoutMs: CSV_EXPORT_TIMEOUT_MS });
  }
}

const CSV_EXPORTS = [
  { file: "user.csv", endpoint: "/v1/csv/user.csv" },
  { file: "userOrganizations.csv", endpoint: "/v1/csv/userOrganizations.csv" },
  { file: "userGroups.csv", endpoint: "/v1/csv/userGroups.csv" },
  { file: "userServices.csv", endpoint: "/v1/csv/userServices.csv" },
  { file: "organization.csv", endpoint: "/v1/csv/organization.csv" },
  { file: "group.csv", endpoint: "/v1/csv/group.csv" },
  { file: "title.csv", endpoint: "/v1/csv/title.csv" }
];

async function collectByCode(
  items: CodeEntity[],
  fetcher: (code: string) => Promise<any>,
  limiter: Limiter
): Promise<Record<string, any>> {
  // リクエストは limiter で並列化するが、entries は items の index 順で組み立てる
  // （出力 JSON のキー順を入力順に保つ＝差分安定化）。
  const entries = await mapWithLimit(items, limiter, async (item): Promise<[string, any] | null> => {
    const code = item.code || "";
    if (!code) return null;
    return [code, await fetcher(code)];
  });
  return Object.fromEntries(entries.filter((entry): entry is [string, any] => entry !== null));
}

function writeUsersExport(data: {
  users: CodeEntity[];
  groups: CodeEntity[];
  organizations: CodeEntity[];
  userOrganizations: Record<string, any>;
  userGroups: Record<string, any>;
  userServices: CodeEntity[];
  organizationUsers: Record<string, any>;
  groupUsers: Record<string, any>;
  csvExports: Record<string, string>;
}): void {
  const root = cybozuCommonRootPath();
  writeJson(path.join(root, "users", "users.json"), data.users);
  writeJson(path.join(root, "users", "organizations.json"), data.userOrganizations);
  writeJson(path.join(root, "users", "groups.json"), data.userGroups);
  writeJson(path.join(root, "users", "services.json"), data.userServices);
  writeJson(path.join(root, "groups", "groups.json"), data.groups);
  writeJson(path.join(root, "groups", "users.json"), data.groupUsers);
  writeJson(path.join(root, "organizations", "organizations.json"), data.organizations);
  writeJson(path.join(root, "organizations", "users.json"), data.organizationUsers);
  for (const [fileName, content] of Object.entries(data.csvExports)) {
    writeText(path.join(root, "csv", fileName), content);
  }
}

export async function pullUsers(): Promise<Record<string, number>> {
  const client = new CybozuCommonClient();
  log("users / groups / organizations / services 一覧取得中...");
  const [usersPayload, groupsPayload, organizationsPayload, userServicesPayload] = await Promise.all([
    client.listUsers(),
    client.listGroups(),
    client.listOrganizations(),
    client.listUserServices()
  ]);

  const users = sortByNameThenId(usersPayload, "name", "code");
  const groups = sortByNameThenId(groupsPayload, "name", "code");
  const organizations = sortByNameThenId(organizationsPayload, "name", "code");
  const userServices = sortByNameThenId(userServicesPayload, "code", "code");

  log(`users ${users.length}, groups ${groups.length}, organizations ${organizations.length}。所属情報を取得中...`);
  // 4ストリームで単一の limiter を共有し、全体で最大 DEFAULT_CONCURRENCY 並列に抑える
  // （User API の同時リクエストを増やしすぎない）。
  const limiter = createLimiter(DEFAULT_CONCURRENCY);
  const [userOrganizations, userGroups, organizationUsers, groupUsers] = await Promise.all([
    collectByCode(users, (code) => client.listUserOrganizations(code), limiter),
    collectByCode(users, (code) => client.listUserGroups(code), limiter),
    collectByCode(organizations, (code) => client.listOrganizationUsers(code), limiter),
    collectByCode(groups, (code) => client.listGroupUsers(code), limiter)
  ]);

  log(`CSV エクスポート ${CSV_EXPORTS.length} 件を取得中...`);
  const csvContents = await mapWithLimit(CSV_EXPORTS, CSV_EXPORT_CONCURRENCY, (item) => client.exportCsv(item.endpoint));
  const csvExports: Record<string, string> = {};
  CSV_EXPORTS.forEach((item, index) => {
    csvExports[item.file] = csvContents[index];
  });

  writeUsersExport({
    users,
    groups,
    organizations,
    userOrganizations,
    userGroups,
    userServices,
    organizationUsers,
    groupUsers,
    csvExports
  });

  return {
    users: users.length,
    groups: groups.length,
    organizations: organizations.length,
    userOrganizations: Object.keys(userOrganizations).length,
    userGroups: Object.keys(userGroups).length,
    userServices: userServices.length,
    organizationUsers: Object.keys(organizationUsers).length,
    groupUsers: Object.keys(groupUsers).length,
    csvExports: Object.keys(csvExports).length
  };
}
