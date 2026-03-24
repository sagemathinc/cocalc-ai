/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Request, Response } from "express";

import {
  getNewsItemUser,
  getNewsItemUserPrevNext,
} from "@cocalc/database/postgres/news";
import { slugURL } from "@cocalc/util/news";
import type { NewsItem } from "@cocalc/util/types/news";

function getIntegerParam(value: unknown): number | undefined {
  if (typeof value !== "string") return;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return;
  return parsed;
}

function getHistoryTimestamps(news?: NewsItem): number[] {
  return Object.keys(news?.history ?? {})
    .map(Number)
    .filter((ts) => Number.isInteger(ts) && ts >= 0)
    .sort((a, b) => a - b);
}

export default async function handle(req: Request, res: Response) {
  try {
    const id = getIntegerParam(req.query.id);
    if (id == null) {
      throw new Error("invalid news id");
    }

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, max-age=3600");

    const timestamp = getIntegerParam(req.query.timestamp);
    if (timestamp == null) {
      const { news, prev, next } = await getNewsItemUserPrevNext(id);
      if (news == null) {
        return res.json({ error: "not found" });
      }
      return res.json({
        history: false,
        news,
        prev,
        next,
        permalink: slugURL(news),
      });
    }

    const news = await getNewsItemUser(id);
    if (news == null) {
      return res.json({ error: "not found" });
    }

    const historic = news.history?.[timestamp];
    if (historic == null) {
      return res.json({ error: "history not found" });
    }

    const timestamps = getHistoryTimestamps(news);
    const index = timestamps.indexOf(timestamp);

    return res.json({
      history: true,
      news: { ...news, ...historic, date: timestamp },
      prevTimestamp: index > 0 ? timestamps[index - 1] : null,
      nextTimestamp: index >= 0 ? (timestamps[index + 1] ?? null) : null,
      permalink: slugURL(news),
      timestamp,
    });
  } catch (err) {
    res.json({ error: `${err.message}` });
  }
}
