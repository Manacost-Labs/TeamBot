export const MAX_DOM_NODES = 10_000;
export const MAX_DOM_DEPTH = 64;

export class ContentLimitError extends Error {
  constructor() {
    super("document structure exceeds the renderer limits");
    this.name = "ContentLimitError";
  }
}

class DomBudget {
  constructor(maxNodes, maxDepth) {
    this.maxNodes = maxNodes;
    this.maxDepth = maxDepth;
    // html, head, charset meta, CSP meta, title, style, body, main and title h1.
    this.nodes = 9;
  }

  add(count, depth) {
    this.nodes += count;
    if (this.nodes > this.maxNodes || depth > this.maxDepth) {
      throw new ContentLimitError();
    }
  }
}

const escapeHtml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

function safeLink(raw) {
  try {
    const url = new URL(raw);
    return ["http:", "https:", "mailto:"].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function renderInline(value, budget, depth) {
  const token = /(`[^`\n]*`)|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let html = "";
  let cursor = 0;
  for (const match of value.matchAll(token)) {
    html += escapeHtml(value.slice(cursor, match.index));
    if (match[1]) {
      budget.add(1, depth + 1);
      html += `<code>${escapeHtml(match[1].slice(1, -1))}</code>`;
    } else {
      const href = safeLink(match[3]);
      if (href) {
        budget.add(1, depth + 1);
        html += `<a href="${escapeHtml(href)}">${escapeHtml(match[2])}</a>`;
      } else {
        html += escapeHtml(match[0]);
      }
    }
    cursor = match.index + match[0].length;
  }
  return html + escapeHtml(value.slice(cursor));
}

const heading = (line) => /^(#{1,6})[ \t]+(.+)$/.exec(line);
const unorderedItem = (line) => /^[ \t]{0,3}[-+*][ \t]+(.+)$/.exec(line);
const orderedItem = (line) => /^[ \t]{0,3}\d+[.)][ \t]+(.+)$/.exec(line);
const fence = (line) => /^[ \t]*```([A-Za-z0-9_-]{0,32})[ \t]*$/.exec(line);

function splitTableRow(line) {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split("|").map((cell) => cell.trim());
}

function tableAlignment(line) {
  if (!line.includes("|")) return null;
  const cells = splitTableRow(line);
  if (cells.length < 2 || cells.some((cell) => !/^:?-{3,}:?$/.test(cell))) {
    return null;
  }
  return cells.map((cell) => {
    if (cell.startsWith(":") && cell.endsWith(":")) return "center";
    if (cell.endsWith(":")) return "right";
    return "left";
  });
}

function startsBlock(lines, index) {
  const line = lines[index] ?? "";
  return (
    line.trim() === "" ||
    Boolean(heading(line)) ||
    Boolean(unorderedItem(line)) ||
    Boolean(orderedItem(line)) ||
    Boolean(fence(line)) ||
    (line.includes("|") && tableAlignment(lines[index + 1] ?? "") !== null)
  );
}

function renderBlocks(markdown, budget) {
  const lines = markdown
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const openingFence = fence(line);
    if (openingFence) {
      index += 1;
      const code = [];
      while (index < lines.length && !/^[ \t]*```[ \t]*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      budget.add(2, 5);
      const language = openingFence[1]
        ? ` class="language-${openingFence[1]}"`
        : "";
      blocks.push(
        `<pre><code${language}>${escapeHtml(code.join("\n"))}</code></pre>`,
      );
      continue;
    }

    const currentHeading = heading(line);
    if (currentHeading) {
      const level = currentHeading[1].length;
      budget.add(1, 4);
      blocks.push(
        `<h${level}>${renderInline(currentHeading[2], budget, 4)}</h${level}>`,
      );
      index += 1;
      continue;
    }

    const alignment = tableAlignment(lines[index + 1] ?? "");
    if (line.includes("|") && alignment) {
      const headers = splitTableRow(line);
      index += 2;
      const rows = [];
      while (
        index < lines.length &&
        lines[index].trim() !== "" &&
        lines[index].includes("|")
      ) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      budget.add(4 + headers.length + rows.length, 6);
      budget.add(rows.length * headers.length, 7);
      const headerHtml = headers
        .map(
          (cell, cellIndex) =>
            `<th class="align-${alignment[cellIndex] ?? "left"}">${renderInline(cell, budget, 7)}</th>`,
        )
        .join("");
      const bodyHtml = rows
        .map(
          (row) =>
            `<tr>${headers.map((_, cellIndex) => `<td class="align-${alignment[cellIndex] ?? "left"}">${renderInline(row[cellIndex] ?? "", budget, 7)}</td>`).join("")}</tr>`,
        )
        .join("");
      blocks.push(
        `<table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`,
      );
      continue;
    }

    const firstUnordered = unorderedItem(line);
    const firstOrdered = orderedItem(line);
    if (firstUnordered || firstOrdered) {
      const ordered = Boolean(firstOrdered);
      const items = [];
      while (index < lines.length) {
        const item = ordered
          ? orderedItem(lines[index])
          : unorderedItem(lines[index]);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      budget.add(1 + items.length, 5);
      const tag = ordered ? "ol" : "ul";
      blocks.push(
        `<${tag}>${items.map((item) => `<li>${renderInline(item, budget, 5)}</li>`).join("")}</${tag}>`,
      );
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && !startsBlock(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    budget.add(1, 4);
    blocks.push(`<p>${renderInline(paragraph.join(" "), budget, 4)}</p>`);
  }
  return blocks.join("\n");
}

const CSS = `
@page { size: A4; margin: 18mm 16mm 20mm; }
* { box-sizing: border-box; }
html { color: #172033; background: #fff; font-family: "DejaVu Sans", "Noto Sans", "Liberation Sans", Arial, sans-serif; font-size: 11pt; line-height: 1.5; }
body { margin: 0; }
main { width: 100%; }
.document-title { margin: 0 0 1.2em; font-size: 24pt; line-height: 1.2; overflow-wrap: anywhere; }
h1, h2, h3, h4, h5, h6 { color: #101827; page-break-after: avoid; break-after: avoid-page; overflow-wrap: anywhere; }
h1 { font-size: 21pt; } h2 { font-size: 17pt; } h3 { font-size: 14pt; }
p, li, td, th { overflow-wrap: anywhere; }
a { color: #174ea6; text-decoration: underline; }
pre, table, blockquote { break-inside: avoid; }
pre { padding: 10pt; border: 1px solid #d6dce7; border-radius: 4pt; background: #f6f8fb; white-space: pre-wrap; overflow-wrap: anywhere; }
code { font-family: "DejaVu Sans Mono", "Liberation Mono", monospace; font-size: 9.5pt; }
ul, ol { padding-left: 1.6em; }
table { width: 100%; border-collapse: collapse; margin: 1em 0; table-layout: fixed; }
th, td { border: 1px solid #cbd3df; padding: 6pt; vertical-align: top; }
th { background: #eef2f7; font-weight: 700; }
.align-left { text-align: left; } .align-center { text-align: center; } .align-right { text-align: right; }
`;

export function renderMarkdownToHtml({ title, markdown }, options = {}) {
  const budget = new DomBudget(
    options.maxNodes ?? MAX_DOM_NODES,
    options.maxDepth ?? MAX_DOM_DEPTH,
  );
  const body = renderBlocks(markdown, budget);
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; connect-src 'none'; font-src 'none'; form-action 'none'; frame-src 'none'; img-src 'none'; media-src 'none'; object-src 'none'; script-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body><main><h1 class="document-title">${escapeHtml(title)}</h1>${body}</main></body>
</html>`;
}
