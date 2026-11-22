import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { listFilesRecursive, readJsonIfExists, writeText } from "../fsutil.js";
import { log } from "../log.js";
import { assertRunLogWritable, recordLocalAction, recordRunEvent, runLogUnavailable } from "../runLog.js";
import { htmlRootPath, CYBOZU_COMMON_DATA_ROOT } from "../paths.js";
import { discoverSite, type AppEntry, type SiteModel } from "./discover.js";
import { buildRecordsData } from "./renderRecords.js";
import { renderAppPage, type AppPageData } from "./renderApp.js";
import { renderSpacePage } from "./renderSpace.js";
import { renderUsersPage } from "./renderUsers.js";
import { renderIndexPage } from "./renderIndex.js";

// html/ はツール専有ディレクトリ。マーカーが無い既存フォルダは誤削除防止のため上書きしない。
const HTML_MARKER_FILE = ".kint-origin-html";
const HTML_MARKER_CONTENT = "kint-origin html の生成物ディレクトリです。手動でファイルを置かないでください。\n";

export interface HtmlSummary {
  outDir: string;
  pages: number;
  apps: number;
  deletedApps: number;
  spaces: number;
  recordsApps: number;
  users: boolean;
  warnings: string[];
}

// JSON 読み込みの失敗（破損等）は生成を止めず warning に落として「未取得」扱いにする。
function readJsonSafe(filePath: string, warnings: string[]): unknown | undefined {
  try {
    return readJsonIfExists(filePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    warnings.push(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

function validateExistingHtmlDir(htmlRoot: string): void {
  const stat = fs.lstatSync(htmlRoot, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`html/ の出力先が通常のフォルダではありません: ${htmlRoot}`);
  const entries = fs.readdirSync(htmlRoot);
  if (entries.length === 0) return;
  const markerPath = path.join(htmlRoot, HTML_MARKER_FILE);
  const markerStat = fs.lstatSync(markerPath, { throwIfNoEntry: false });
  if (!markerStat || markerStat.isSymbolicLink() || !markerStat.isFile() || fs.readFileSync(markerPath, "utf8") !== HTML_MARKER_CONTENT) {
    throw new Error(`html/ に kint-origin html の生成物ではないファイルがあるため上書きしません: ${htmlRoot}`);
  }
}

function isFatalPageError(error: unknown): boolean {
  return runLogUnavailable() || Boolean(error && typeof error === "object" && "code" in error);
}

function installHtmlStage(stageRoot: string, htmlRoot: string): void {
  assertRunLogWritable();
  const backup = `${htmlRoot}.kint-origin-old-${process.pid}-${randomUUID()}`;
  const hadCurrent = fs.existsSync(htmlRoot);
  recordLocalAction("replace-html-output", htmlRoot, { stageRoot, backup: hadCurrent ? backup : "" });
  if (hadCurrent) fs.renameSync(htmlRoot, backup);
  try {
    fs.renameSync(stageRoot, htmlRoot);
  } catch (error) {
    if (hadCurrent && fs.existsSync(backup)) {
      try {
        fs.renameSync(backup, htmlRoot);
      } catch (restoreError) {
        throw new Error(`HTML の確定に失敗し、以前の html/ を元の場所へ戻せませんでした。退避先を確認してください: ${backup} (${restoreError instanceof Error ? restoreError.message : String(restoreError)})`);
      }
    }
    throw error;
  }
  if (hadCurrent) {
    try {
      fs.rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      log(`古いHTMLの退避フォルダを削除できませんでした: ${backup}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function toSlashPaths(paths: string[]): string[] {
  return paths.map((p) => p.split(path.sep).join("/"));
}

function buildAppPageData(app: AppEntry, site: SiteModel, htmlRoot: string, warnings: string[]): AppPageData {
  const dataHref = `../../data/${app.dataRelPath}`;
  const readApp = (...segments: string[]) => readJsonSafe(path.join(app.appDir, ...segments), warnings);

  const files: AppPageData["files"] = {
    appJson: readApp("app.json"),
    settings: readApp("app_settings", "settings.json"),
    status: readApp("app_settings", "status.json"),
    appActions: readApp("app_settings", "app_actions.json"),
    fields: readApp("form", "fields.json"),
    layout: readApp("form", "layout.json"),
    views: readApp("views", "views.json"),
    reports: readApp("reports", "reports.json"),
    notificationsGeneral: readApp("notifications", "notifications_general.json"),
    notificationsPerRecord: readApp("notifications", "notifications_perRecord.json"),
    notificationsReminder: readApp("notifications", "notifications_reminder.json"),
    plugins: readApp("customize", "plugins.json"),
    customize: readApp("customize", "customize.json"),
    appAcl: readApp("acl", "app_acl.json"),
    recordAcl: readApp("acl", "record_acl.json"),
    fieldAcl: readApp("acl", "field_acl.json")
  };

  // customize/ の実体ファイル（desktop/mobile 配下のみ。manifest 等は除外）。
  const customizeFiles = toSlashPaths(listFilesRecursive(path.join(app.appDir, "customize"))).filter(
    (file) => file.startsWith("desktop/") || file.startsWith("mobile/")
  );

  // APIラボのプラグイン設定（customize/plugin-configs/<pluginId>.json）。
  const pluginConfigsDir = path.join(app.appDir, "customize", "plugin-configs");
  const pluginConfigs: AppPageData["pluginConfigs"] = [];
  if (fs.existsSync(pluginConfigsDir)) {
    for (const file of fs.readdirSync(pluginConfigsDir).filter((name) => name.endsWith(".json")).sort()) {
      const payload = readJsonSafe(path.join(pluginConfigsDir, file), warnings);
      if (payload !== undefined) pluginConfigs.push({ id: file.replace(/\.json$/, ""), payload });
    }
  }

  const attachments = toSlashPaths(listFilesRecursive(path.join(app.appDir, "records", "attachments"))).filter(
    (file) => path.basename(file) !== ".kint-origin-attachments.json" && !file.split("/").some((part) => part.startsWith(".kint-origin-stage-"))
  );

  // レコード: CSV を JSONP データ（app-<id>.records.js）へ変換して html/apps/ に併置する。
  let records: AppPageData["records"];
  if (app.hasRecordsCsv) {
    try {
      const csvText = fs.readFileSync(path.join(app.appDir, "records", "records.csv"), "utf8");
      const built = buildRecordsData({
        csvText,
        fieldsPayload: files.fields,
        attachmentsDir: path.join(app.appDir, "records", "attachments"),
        attachmentsHrefBase: `${dataHref}/records/attachments`
      });
      const recordsJsName = `app-${app.appId}.records.js`;
      writeText(path.join(htmlRoot, "apps", recordsJsName), built.recordsJs);
      records = { recordsJsName, total: built.total };
    } catch (error) {
      if (isFatalPageError(error)) throw error;
      warnings.push(
        `app-${app.appId} の records.csv を読み込めませんでした: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const space = site.spaces.find((s) => (app.guestSpaceId ? s.isGuest && s.id === app.guestSpaceId : !s.isGuest && s.id === app.spaceId));

  return {
    entry: app,
    spaceName: space?.name || "",
    files,
    pluginConfigs,
    customizeFiles,
    records,
    attachments,
    dataHref
  };
}

// 生成後にブラウザで index.html を開く（OS 標準の関連付けに任せる）。
function openInBrowser(indexPath: string, warnings: string[]): void {
  try {
    recordLocalAction("open-html-in-browser", indexPath);
    const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", indexPath] : [indexPath];
    recordRunEvent("child_start", { childType: "browser", command, args, detached: true });
    assertRunLogWritable();
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.once("error", (error) => {
      recordRunEvent("child_end", { childType: "browser", command, exitCode: 1, text: error.message });
      warnings.push(`ブラウザを開けませんでした: ${error.message}`);
    });
    child.unref();
  } catch (error) {
    warnings.push(`ブラウザを開けませんでした: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function generateHtml({ open = false }: { open?: boolean } = {}): Promise<HtmlSummary> {
  const htmlRoot = htmlRootPath();
  const lockPath = `${htmlRoot}.kint-origin-lock`;
  let lockFd = -1;
  try {
    lockFd = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(lockFd, `${process.pid}\n`, "utf8");
  } catch (error) {
    if (lockFd >= 0) fs.closeSync(lockFd);
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") fs.rmSync(lockPath, { force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`HTML 生成が既に実行中です（lock: ${lockPath}）。`);
    throw error;
  }
  const stageRoot = `${htmlRoot}.kint-origin-stage-${process.pid}-${randomUUID()}`;
  try {
    validateExistingHtmlDir(htmlRoot);
    fs.mkdirSync(stageRoot, { recursive: false });

    const site = discoverSite();
    const warnings = [...site.warnings];
    let pages = 0;
    let recordsApps = 0;

    for (const app of site.apps) {
    // 1アプリの失敗で全体を止めない（バルク取得と同じ方針）。
    try {
      const data = buildAppPageData(app, site, stageRoot, warnings);
      if (data.records) recordsApps += 1;
      writeText(path.join(stageRoot, "apps", `app-${app.appId}.html`), renderAppPage(data));
      pages += 1;
    } catch (error) {
      if (isFatalPageError(error)) throw error;
      warnings.push(`app-${app.appId} のページ生成に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    }
    }

    for (const space of site.spaces) {
    try {
      const bodyFile = path.join(space.spaceDir, "body.html");
      writeText(
        path.join(stageRoot, "spaces", `${space.dirName}.html`),
        renderSpacePage({
          entry: space,
          spaceJson: readJsonSafe(path.join(space.spaceDir, "space.json"), warnings),
          settingsJson: readJsonSafe(path.join(space.spaceDir, "settings.json"), warnings),
          hasBodyHtml: fs.existsSync(bodyFile),
          appsJson: readJsonSafe(path.join(space.spaceDir, "apps.json"), warnings),
          dataHref: `../../data/${space.dataRelPath}`,
          domain: site.domain
        })
      );
      pages += 1;
    } catch (error) {
      if (isFatalPageError(error)) throw error;
      warnings.push(`${space.dirName} のページ生成に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    }
    }

  if (site.hasUsers) {
    const csvDir = path.join(CYBOZU_COMMON_DATA_ROOT, "csv");
    writeText(
      path.join(stageRoot, "users.html"),
      renderUsersPage({
        users: readJsonSafe(path.join(CYBOZU_COMMON_DATA_ROOT, "users", "users.json"), warnings),
        groups: readJsonSafe(path.join(CYBOZU_COMMON_DATA_ROOT, "groups", "groups.json"), warnings),
        organizations: readJsonSafe(path.join(CYBOZU_COMMON_DATA_ROOT, "organizations", "organizations.json"), warnings),
        csvFiles: fs.existsSync(csvDir) ? fs.readdirSync(csvDir).filter((name) => name.endsWith(".csv")).sort() : [],
        dataHref: "../data/cybozu-common"
      })
    );
    pages += 1;
    }

    writeText(path.join(stageRoot, "index.html"), renderIndexPage(site));
    pages += 1;
    writeText(path.join(stageRoot, HTML_MARKER_FILE), HTML_MARKER_CONTENT);

    installHtmlStage(stageRoot, htmlRoot);
    const indexPath = path.join(htmlRoot, "index.html");
    log(`HTML を生成しました: ${indexPath}（ブラウザでこのファイルを開いてください）`);
    if (open) openInBrowser(indexPath, warnings);

    return {
      outDir: htmlRoot,
      pages,
      apps: site.apps.length,
      deletedApps: site.apps.filter((app) => app.deleted).length,
      spaces: site.spaces.length,
      recordsApps,
      users: site.hasUsers,
      warnings
    };
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    fs.closeSync(lockFd);
    fs.rmSync(lockPath, { force: true });
  }
}
