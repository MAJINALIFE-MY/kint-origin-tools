// スペース本文 HTML の決定論的インデント整形と比較用の正規化（原文の完全復元ではない）

interface HtmlToken {
  type: "start" | "end" | "void" | "text" | "comment";
  tag?: string;
  raw: string;
}

interface HtmlNode {
  type: "root" | "element" | "void" | "text" | "comment";
  tag?: string;
  raw?: string;
  children: HtmlNode[];
}

const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "dd", "div", "dl", "dt",
  "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li",
  "main", "nav", "ol", "p", "pre", "section", "table", "tbody", "td",
  "tfoot", "th", "thead", "tr", "ul"
]);

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr"
]);

const PRESERVE_TAGS = new Set(["pre", "code", "textarea", "script", "style"]);

function tokenizeHtml(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  let i = 0;
  const n = html.length;

  while (i < n) {
    if (html[i] === "<") {
      // コメント
      if (html.startsWith("<!--", i)) {
        const end = html.indexOf("-->", i + 4);
        if (end === -1) {
          tokens.push({ type: "comment", raw: html.slice(i) });
          break;
        } else {
          tokens.push({ type: "comment", raw: html.slice(i, end + 3) });
          i = end + 3;
          continue;
        }
      }

      // タグ
      let j = i + 1;
      let inQuote: '"' | "'" | null = null;
      while (j < n) {
        const c = html[j];
        if (inQuote) {
          if (c === inQuote) inQuote = null;
        } else {
          if (c === '"' || c === "'") {
            inQuote = c;
          } else if (c === ">") {
            break;
          }
        }
        j++;
      }

      if (j >= n) {
        tokens.push({ type: "text", raw: html.slice(i) });
        break;
      }

      const rawTag = html.slice(i, j + 1);
      i = j + 1;

      if (rawTag.startsWith("</")) {
        const match = /<\/([a-zA-Z0-9\-]+)/.exec(rawTag);
        tokens.push({ type: "end", tag: match ? match[1].toLowerCase() : "", raw: rawTag });
      } else {
        const match = /<([a-zA-Z0-9\-]+)/.exec(rawTag);
        const tag = match ? match[1].toLowerCase() : "";
        const isSelfClosing = rawTag.endsWith("/>") || VOID_TAGS.has(tag);
        tokens.push({
          type: isSelfClosing ? "void" : "start",
          tag,
          raw: rawTag
        });
      }
    } else {
      const nextOpen = html.indexOf("<", i);
      if (nextOpen === -1) {
        tokens.push({ type: "text", raw: html.slice(i) });
        break;
      } else {
        tokens.push({ type: "text", raw: html.slice(i, nextOpen) });
        i = nextOpen;
      }
    }
  }

  return tokens;
}

function parseHtml(tokens: HtmlToken[]): HtmlNode {
  const root: HtmlNode = { type: "root", children: [] };
  const stack: HtmlNode[] = [root];

  for (const token of tokens) {
    const parent = stack[stack.length - 1];
    if (token.type === "start") {
      const el: HtmlNode = {
        type: "element",
        tag: token.tag,
        raw: token.raw,
        children: []
      };
      parent.children.push(el);
      stack.push(el);
    } else if (token.type === "end") {
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].tag === token.tag) {
          while (stack.length > s) {
            stack.pop();
          }
          break;
        }
      }
    } else if (token.type === "void") {
      parent.children.push({
        type: "void",
        tag: token.tag,
        raw: token.raw,
        children: []
      });
    } else {
      parent.children.push({
        type: token.type,
        raw: token.raw,
        children: []
      });
    }
  }

  return root;
}

function renderFormatted(node: HtmlNode, indentLevel: number, parentIsMultiLine: boolean): string {
  const indent = "  ".repeat(indentLevel);
  const isBlock = node.tag ? BLOCK_TAGS.has(node.tag) : false;

  if (node.type === "root") {
    const parts: string[] = [];
    for (const child of node.children) {
      if (child.type === "text" && child.raw?.trim() === "") continue;
      const res = renderFormatted(child, 0, true);
      if (res) parts.push(res);
    }
    return parts.join("\n");
  }

  if (node.type === "text") {
    return (parentIsMultiLine ? indent : "") + (node.raw || "");
  }
  if (node.type === "comment" || node.type === "void") {
    return (parentIsMultiLine || isBlock ? indent : "") + (node.raw || "");
  }

  // pre 等の空白保持タグ
  if (PRESERVE_TAGS.has(node.tag || "")) {
    const inner = node.children.map(renderCollapsed).join("");
    return `${parentIsMultiLine || isBlock ? indent : ""}${node.raw}${inner}</${node.tag}>`;
  }

  // インライン要素（改行・インデントを内部に挟まない）
  if (!isBlock) {
    const inner = node.children.map((c) => renderFormatted(c, indentLevel, false)).join("");
    return `${parentIsMultiLine ? indent : ""}${node.raw}${inner}</${node.tag}>`;
  }

  // ブロック要素
  const hasBlockChildren = node.children.some(
    (c) => (c.type === "element" || c.type === "void") && BLOCK_TAGS.has(c.tag || "")
  );

  if (!hasBlockChildren) {
    // リーフブロック（インライン/テキストのみ）: 1行で出力
    const inner = node.children.map((c) => renderFormatted(c, indentLevel, false)).join("");
    return `${indent}${node.raw}${inner.trim()}</${node.tag}>`;
  }

  // ブロック子要素を持つブロック要素: 各子要素をインデントして改行
  const childLines: string[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.raw?.trim() === "") continue;
    const formattedChild = renderFormatted(child, indentLevel + 1, true);
    if (formattedChild) childLines.push(formattedChild);
  }
  return `${indent}${node.raw}\n${childLines.join("\n")}\n${indent}</${node.tag}>`;
}

function renderCollapsed(node: HtmlNode): string {
  if (node.type === "root") {
    return node.children.map(renderCollapsed).join("");
  }
  if (node.type === "text") {
    return node.raw || "";
  }
  if (node.type === "comment" || node.type === "void") {
    return node.raw || "";
  }
  const inner = node.children.map(renderCollapsed).join("");
  return `${node.raw}${inner}</${node.tag}>`;
}

/**
 * 1行または未整形のスペース本文 HTML を、ブロック要素の階層に応じて 2 スペースインデントで整形します。
 * 空文字列の場合は空文字列、非空の場合は末尾に LF を 1 つ付与します。
 */
export function formatSpaceHtml(html: string): string {
  const text = (html || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!text.trim()) return "";
  const tokens = tokenizeHtml(text);
  const root = parseHtml(tokens);
  const formatted = renderFormatted(root, 0, false);
  return formatted ? `${formatted}\n` : "";
}

/**
 * インデント整形されたスペース本文 HTML から、ブロック要素境界の改行とインデント空白を除去して 1 行に復元します。
 * 空白や終了タグの表記を正規化するため、原文のバイト列は保持しません。
 */
export function collapseSpaceHtml(html: string): string {
  const text = (html || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!text.trim()) return "";
  const tokens = tokenizeHtml(text);
  const root = parseHtml(tokens);

  function cleanInterBlockSpaces(n: HtmlNode): void {
    const hasBlock = n.children.some(
      (c) => (c.type === "element" || c.type === "void") && BLOCK_TAGS.has(c.tag || "")
    );
    if (hasBlock || n.type === "root") {
      n.children = n.children.filter((c) => {
        if (c.type === "text" && c.raw && /^\s*$/.test(c.raw)) {
          return false;
        }
        return true;
      });
    }
    for (const c of n.children) {
      cleanInterBlockSpaces(c);
    }
  }

  cleanInterBlockSpaces(root);
  return renderCollapsed(root).trim();
}
