import { log, progress } from "../log.js";
import { sortByNameThenId } from "../normalize.js";
import { EXPORT_ITEMS } from "./exportItems.js";
import { isGuestSpaceRequiredError, KintoneClient, type KintoneApp, type KintoneSpace } from "./client.js";
import { moveMissingLocalKintoneEntries, type DeletedSummary } from "./deletedEntries.js";
import { pullTargets, type LocalEditSkip, type PullFailure, type PullResourceFailure } from "./pull.js";
import type { PermissionSkip } from "./permissionDenies.js";
import { writeSpaceExport } from "./serializers.js";
import { recordCompleteAppIndex } from "./bulkIndex.js";
import {
  buildSpaces,
  guestSpaceIdsOf,
  listAllAppsForIndex,
  markPullIncompleteInIndex,
  markPulledInIndex,
  mergeRemoteAppsIntoIndex,
  needsPull,
  normalizeRemoteApps,
  readAppIndex,
  spaceAppsFor,
  withGuestSpaceIds,
  writeAppIndex,
  type IndexedSpace
} from "./appIndex.js";
import { appIdOf, stringify } from "./ids.js";
import fs from "node:fs";
import path from "node:path";
import { kintoneSpacesRootPath } from "../paths.js";

export interface SpaceFailure {
  space: string; // "space-64" / "guestspace-80"（pull tracked-spaces の failures と同じ形）
  message: string;
}

interface SpaceDetail {
  id: string;
  guestSpaceId: string; // ゲストなら id と同じ、通常なら ""
  payload: KintoneSpace;
}

export interface PullAppsSummary {
  apiCalls: {
    apps: number;
    space: number;
    appDetail: number;
  };
  total: number;
  bulkSource: { version: 1; origin: string; fetchedAt: string; appsSha256: string };
  pulled: number;
  skipped: number;
  failed: number;
  failures: PullFailure[];
  resourceFailures: PullResourceFailure[];
  permissionSkips: PermissionSkip[];
  localEdits: LocalEditSkip[];
  spaceFailures: SpaceFailure[];
  guestSpacesDetected: string[];
  deleted: DeletedSummary;
  spacesRefreshed: string[];
}

// スペース詳細を取得する。通常 URL が GAIA_IL25 を返したらゲストスペースと確定し、/k/guest/{id}/ で取り直す。
// 1 スペースの失敗は failures に積んで続行する。ゲスト側の取り直しが失敗してもゲスト判定は維持する。
export async function fetchSpaceDetails({
  client,
  spaces
}: {
  client: Pick<KintoneClient, "getSpace">;
  spaces: IndexedSpace[];
}): Promise<{ details: SpaceDetail[]; detectedGuestSpaceIds: string[]; failures: SpaceFailure[]; apiCalls: number }> {
  const details: SpaceDetail[] = [];
  const detectedGuestSpaceIds: string[] = [];
  const failures: SpaceFailure[] = [];
  let apiCalls = 0;
  for (const space of spaces) {
    const id = space.id;
    let guestSpaceId = space.guestSpaceId;
    progress(`${space.type}-${id}`);
    try {
      let payload: KintoneSpace;
      try {
        apiCalls += 1;
        payload = await client.getSpace(id, { guestSpaceId });
      } catch (error) {
        if (guestSpaceId || !isGuestSpaceRequiredError(error)) throw error;
        guestSpaceId = id;
        detectedGuestSpaceIds.push(id);
        log(`space-${id} はゲストスペースでした。guestspace-${id} として取得し直します。`);
        apiCalls += 1;
        payload = await client.getSpace(id, { guestSpaceId });
      }
      details.push({ id, guestSpaceId, payload });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const label = guestSpaceId ? `guestspace-${id}` : `space-${id}`;
      log(`${label} 取得失敗: ${message}`);
      failures.push({ space: label, message });
    }
  }
  const uniqueDetails = new Map<string, SpaceDetail>();
  for (const detail of details) uniqueDetails.set(`${detail.guestSpaceId ? "guestspace" : "space"}:${detail.id}`, detail);
  const successfulLabels = new Set([...uniqueDetails.values()].map((detail) => `${detail.guestSpaceId ? "guestspace" : "space"}-${detail.id}`));
  return {
    details: [...uniqueDetails.values()],
    detectedGuestSpaceIds: [...new Set(detectedGuestSpaceIds)],
    failures: failures.filter((failure) => !successfulLabels.has(failure.space)),
    apiCalls
  };
}

export async function pullApps({ force = false }: { force?: boolean } = {}): Promise<PullAppsSummary> {
  const client = new KintoneClient();
  const previousIndex = readAppIndex();

  log("apps.json で全アプリを列挙中...");
  const { apps: listedApps, apiCalls } = await listAllAppsForIndex(client);

  // 1) 仮分類: /apps.json はゲストアプリにも guestSpaceId を付けないため、索引で判明済みのゲストを先に反映する。
  const knownGuestSpaceIds = guestSpaceIdsOf(previousIndex.values());
  const provisionalApps = normalizeRemoteApps(withGuestSpaceIds(listedApps, knownGuestSpaceIds), previousIndex);
  // スペース本文・所属アプリ一覧はアプリ modifiedAt と独立して変わるため、差分対象に関係なく全追跡スペースを確認する。
  const spaceMap = new Map<string, IndexedSpace>();
  for (const space of buildSpaces([...provisionalApps, ...previousIndex.values()])) spaceMap.set(`${space.type}:${space.id}`, space);
  const spacesRoot = kintoneSpacesRootPath();
  if (fs.existsSync(spacesRoot)) {
    for (const entry of fs.readdirSync(spacesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const guest = /^guestspace-([1-9]\d*)$/.exec(entry.name);
      const normal = /^space-([1-9]\d*)$/.exec(entry.name);
      const id = guest?.[1] ?? normal?.[1];
      if (!id) continue;
      const isGuest = Boolean(guest || knownGuestSpaceIds.has(id));
      const type = isGuest ? "guestspace" : "space";
      spaceMap.set(`${type}:${id}`, { id, spaceId: isGuest ? "" : id, guestSpaceId: isGuest ? id : "", type, appCount: 0 });
    }
  }
  const spacesToRefresh = [...spaceMap.values()].sort((a, b) => a.type.localeCompare(b.type, "en") || a.id.localeCompare(b.id, "en"));

  // 2) スペース詳細取得。GAIA_IL25 のスペースはここでゲストと確定する（失敗しても全体は止めない）。
  const spaceResult = await fetchSpaceDetails({ client, spaces: spacesToRefresh });

  // 3) 確定分類: 判明したゲストを反映した apps で、削除判定・差分判定・索引・アプリ取得を行う。
  const guestSpaceIds = new Set([...knownGuestSpaceIds, ...spaceResult.detectedGuestSpaceIds]);
  const rawApps = withGuestSpaceIds(listedApps, guestSpaceIds);
  const uncertainSpaceIds = new Set(spaceResult.failures.flatMap((failure) => {
    const match = /^space-([1-9]\d*)$/.exec(failure.space);
    return match ? [match[1]] : [];
  }));
  const allNormalizedApps = normalizeRemoteApps(rawApps, previousIndex);
  const uncertainAppIds = new Set(allNormalizedApps.filter((app) => !app.guestSpaceId && uncertainSpaceIds.has(app.spaceId)).map((app) => app.appId));
  const apps = allNormalizedApps.filter((app) => !uncertainAppIds.has(app.appId));
  const appById = new Map(rawApps.map((app) => [appIdOf(app), app]));

  log(`${apps.length} アプリ。削除判定中...`);
  // ゲスト反映済みの rawApps を渡す（未反映だと guestspace-<id>/apps/ が所属違いとして deleted/ へ移される）。
  const deleted = await moveMissingLocalKintoneEntries({ client, allApps: rawApps });
  if (deleted.apps.length || deleted.spaces.length) {
    log(`deleted へ移動: ${deleted.apps.length} apps, ${deleted.spaces.length} spaces`);
  }

  const targets = apps.filter((app) => needsPull({ remote: app, previous: previousIndex.get(app.appId), force }));
  log(`差分取得対象: ${targets.length} apps / skipped: ${listedApps.length - targets.length}`);

  // apps.json に出ないゲストアプリ（pull app --guestspace 等で追加済み）の索引は保持する。
  const preservedGuestApps = [...previousIndex.values()].filter(
    (a) => a.guestSpaceId && !apps.some((n) => n.appId === a.appId)
  );
  const preservedUncertainApps = [...previousIndex.values()].filter((app) => uncertainAppIds.has(app.appId));
  const indexApps = [...apps, ...preservedGuestApps, ...preservedUncertainApps].length
    ? sortByNameThenId([...apps, ...preservedGuestApps, ...preservedUncertainApps], "name", "appId")
    : apps;
  const detectedGuests = new Set(spaceResult.detectedGuestSpaceIds);
  const successfulSpaceKeys = new Set(spaceResult.details.map((space) => `${space.guestSpaceId ? "guestspace" : "space"}:${space.id}`));
  const trackedIndexSpaces = new Map<string, IndexedSpace>();
  for (const space of spacesToRefresh) {
    const guestSpaceId = space.guestSpaceId || (detectedGuests.has(space.id) ? space.id : "");
    const indexedSpace: IndexedSpace = {
      id: space.id,
      spaceId: guestSpaceId ? "" : space.spaceId || space.id,
      guestSpaceId,
      type: guestSpaceId ? "guestspace" : "space",
      appCount: 0
    };
    const dirName = `${indexedSpace.type}-${indexedSpace.id}`;
    if (!successfulSpaceKeys.has(`${indexedSpace.type}:${indexedSpace.id}`) && !fs.existsSync(path.join(kintoneSpacesRootPath(), dirName))) continue;
    trackedIndexSpaces.set(`${indexedSpace.type}:${indexedSpace.id}`, indexedSpace);
  }
  writeAppIndex(indexApps, [...trackedIndexSpaces.values()]);

  const spacesRefreshed: string[] = [];
  for (const detail of spaceResult.details) {
    const spaceId = detail.guestSpaceId ? "" : detail.id;
    const target: IndexedSpace = {
      id: detail.id,
      spaceId,
      guestSpaceId: detail.guestSpaceId,
      type: detail.guestSpaceId ? "guestspace" : "space",
      appCount: 0
    };
    let scopedApps: KintoneApp[] | undefined = spaceAppsFor(apps, target);
    if (detail.payload.attachedApps !== undefined) {
      const attached = detail.payload.attachedApps;
      const ids = Array.isArray(attached) ? attached.map((item: any) => String(typeof item === "object" && item ? item.appId ?? item.id ?? "" : item)) : [];
      const uniqueIds = new Set(ids);
      const appMap = new Map<string, KintoneApp>(apps.map((app) => [app.appId, {
        appId: app.appId,
        code: app.code,
        name: app.name,
        spaceId: app.spaceId,
        guestSpaceId: app.guestSpaceId
      }]));
      if (!Array.isArray(attached) || ids.some((id) => !/^[1-9]\d*$/.test(id)) || uniqueIds.size !== ids.length || ids.some((id) => !appMap.has(id))) {
        scopedApps = undefined;
        log(`${detail.guestSpaceId ? `guestspace-${detail.id}` : `space-${detail.id}`}: attachedApps を完全に照合できないため、既存 apps.json を保持します。`);
      } else {
        scopedApps = ids.map((id) => appMap.get(id)!);
      }
    }
    const { localEdits: spaceEdits } = writeSpaceExport({
      space: detail.payload,
      apps: scopedApps,
      guestSpaceId: detail.guestSpaceId,
      spaceId
    });
    if (spaceEdits.length > 0) {
      const spaceLabel = detail.guestSpaceId ? `guestspace-${detail.id}` : `space-${detail.id}`;
      log(
        `${spaceLabel}: スペース設定・本文のローカル編集を保持: ${spaceEdits.map((e) => e.file).join(", ")}` +
          `（確認は kint-origin diff space --id ${detail.id}${detail.guestSpaceId ? ` --guestspace ${detail.id}` : ""}）`
      );
    }
    spacesRefreshed.push(detail.guestSpaceId ? `guest:${detail.id}` : detail.id);
  }

  const pulledAt = new Date().toISOString();
  const { pulled, failures, permissionSkips, localEdits, resourceFailures } = await pullTargets({
    targets,
    appById,
    resolveLocation: (app) => ({ guestSpaceId: app.guestSpaceId, spaceId: app.guestSpaceId ? "" : app.spaceId }),
    pulledAt,
    force
  });
  const bulkSource = recordCompleteAppIndex();

  return {
    apiCalls: {
      apps: apiCalls,
      space: spaceResult.apiCalls,
      appDetail: targets.length * (EXPORT_ITEMS.length + 1)
    },
    total: listedApps.length,
    bulkSource,
    pulled,
    skipped: listedApps.length - targets.length,
    failed: failures.length,
    failures,
    resourceFailures,
    permissionSkips,
    localEdits,
    spaceFailures: spaceResult.failures,
    guestSpacesDetected: spaceResult.detectedGuestSpaceIds,
    deleted,
    spacesRefreshed
  };
}

export async function refreshAppIndexForPulledApp({
  appId,
  guestSpaceId = "",
  incomplete = false
}: {
  appId: string | number;
  guestSpaceId?: string;
  incomplete?: boolean;
}): Promise<void> {
  const client = new KintoneClient();
  const { apps } = await listAllAppsForIndex(client);
  // 通常アプリの索引を最新化（replaceAll しない＝guestspaces で追加済みの既知ゲスト索引を保持）。
  mergeRemoteAppsIntoIndex(apps);
  // 取得済みを記録。apps.json はゲストアプリに guestSpaceId を付けないため、指定された guestSpaceId で補う。
  // apps.json に出ないアプリは既知情報(appId/guestSpaceId)で登録する。
  const normal = apps.find((candidate) => appIdOf(candidate) === String(appId));
  markPulledInIndex([normal ? { ...normal, guestSpaceId: stringify(normal.guestSpaceId) || guestSpaceId } : { appId: String(appId), guestSpaceId }]);
  if (incomplete) markPullIncompleteInIndex(appId);
}
