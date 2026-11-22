import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { confirmYes } from "./confirm.js";
import { prepareAddonSync } from "./addon/operations.js";
import { ADDON_SKILL_PREFIX } from "./addon/state.js";
import { managedPullIgnoreBlock, mergePullIgnoreBlock, readTemplateGitignore } from "./domainGitignore.js";
import { assertNotToolRepository } from "./domainGuard.js";
import { listFilesRecursive } from "./fsutil.js";
import { applyPlannedWrites, distributedSkillNames, planAgents, SKILL_ROOTS, type PlannedWrite } from "./agents.js";
import { log } from "./log.js";
import { planPluginTemplate } from "./pluginTemplate.js";
import { recordLocalAction } from "./runLog.js";

const TEMPLATE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "template");

export interface UpdateResult {
  /** 書き込んだファイル（新規と、内容が変わったもの）。内容が同じものは含めない */
  updated: string[];
  /** 内容が同じで書き込まなかった配布ファイルの数 */
  unchanged: number;
  /** 上書きも削除もしなかった、利用者の独自スキル（kint-origin-local-*）。ドメインルートからの相対パス */
  preserved: string[];
  /** 名前の決まりに合わないスキルのフォルダ（配布物に無い kint-origin-*、kint-origin-local- で始まらない独自スキル）。上書きも削除もしない */
  warnings: string[];
  /** 配布元と同期した外部 addon。 */
  addons: string[];
  /** 確認で承認されず、何も書き込まなかった */
  aborted?: boolean;
}

// ツール管理ドキュメント（テンプレ正本から常に上書き再配布するファイル）。
// ユーザーの実データ（data/・push/new-apps/<実ドラフト>・push/records/<実ジョブ>・push/import/<実ジョブ>・favorites/<グループ名>.json）には触らない。
// favorites/_example.json はお気に入りグループの雛形（ツール管理）。
const MANAGED_TEMPLATE_FILES = ["README.md", path.join("favorites", "_example.json")];

// ツール管理サンプル（ディレクトリごと上書き再配布）。_example はツールの雛形でありユーザー編集対象外。
const MANAGED_TEMPLATE_DIRS = [
  path.join("push", "new-apps", "_example"),
  path.join("push", "records", "_example"),
  path.join("push", "import", "_example")
];

function plannedTemplateFiles(targetRoot: string): PlannedWrite[] {
  const planned: PlannedWrite[] = [];
  const add = (rel: string, source: string): void => {
    const content = fs.readFileSync(source, "utf8");
    const target = path.resolve(targetRoot, rel);
    const status = !fs.existsSync(target) ? "new" : fs.readFileSync(target, "utf8") === content ? "same" : "changed";
    planned.push({ path: rel.replaceAll(path.sep, "/"), status, content });
  };
  for (const rel of MANAGED_TEMPLATE_FILES) {
    const source = path.join(TEMPLATE_ROOT, rel);
    if (fs.existsSync(source)) add(rel, source);
  }
  for (const dirRel of MANAGED_TEMPLATE_DIRS) {
    const sourceDir = path.join(TEMPLATE_ROOT, dirRel);
    if (!fs.existsSync(sourceDir)) continue;
    for (const rel of listFilesRecursive(sourceDir)) add(path.join(dirRel, rel), path.join(sourceDir, rel));
  }
  const ignorePath = path.resolve(targetRoot, ".gitignore");
  const ignoreStat = fs.lstatSync(ignorePath, { throwIfNoEntry: false });
  if (ignoreStat?.isSymbolicLink() || (ignoreStat && !ignoreStat.isFile())) throw new Error(".gitignore は通常ファイルである必要があります。");
  if (!ignoreStat) {
    planned.push({ path: ".gitignore", status: "new", content: readTemplateGitignore() });
  } else {
    const existing = fs.readFileSync(ignorePath, "utf8");
    const content = mergePullIgnoreBlock(existing, managedPullIgnoreBlock(readTemplateGitignore()));
    planned.push({ path: ".gitignore", status: content === existing ? "same" : "append", content });
  }
  return planned;
}

/** ドメイン独自のスキル・ルールの接頭辞。update は上書きも削除もしない。 */
const LOCAL_SKILL_PREFIX = "kint-origin-local-";

// 名前を調べる置き場。書き込み先（SKILL_ROOTS）に加え、Cursor が読む .cursor/skills も見る（見るだけで書かない）。
const INSPECT_SKILL_ROOTS = [...SKILL_ROOTS, ".cursor/skills"];

// 利用者の独自スキル（kint-origin-local-*）と、名前の決まりに合わないスキルを調べる。
// - kint-origin-addon-*: 外部addonのリンク。何も出さない。
// - kint-origin-local-*: 独自スキル。preserved に出す。
// - 配布物に無いその他の kint-origin-*: 予約名の誤用。warnings に出す。
// - 接頭辞の無いもの: kint-origin-local-<名前> への改名を促す。warnings に出す。
// update は配布物のパスだけを書くので、どれも上書きも削除もされない。利用者に、そのことを見せる。
function inspectUserSkills(targetRoot: string): { preserved: string[]; warnings: string[] } {
  const distributed = new Set(distributedSkillNames());
  const preserved: string[] = [];
  const warnings: string[] = [];
  for (const skillRoot of INSPECT_SKILL_ROOTS) {
    const root = path.resolve(targetRoot, skillRoot);
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (name.startsWith(".")) continue;
      const rel = `${skillRoot}/${name}`;
      if (name.startsWith(ADDON_SKILL_PREFIX)) continue; // `kint-origin addon` が管理するリンク
      if (name.startsWith(LOCAL_SKILL_PREFIX)) {
        preserved.push(rel);
        continue;
      }
      if (name.startsWith("kint-origin-")) {
        if (!distributed.has(name)) {
          warnings.push(
            `${rel}: kint-origin-* は配布スキル用に予約された名前です（このフォルダは配布物に無いため、上書きも削除もしません）。` +
              "独自のスキルは kint-origin-local-<名前> にしてください。"
          );
        }
        continue;
      }
      warnings.push(
        `${rel}: 名前が kint-origin-local- で始まらない独自スキルです。kint-origin-local-${name} のように改名してください` +
          "（フォルダ名と SKILL.md の name。手順は kint-origin-extend スキル）。上書きも削除もしません。"
      );
    }
  }
  return { preserved: preserved.sort(), warnings: warnings.sort() };
}

function logPlan(planned: Array<{ path: string; status: PlannedWrite["status"] | "append" }>, preserved: string[], warnings: string[]): void {
  const changed = planned.filter((item) => item.status === "changed");
  const created = planned.filter((item) => item.status === "new");
  const appended = planned.filter((item) => item.status === "append");
  const same = planned.filter((item) => item.status === "same").length;
  const appendSummary = appended.length > 0 ? ` / 追記 ${appended.length} 件` : "";
  log(`update: 上書きされるファイル ${changed.length} 件 / 新規 ${created.length} 件${appendSummary} / 変更なし ${same} 件`);
  for (const item of changed) log(`  上書き: ${item.path}`);
  for (const item of created) log(`  新規:   ${item.path}`);
  for (const item of appended) log(`  追記:   ${item.path}`);
  if (changed.length > 0) {
    log("  上書きされるファイルに独自の編集があると失われます（CLAUDE.md・AGENTS.md・.claude/settings.json など）。必要なら先に別の場所へ控えてください。");
    log("  独自のスキルは kint-origin-local-<名前> に置くと残ります。個人の設定は .claude/settings.local.json に書いてください。");
  }
  if (preserved.length > 0) log(`  そのまま残す独自スキル（kint-origin-local-*）: ${preserved.join(", ")}`);
  for (const warning of warnings) log(`  警告: ${warning}`);
}

// 更新対象はツール管理ファイルに限る。
export async function updateProject({
  targetRoot = process.cwd(),
  yes = false
}: { targetRoot?: string; yes?: boolean } = {}): Promise<UpdateResult> {
  assertNotToolRepository(targetRoot, "update");

  // 非対話（パイプ・CI・AI のツール実行）で確認できないときは、何も書かずに案内して止める。
  if (!yes && !process.stdin.isTTY) {
    throw new Error(
      "対話確認ができない実行環境のため中断しました。上書きされるファイルを確認したうえで、承認済みであれば -y を付けて再実行してください（kint-origin update -y）。"
    );
  }

  const planned = [...planAgents({ targetRoot }), ...plannedTemplateFiles(targetRoot)];
  const plugins = planPluginTemplate(targetRoot);
  const addonSync = prepareAddonSync(targetRoot);
  const { preserved, warnings } = inspectUserSkills(targetRoot);
  const willWrite = planned.filter((item) => item.status !== "same");
  logPlan([...planned, ...plugins.changes], preserved, warnings);
  if (addonSync.changed) log(`  外部addonのリンクを同期: ${addonSync.addons.join(", ")}`);

  const base = { unchanged: planned.length - willWrite.length, preserved, warnings, addons: [] as string[] };
  if (willWrite.length === 0 && plugins.changes.length === 0 && !addonSync.changed) {
    log("update: すべて最新です。書き込むファイルはありません。");
    return { updated: [], ...base };
  }

  if (!yes) {
    const ok = await confirmYes("上書きして更新しますか？ [y/N]");
    if (!ok) {
      log("中断しました。何も書き込んでいません。");
      return { updated: [], ...base, aborted: true };
    }
  }

  // 確認した計画の内容をそのまま書く（表示した内容と書く内容を一致させる）。
  recordLocalAction("update-project", targetRoot);
  const pluginFiles = plugins.apply();
  const addons = addonSync.apply();
  return { updated: [...applyPlannedWrites(targetRoot, planned), ...pluginFiles], ...base, addons };
}
