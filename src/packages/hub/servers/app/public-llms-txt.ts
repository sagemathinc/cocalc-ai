/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// /llms.txt (https://llmstxt.org) is an index of public pages for AI
// assistants. It is generated from the "CoCalc at a glance" docs page and the
// docs and feature registries, so it can say no more than those pages: the
// quote is the page's first paragraph, the sections are its headings, and each
// link uses the linked page's own title and summary. It describes cocalc.ai,
// so it is served only on that host; other deployments return 404.

import type { Request, Response, Router } from "express";

import basePath from "@cocalc/backend/base-path";
import getCustomize from "@cocalc/database/settings/customize";
import { docsPath, getDocsEntry, type DocsAccess } from "@cocalc/docs";
import { getLogger } from "@cocalc/hub/logger";
import { getCocalcProduct } from "@cocalc/server/launchpad/mode";
import { getPublicFeaturePage } from "@cocalc/util/public-feature-pages";
import { getPublicMarketingSiteName } from "@cocalc/util/public-site-metadata";
import {
  CANONICAL_PUBLIC_SITE_ORIGIN,
  isCanonicalPublicSiteHost,
} from "@cocalc/util/public-site-policy";
import { joinUrlPath } from "@cocalc/util/url-path";

const logger = getLogger("hub:servers:public-llms-txt");

export const LLMS_TXT_PAGE_ID = "docs.cocalc-at-a-glance";
const ACCESS: DocsAccess = { siteProfile: "cocalc-ai" };

interface LlmsTxtLink {
  description?: string;
  label: string;
  status?: string;
  url: string;
}

function absoluteUrl(path: string): string {
  return `${CANONICAL_PUBLIC_SITE_ORIGIN}${joinUrlPath(basePath, path)}`;
}

// A page that is not generally released says so in its title.
function pageStatus(title: string): string | undefined {
  return /\bexperimental preview\b/i.test(title)
    ? "experimental preview"
    : undefined;
}

function pageLink(
  { summary, title }: { summary: string; title: string },
  path: string,
): LlmsTxtLink {
  return {
    description: summary,
    label: title,
    status: pageStatus(title),
    url: absoluteUrl(path),
  };
}

// Docs and feature links take the linked page's title and summary. A link the
// public site would not show on this deployment is left out.
function resolveLink(
  label: string,
  path: string,
  product: string,
): LlmsTxtLink | undefined {
  const docs = /^\/docs\/(.+)$/.exec(path);
  if (docs) {
    const entry = getDocsEntry(docs[1], ACCESS);
    return entry && pageLink(entry, docsPath(entry.slug));
  }
  const feature = /^\/features\/([^/]+)$/.exec(path);
  if (feature) {
    const page = getPublicFeaturePage(feature[1], { cocalc_product: product });
    return page && pageLink(page, `/features/${page.slug}`);
  }
  return { label, url: absoluteUrl(path) };
}

function linkLine({ description, label, status, url }: LlmsTxtLink): string {
  const notes = [description, status && `Status: ${status}.`]
    .filter(Boolean)
    .join(" ");
  return `- [${label}](${url})${notes ? `: ${notes}` : ""}`;
}

export function renderLlmsTxt({
  product,
  siteName,
}: {
  product: string;
  siteName: string;
}): string | undefined {
  const page = getDocsEntry(LLMS_TXT_PAGE_ID, ACCESS);
  if (page == null) return;
  const seen = new Set<string>();
  const sections: string[] = [];
  function addSection(title: string, links: (LlmsTxtLink | undefined)[]) {
    const lines = links.flatMap((link) => {
      if (link == null || seen.has(link.url)) return [];
      seen.add(link.url);
      return [linkLine(link)];
    });
    if (lines.length > 0) sections.push(`## ${title}\n\n${lines.join("\n")}`);
  }
  addSection("Start here", [pageLink(page, docsPath(page.slug))]);
  for (const block of page.body.split(/^## /m).slice(1)) {
    const title = block.slice(0, block.indexOf("\n")).trim();
    addSection(
      title,
      [...block.matchAll(/\[([^\]]+)\]\((\/[^)\s]*)\)/g)].map(
        ([, label, path]) => resolveLink(label, path, product),
      ),
    );
  }
  const definition = page.body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .find((paragraph) => paragraph && !paragraph.startsWith("#"));
  return `${[`# ${siteName}`, `> ${definition}`, ...sections].join("\n\n")}\n`;
}

export function serveLlmsTxt(req: Request, res: Response): void {
  res.vary("Host");
  if (!isCanonicalPublicSiteHost(req.get("host"))) {
    res.sendStatus(404);
    return;
  }
  void (async () => {
    const customize = await getCustomize();
    const text = renderLlmsTxt({
      product: getCocalcProduct(),
      siteName: getPublicMarketingSiteName({ site_name: customize?.siteName }),
    });
    if (text == null) {
      res.sendStatus(404);
      return;
    }
    res.type("text/plain");
    res.header("Cache-Control", "public, max-age=3600, must-revalidate");
    res.send(text);
  })().catch((err) => {
    logger.warn("llms.txt endpoint failed", { err: `${err}` });
    res.status(500).type("text/plain").send("internal error");
  });
}

export default function initPublicLlmsTxt(router: Router): void {
  router.get("/llms.txt", serveLlmsTxt);
}
