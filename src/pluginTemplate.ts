import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runGit } from "./git.js";
import { log } from "./log.js";
import { LOCAL_PLUGIN_SOURCES, PLUGIN_SOURCES, PLUGINS_DIR } from "./pluginSources.js";
import { recordLocalAction } from "./runLog.js";

const TEMPLATE_ROOT = fileURLToPath(new URL("../template/plugins/", import.meta.url));
const PLUGIN_IGNORE = `${PLUGINS_DIR}/.gitignore`;

type PluginTemplateChange = {
  path: string;
  content: string;
} & ({ status: "new" } | { status: "append"; before: Buffer });

export function planPluginTemplate(targetRoot: string) {
  const pluginRoot = path.join(targetRoot, PLUGINS_DIR);
  const changes: PluginTemplateChange[] = [];
  const skipped: string[] = [];
  const rootStat = fs.lstatSync(pluginRoot, { throwIfNoEntry: false });

  if (rootStat && !rootStat.isDirectory()) {
    log(`警告: ${PLUGINS_DIR}/ が通常のディレクトリではないため、プラグイン台帳の雛形とGit除外を設定しません。`);
    skipped.push(PLUGIN_SOURCES, PLUGIN_IGNORE);
  } else {
    if (fs.lstatSync(path.join(targetRoot, PLUGIN_SOURCES), { throwIfNoEntry: false })) {
      skipped.push(PLUGIN_SOURCES);
    } else {
      changes.push({
        path: PLUGIN_SOURCES,
        status: "new",
        content: fs.readFileSync(path.join(TEMPLATE_ROOT, "sources.json"), "utf8")
      });
    }

    const ignorePath = path.join(targetRoot, PLUGIN_IGNORE);
    const ignoreStat = fs.lstatSync(ignorePath, { throwIfNoEntry: false });
    const ignoreRule = fs.readFileSync(path.join(TEMPLATE_ROOT, "gitignore"), "utf8");
    if (!ignoreStat) {
      changes.push({ path: PLUGIN_IGNORE, status: "new", content: ignoreRule });
    } else if (!ignoreStat.isFile()) {
      log(`警告: ${PLUGIN_IGNORE} が通常ファイルではないため、個人用台帳のGit除外は設定できません。`);
      skipped.push(PLUGIN_IGNORE);
    } else {
      const before = fs.readFileSync(ignorePath);
      const rules = before.toString("utf8").split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line && !line.startsWith("#"));
      const lastRule = rules.at(-1);
      if (lastRule === ignoreRule.trimEnd()) {
        skipped.push(PLUGIN_IGNORE);
      } else {
        const prefix = before.length && before.at(-1) !== 10 ? "\n" : "";
        changes.push({ path: PLUGIN_IGNORE, status: "append", content: prefix + ignoreRule, before });
      }
    }
  }

  if (runGit(targetRoot, ["ls-files", "--error-unmatch", "--", LOCAL_PLUGIN_SOURCES]).status === 0) {
    log(`警告: ${LOCAL_PLUGIN_SOURCES} は既にGitで追跡されています。除外を有効にするにはGitの追跡から外してください。`);
  }

  function apply(): string[] {
    if (changes.length === 0) return [];
    const stat = fs.lstatSync(pluginRoot, { throwIfNoEntry: false });
    recordLocalAction("apply-plugin-template", pluginRoot);
    if (!stat) fs.mkdirSync(pluginRoot, { recursive: true });
    if (!fs.lstatSync(pluginRoot).isDirectory()) throw new Error(`${PLUGINS_DIR}/ が計画後に変更されました。もう一度実行してください。`);

    const written: string[] = [];
    for (const change of changes) {
      const target = path.join(targetRoot, change.path);
      if (change.status === "new") {
        // 確認後に利用者が先に作ったファイルも保持する。
        recordLocalAction("write-plugin-template", target, { bytes: Buffer.byteLength(change.content, "utf8") });
        fs.writeFileSync(target, change.content, { encoding: "utf8", flag: "wx" });
      } else {
        const current = fs.lstatSync(target, { throwIfNoEntry: false });
        if (!current?.isFile() || !fs.readFileSync(target).equals(change.before)) {
          throw new Error(`${change.path} が計画後に変更されました。もう一度実行してください。`);
        }
        recordLocalAction("append-plugin-template", target, { bytes: Buffer.byteLength(change.content, "utf8") });
        fs.appendFileSync(target, change.content, "utf8");
      }
      written.push(change.path);
    }
    return written;
  }

  return { changes, skipped, apply };
}
