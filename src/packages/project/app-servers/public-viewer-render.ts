/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

import type { AppStaticPublicViewerIntegrationSpec } from "./public-viewer";

export interface PublicViewerRenderedFile {
  html: string;
  contentType: string;
}

interface PublicViewerBundleAssets {
  scripts: string[];
  styles: string[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function resolveStaticAssetRoots(): string[] {
  const candidates = [
    process.env.COCALC_STATIC_PATH,
    process.env.COCALC_BUNDLE_DIR
      ? path.join(process.env.COCALC_BUNDLE_DIR, "static")
      : undefined,
    path.resolve(__dirname, "../../../../static/dist"),
    path.resolve(process.cwd(), "packages/static/dist"),
    path.resolve(process.cwd(), "src/packages/static/dist"),
  ].filter((value): value is string => typeof value === "string" && !!value);
  return [...new Set(candidates)];
}

function normalizeAssetHref(href: string): string {
  if (/^(https?:)?\/\//.test(href) || href.startsWith("/")) {
    return href;
  }
  return `/static/${href.replace(/^\.?\//, "")}`;
}

function parseBundleAssets(html: string): PublicViewerBundleAssets {
  const scripts = Array.from(
    html.matchAll(/<script[^>]+src="([^"]+)"[^>]*><\/script>/g),
    (match) => normalizeAssetHref(match[1]),
  );
  const styles = Array.from(
    html.matchAll(/<link[^>]+href="([^"]+)"[^>]*rel="stylesheet"[^>]*>/g),
    (match) => normalizeAssetHref(match[1]),
  );
  return { scripts, styles };
}

function resolvePublicViewerBundleAssets():
  | PublicViewerBundleAssets
  | undefined {
  for (const root of resolveStaticAssetRoots()) {
    const htmlPath = path.join(root, "public-viewer.html");
    if (!existsSync(htmlPath)) continue;
    return parseBundleAssets(readFileSync(htmlPath, "utf8"));
  }
}

function renderInlineMarkdown(line: string): string {
  let out = escapeHtml(line);
  out = out.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, text, href) =>
      `<a href="${escapeAttribute(href)}" rel="noreferrer noopener">${text}</a>`,
  );
  return out;
}

function renderMarkdown(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let inCode = false;
  let codeFence = "";
  let listType: "ul" | "ol" | "" = "";

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${paragraph.map(renderInlineMarkdown).join(" ")}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!listType) return;
    out.push(`</${listType}>`);
    listType = "";
  };

  const openList = (next: "ul" | "ol") => {
    if (listType === next) return;
    flushParagraph();
    flushList();
    listType = next;
    out.push(`<${next}>`);
  };

  for (const rawLine of lines) {
    const line = rawLine ?? "";
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flushParagraph();
      flushList();
      if (!inCode) {
        inCode = true;
        codeFence = trimmed.slice(3).trim();
        out.push(
          `<pre class="markdown-code"><code data-lang="${escapeAttribute(codeFence)}">`,
        );
      } else {
        inCode = false;
        codeFence = "";
        out.push("</code></pre>");
      }
      continue;
    }

    if (inCode) {
      out.push(`${escapeHtml(line)}\n`);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      out.push(
        `<h${level}>${renderInlineMarkdown(heading[2].trim())}</h${level}>`,
      );
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      openList("ul");
      out.push(`<li>${renderInlineMarkdown(bullet[1])}</li>`);
      continue;
    }

    const ordered = trimmed.match(/^\d+\.\s+(.*)$/);
    if (ordered) {
      openList("ol");
      out.push(`<li>${renderInlineMarkdown(ordered[1])}</li>`);
      continue;
    }

    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      out.push(`<blockquote>${renderInlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();
  if (inCode) {
    out.push("</code></pre>");
  }
  return out.join("\n");
}

function toText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((part) => `${part ?? ""}`).join("");
  }
  return `${value ?? ""}`;
}

function renderNotebookOutput(output: any): string {
  if (!output || typeof output !== "object") {
    return "";
  }
  if (output.output_type === "stream") {
    return `<pre>${escapeHtml(toText(output.text))}</pre>`;
  }
  if (output.output_type === "error") {
    return `<pre>${escapeHtml(toText(output.traceback ?? output.evalue ?? "Notebook error"))}</pre>`;
  }
  const data = output.data ?? {};
  if (typeof data["text/markdown"] === "string") {
    return `<div class="notebook-markdown-output">${renderMarkdown(
      data["text/markdown"],
    )}</div>`;
  }
  if (
    typeof data["text/plain"] === "string" ||
    Array.isArray(data["text/plain"])
  ) {
    return `<pre>${escapeHtml(toText(data["text/plain"]))}</pre>`;
  }
  if (typeof data["application/json"] === "object") {
    return `<pre>${escapeHtml(
      JSON.stringify(data["application/json"], null, 2),
    )}</pre>`;
  }
  return `<pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
}

function renderNotebook(content: string): string {
  let notebook: any;
  try {
    notebook = JSON.parse(content);
  } catch (err) {
    return `<div class="viewer-warning">Invalid notebook JSON: ${escapeHtml(`${err}`)}</div><pre>${escapeHtml(content)}</pre>`;
  }
  const cells = Array.isArray(notebook?.cells) ? notebook.cells : [];
  return cells
    .map((cell: any, idx: number) => {
      const source = toText(cell?.source);
      const executionCount =
        typeof cell?.execution_count === "number"
          ? `In [${cell.execution_count}]`
          : cell?.cell_type === "code"
            ? "In [ ]"
            : "Markdown";
      if (cell?.cell_type === "markdown") {
        return `<section class="notebook-cell markdown-cell">
  <div class="notebook-cell-meta">${escapeHtml(`Cell ${idx + 1} · Markdown`)}</div>
  <div class="notebook-markdown">${renderMarkdown(source)}</div>
</section>`;
      }
      const outputs = Array.isArray(cell?.outputs)
        ? cell.outputs.map(renderNotebookOutput).join("")
        : "";
      return `<section class="notebook-cell code-cell">
  <div class="notebook-cell-meta">${escapeHtml(`${executionCount} · Cell ${idx + 1}`)}</div>
  <pre class="notebook-code"><code>${escapeHtml(source)}</code></pre>
  ${
    outputs
      ? `<div class="notebook-outputs"><div class="notebook-output-label">Output</div>${outputs}</div>`
      : ""
  }
</section>`;
    })
    .join("\n");
}

function renderStructuredFallback(content: string, kind: string): string {
  return `<div class="viewer-warning">
  A dedicated ${escapeHtml(kind)} renderer is not wired into the project-host bundle yet. This read-only viewer keeps the file directly accessible and shows the saved source below.
</div>
<pre>${escapeHtml(content)}</pre>`;
}

function buildHtmlDocument({
  title,
  body,
  sourcePath,
  rawHref,
  autoRefreshS,
}: {
  title: string;
  body: string;
  sourcePath: string;
  rawHref: string;
  autoRefreshS?: number;
}): string {
  const refresh =
    autoRefreshS && autoRefreshS > 0
      ? `<meta http-equiv="refresh" content="${Math.floor(autoRefreshS)}" />`
      : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  ${refresh}
  <style>
    :root {
      --viewer-text: #132237;
      --viewer-muted: #5d6e84;
      --viewer-border: #d7ddea;
      --viewer-surface: #f6f8fb;
      --viewer-card: #ffffff;
      --viewer-accent: #1f5aa6;
      --viewer-code: #0f1726;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      color: var(--viewer-text);
      background:
        radial-gradient(circle at top, rgba(31,90,166,0.08), transparent 30%),
        linear-gradient(180deg, #fbfcfe 0%, #eef3f9 100%);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    a { color: var(--viewer-accent); }
    code {
      background: var(--viewer-surface);
      border-radius: 8px;
      padding: 0.15rem 0.35rem;
    }
    pre {
      overflow-x: auto;
      background: #0f1726;
      color: #eef4ff;
      border-radius: 18px;
      padding: 16px 18px;
      line-height: 1.45;
    }
    .public-viewer-shell {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px 20px 64px;
    }
    .public-viewer-header {
      margin-bottom: 20px;
      padding: 16px 18px;
      border: 1px solid var(--viewer-border);
      border-radius: 18px;
      background: rgba(255,255,255,0.92);
      box-shadow: 0 14px 40px rgba(19,34,55,0.06);
      display: flex;
      gap: 12px;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
    }
    .public-viewer-title {
      margin: 0;
      font-size: clamp(1.4rem, 2vw, 2rem);
      line-height: 1.05;
    }
    .public-viewer-source {
      margin-top: 6px;
      color: var(--viewer-muted);
      font-size: 0.95rem;
    }
    .public-viewer-source code {
      color: var(--viewer-accent);
      border-radius: 999px;
      padding: 4px 9px;
    }
    .public-viewer-actions {
      display: inline-flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
    }
    .public-viewer-button {
      text-decoration: none;
      color: white;
      background: var(--viewer-accent);
      padding: 10px 14px;
      border-radius: 999px;
      font-weight: 700;
      white-space: nowrap;
    }
    .public-viewer-main {
      padding: 18px 20px 32px;
      border: 1px solid var(--viewer-border);
      border-radius: 22px;
      background: var(--viewer-card);
      box-shadow: 0 18px 44px rgba(19,34,55,0.08);
      overflow-x: auto;
      line-height: 1.6;
    }
    .viewer-warning {
      margin-bottom: 16px;
      padding: 14px 16px;
      border-radius: 16px;
      border: 1px solid #d9e4f5;
      background: #f7fbff;
      color: #325174;
    }
    .notebook-cell {
      margin-bottom: 18px;
      border: 1px solid var(--viewer-border);
      border-radius: 18px;
      padding: 14px 16px;
      background: #fcfdff;
    }
    .notebook-cell-meta,
    .notebook-output-label {
      color: var(--viewer-muted);
      font-size: 0.92rem;
      font-weight: 700;
      margin-bottom: 10px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .notebook-outputs {
      margin-top: 14px;
      padding-top: 12px;
      border-top: 1px solid var(--viewer-border);
    }
    .markdown-code {
      margin: 14px 0;
    }
    blockquote {
      margin: 14px 0;
      padding: 6px 0 6px 16px;
      border-left: 4px solid #c5d6ee;
      color: var(--viewer-muted);
    }
    ul, ol {
      padding-left: 1.4rem;
    }
    h1, h2, h3, h4, h5, h6 {
      line-height: 1.15;
      margin-top: 1.2em;
      margin-bottom: 0.5em;
    }
    p {
      margin: 0.7em 0;
    }
  </style>
</head>
<body>
  <div class="public-viewer-shell">
    <header class="public-viewer-header">
      <div>
        <h1 class="public-viewer-title">${escapeHtml(title)}</h1>
        <div class="public-viewer-source">Source: <code>${escapeHtml(sourcePath)}</code></div>
      </div>
      <div class="public-viewer-actions">
        <a class="public-viewer-button" href="${escapeAttribute(rawHref)}">Open raw file</a>
      </div>
    </header>
    <main class="public-viewer-main">
      ${body}
    </main>
  </div>
</body>
</html>`;
}

function buildBundleShellDocument({
  title,
  sourcePath,
  rawHref,
  assets,
  autoRefreshS,
}: {
  title: string;
  sourcePath: string;
  rawHref: string;
  assets: PublicViewerBundleAssets;
  autoRefreshS?: number;
}): string {
  const refresh =
    autoRefreshS && autoRefreshS > 0
      ? `<meta http-equiv="refresh" content="${Math.floor(autoRefreshS)}" />`
      : "";
  const config = escapeHtml(
    JSON.stringify({
      path: sourcePath,
      rawUrl: rawHref,
      title,
    }),
  );
  const styleTags = assets.styles
    .map((href) => `<link rel="stylesheet" href="${escapeAttribute(href)}" />`)
    .join("\n");
  const scriptTags = assets.scripts
    .map(
      (src) =>
        `<script defer src="${escapeAttribute(src)}" crossorigin="anonymous"></script>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  ${refresh}
  ${styleTags}
</head>
<body>
  <div id="cocalc-crash-container"></div>
  <div id="cocalc-load-container"></div>
  <div id="cocalc-scripts-container"></div>
  <div id="cocalc-webapp-container"></div>
  <script type="application/json" id="cocalc-public-viewer-config">${config}</script>
  ${scriptTags}
</body>
</html>`;
}

export function renderPublicViewerFile({
  relativePath,
  content,
  rawHref,
  integration,
}: {
  relativePath: string;
  content: string;
  rawHref: string;
  integration: AppStaticPublicViewerIntegrationSpec;
}): PublicViewerRenderedFile | undefined {
  const ext = path.posix.extname(relativePath).toLowerCase();
  const title = path.posix.basename(relativePath) || "CoCalc Public Viewer";
  const assets = resolvePublicViewerBundleAssets();
  if (assets?.scripts.length) {
    return {
      contentType: "text/html; charset=utf-8",
      html: buildBundleShellDocument({
        title,
        sourcePath: relativePath,
        rawHref,
        assets,
        autoRefreshS: integration.auto_refresh_s,
      }),
    };
  }

  let body: string;

  switch (ext) {
    case ".md":
      body = renderMarkdown(content);
      break;
    case ".ipynb":
      body = renderNotebook(content);
      break;
    case ".slides":
      body = renderStructuredFallback(content, "slides");
      break;
    case ".board":
      body = renderStructuredFallback(content, "whiteboard");
      break;
    default:
      return undefined;
  }

  return {
    contentType: "text/html; charset=utf-8",
    html: buildHtmlDocument({
      title,
      body,
      sourcePath: relativePath,
      rawHref,
      autoRefreshS: integration.auto_refresh_s,
    }),
  };
}
