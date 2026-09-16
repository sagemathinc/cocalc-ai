/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token";

import {
  docsPath,
  getDocsEntry,
  listDocsEntries,
  type DocsAccess,
  type DocsEntry,
} from "@cocalc/docs";
import {
  getPublicMarketingSiteName,
  type PublicMetadataRoute,
  type PublicRouteMetadataConfig,
} from "@cocalc/util/public-site-metadata";
import { isCanonicalPublicSiteHost } from "@cocalc/util/public-site-policy";
import { joinUrlPath } from "@cocalc/util/url-path";

const ARTICLE_STYLE = [
  "box-sizing:border-box",
  "font-family:ui-sans-serif,sans-serif",
  "line-height:1.6",
  "margin:0 auto",
  "max-width:1100px",
  "padding:48px 24px",
  "overflow-wrap:anywhere",
].join(";");

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// This HTML shares the public shell's cache policy. Never add account access
// or private docs state here. Keep feature-gated entries excluded until the
// actual deployment configuration is available to the client. The product
// filter also keeps this body within the client's Plus documentation subset.
function anonymousAccess(config: PublicRouteMetadataConfig): DocsAccess {
  return {
    product: config.cocalc_product === "plus" ? "plus" : undefined,
    siteProfile: isCanonicalPublicSiteHost(config.dns)
      ? "cocalc-ai"
      : undefined,
  };
}

function publicHref(
  href: string,
  basePath: string,
  currentPath: string,
): string {
  // A legacy static shell can have <base href="/static/">. An explicit
  // document path keeps fragment navigation on the current article there.
  if (href.startsWith("#")) return `${currentPath}${href}`;
  if (!href.startsWith("/") || href.startsWith("//")) return href;
  // Markdown destinations are authored relative to the site root. A path
  // can start with the same segment as the deployment prefix without already
  // being resolved for that deployment (for example /docs under /docs).
  return `${basePath.replace(/\/+$/, "")}${href}`;
}

function inlineText(tokens: Token[]): string {
  return tokens
    .map((token) =>
      token.children != null
        ? inlineText(token.children)
        : token.type === "text" || token.type === "code_inline"
          ? token.content
          : "",
    )
    .join("");
}

// Match the heading IDs in frontend/editors/slate/elements/heading so a
// fragment continues to identify the same heading after React takes over.
function headingId(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "heading"
  );
}

const markdown = new MarkdownIt({
  html: false,
  typographer: false,
  linkify: true,
  breaks: false,
});
markdown.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });

// Preserve code whitespace and table columns without forcing a narrow browser
// viewport to become as wide as their contents. These wrappers disappear with
// the initial article when the interactive docs renderer replaces it.
for (const type of ["fence", "code_block"] as const) {
  const render = markdown.renderer.rules[type]!;
  markdown.renderer.rules[type] = (...args) =>
    `<div style="max-width:100%;overflow-x:auto" tabindex="0">${render(...args)}</div>`;
}
markdown.renderer.rules.table_open = (tokens, index, options, _env, self) =>
  `<div style="max-width:100%;overflow-x:auto" tabindex="0">${self.renderToken(tokens, index, options)}`;
markdown.renderer.rules.table_close = (tokens, index, options, _env, self) =>
  `${self.renderToken(tokens, index, options)}</div>`;

function renderMarkdown(
  value: string,
  basePath: string,
  currentPath: string,
): string {
  // DocsMarkdown in the browser normalizes older String.raw doc bodies the
  // same way. Do not import its browser/editor dependency graph on the hub.
  const tokens = markdown.parse(value.replace(/\\`/g, "`"), {});
  const visit = (items: Token[]) => {
    for (let i = 0; i < items.length; i++) {
      const token = items[i];
      if (token.type === "heading_open") {
        token.attrSet(
          "id",
          headingId(inlineText(items[i + 1]?.children ?? [])),
        );
      }
      for (const attribute of ["href", "src"]) {
        const value = token.attrGet(attribute);
        if (value != null) {
          token.attrSet(attribute, publicHref(value, basePath, currentPath));
        }
      }
      if (token.type === "image") {
        token.attrSet("style", "max-width:100%;height:auto");
      }
      if (token.children != null) visit(token.children);
    }
  };
  visit(tokens);
  return markdown.renderer.render(tokens, markdown.options, {});
}

function renderEntry(entry: DocsEntry, basePath: string): string {
  const path = joinUrlPath(basePath, docsPath(entry.slug));
  return `<article data-cocalc-public-prerender="docs-detail" style="${ARTICLE_STYLE}">
<nav aria-label="Documentation"><a href="${htmlEscape(joinUrlPath(basePath, docsPath()))}">Browse documentation</a></nav>
<header><p>${htmlEscape(entry.category)}</p><h1>${htmlEscape(entry.title)}</h1><p>${htmlEscape(entry.summary)}</p></header>
${renderMarkdown(entry.body, basePath, path)}
</article>`;
}

function renderIndex(
  entries: DocsEntry[],
  basePath: string,
  config: PublicRouteMetadataConfig,
): string {
  const categories = new Map<string, DocsEntry[]>();
  for (const entry of entries) {
    const group = categories.get(entry.category) ?? [];
    group.push(entry);
    categories.set(entry.category, group);
  }
  const groups = Array.from(categories, ([category, entries]) => {
    const links = entries
      .map(
        (entry) =>
          `<li><a href="${htmlEscape(joinUrlPath(basePath, docsPath(entry.slug)))}">${htmlEscape(entry.title)}</a><p>${htmlEscape(entry.summary)}</p></li>`,
      )
      .join("");
    return `<section><h2>${htmlEscape(category)}</h2><ul>${links}</ul></section>`;
  }).join("");
  return `<main data-cocalc-public-prerender="docs-index" style="${ARTICLE_STYLE}"><h1>${htmlEscape(getPublicMarketingSiteName(config))} documentation</h1>${groups}</main>`;
}

export function renderPublicDocsPrerender(
  route: PublicMetadataRoute,
  basePath: string,
  config: PublicRouteMetadataConfig,
): string {
  if (route.section !== "docs") return "";
  const access = anonymousAccess(config);
  if (route.route?.view === "docs-index") {
    return renderIndex(listDocsEntries(access), basePath, config);
  }
  if (route.route?.view !== "docs-detail") return "";
  const entry = getDocsEntry(route.route.slug, access);
  return entry == null ? "" : renderEntry(entry, basePath);
}
