/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Request, Response } from "express";

import {
  getPastNewsChannelItems,
  getUpcomingNewsChannelItems,
} from "@cocalc/database/postgres/news";

export default async function handle(_req: Request, res: Response) {
  try {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json({
      upcoming: await getUpcomingNewsChannelItems("event"),
      past: await getPastNewsChannelItems("event"),
    });
  } catch (err) {
    res.json({ error: `${err.message}` });
  }
}
