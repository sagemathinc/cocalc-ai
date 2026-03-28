/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Request, Response, Router } from "express";

import basePath from "@cocalc/backend/base-path";
import { getFeedData } from "@cocalc/database/postgres/news";
import getCustomize from "@cocalc/database/settings/customize";
import { capitalize } from "@cocalc/util/misc";
import { slugURL } from "@cocalc/util/news";
import {
  CHANNELS,
  CHANNELS_DESCRIPTIONS,
  type Channel,
  type NewsItem,
} from "@cocalc/util/types/news";
import { joinUrlPath } from "@cocalc/util/url-path";

function getTargetSearch(req: Request): string {
  const url = new URL("http://host");
  const targetPath = joinUrlPath(basePath, req.path);
  const search = req.url.includes("?")
    ? req.url.slice(req.url.indexOf("?"))
    : "";
  if (search) {
    url.searchParams.set("target", targetPath + search);
  } else {
    url.searchParams.set("target", targetPath);
  }
  return url.search;
}

function redirectToStatic(req: Request, res: Response): void {
  res.redirect(
    joinUrlPath(basePath, "static/public-content.html") + getTargetSearch(req),
  );
}

function redirectCompatibility(target: string) {
  return function (_req: Request, res: Response): void {
    res.redirect(joinUrlPath(basePath, target));
  };
}

function stripMarkdown(text?: string): string {
  return `${text ?? ""}`
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_>#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getOrigin(req: Request): string {
  return `${req.protocol}://${req.get("host")}`;
}

function absoluteUrl(req: Request, path: string): string {
  return `${getOrigin(req)}${joinUrlPath(basePath, path)}`;
}

function channelFromQuery(req: Request): Channel | "all" {
  const query = req.query.channel;
  if (typeof query === "string" && CHANNELS.includes(query as Channel)) {
    return query as Channel;
  }
  return "all";
}

function filterFeedItems(
  items: NewsItem[],
  channel: Channel | "all",
): NewsItem[] {
  if (channel === "all") return items;
  return items.filter((item) => item.channel === channel);
}

function toDateString(value: number | Date): string {
  const date = value instanceof Date ? value : new Date(value * 1000);
  return date.toUTCString();
}

async function renderRss(req: Request): Promise<string> {
  const { siteName } = await getCustomize();
  const channel = channelFromQuery(req);
  const items = filterFeedItems(await getFeedData(), channel);
  const selfLink = absoluteUrl(req, "news/rss.xml");
  const title =
    channel === "all"
      ? `${siteName} News`
      : `${siteName} News – ${capitalize(channel)}`;
  const description =
    channel === "all"
      ? `News about ${siteName}.`
      : `News about ${siteName}. ${CHANNELS_DESCRIPTIONS[channel]}.`;

  const body = items
    .map((item) => {
      const url = absoluteUrl(req, slugURL(item));
      return `
    <item>
      <title>${xmlEscape(item.title)}</title>
      <link>${xmlEscape(url)}</link>
      <description>${xmlEscape(stripMarkdown(item.text))}</description>
      <pubDate>${xmlEscape(toDateString(item.date))}</pubDate>
      <guid>${xmlEscape(url)}</guid>
    </item>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <atom:link href="${xmlEscape(selfLink)}" rel="self" type="application/rss+xml" />
    <title>${xmlEscape(title)}</title>
    <description>${xmlEscape(description)}</description>
    <link>${xmlEscape(absoluteUrl(req, "news"))}</link>
    <pubDate>${xmlEscape(new Date().toUTCString())}</pubDate>${body}
  </channel>
</rss>`;
}

async function renderJsonFeed(req: Request): Promise<object> {
  const { siteName } = await getCustomize();
  const items = await getFeedData();
  return {
    version: "https://jsonfeed.org/version/1.1",
    title: `${siteName} News`,
    home_page_url: absoluteUrl(req, "news"),
    feed_url: absoluteUrl(req, "news/feed.json"),
    description: `News about ${siteName}.`,
    items: items.map((item) => {
      const url = absoluteUrl(req, slugURL(item));
      return {
        id: `${item.id}`,
        url,
        external_url: item.url,
        title: item.title,
        content_text: stripMarkdown(item.text),
        date_published:
          item.date instanceof Date
            ? item.date.toISOString()
            : new Date(item.date * 1000).toISOString(),
      };
    }),
  };
}

export default function initPublicContent(router: Router): void {
  router.get(["/info", "/info/"], redirectCompatibility("about"));
  router.get(["/info/doc", "/info/doc/"], redirectCompatibility("support"));
  router.get(
    ["/info/status", "/info/status/"],
    redirectCompatibility("about/status"),
  );
  router.get(["/info/run", "/info/run/"], redirectCompatibility("software"));

  router.get("/news/rss.xml", async (req, res) => {
    try {
      res.setHeader("Content-Type", "text/xml");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.send(await renderRss(req));
    } catch (err) {
      res.status(500).send(`${err}`);
    }
  });

  router.get("/news/feed.json", async (req, res) => {
    try {
      res.setHeader("Content-Type", "application/feed+json");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.json(await renderJsonFeed(req));
    } catch (err) {
      res.status(500).json({ error: `${err}` });
    }
  });

  const contentPaths = [
    "/about",
    "/about/",
    "/about/events",
    "/about/events/",
    "/about/status",
    "/about/status/",
    "/about/team",
    "/about/team/",
    "/about/team/:slug",
    "/about/team/:slug/",
    "/pricing",
    "/pricing/",
    "/pricing/:slug",
    "/pricing/:slug/",
    "/policies",
    "/policies/",
    "/policies/imprint",
    "/policies/imprint/",
    "/policies/policies",
    "/policies/policies/",
    "/policies/:slug",
    "/policies/:slug/",
    "/news",
    "/news/",
    "/news/:slug",
    "/news/:slug/",
    "/news/:slug/:timestamp",
    "/news/:slug/:timestamp/",
    "/software",
    "/software/",
    "/software/cocalc-launchpad",
    "/software/cocalc-launchpad/",
    "/software/cocalc-plus",
    "/software/cocalc-plus/",
  ];

  router.get(contentPaths, redirectToStatic);
}
