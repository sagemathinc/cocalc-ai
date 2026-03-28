/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Request, Response } from "express";

import { getNewsItem } from "@cocalc/database/postgres/news";
import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import userIsInGroup from "@cocalc/server/accounts/is-in-group";

function getInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return;
}

export default async function handle(req: Request, res: Response) {
  try {
    const account_id = await getAccountId(req);
    if (account_id == null) {
      throw Error("must be signed in to edit news");
    }
    if (!(await userIsInGroup(account_id, "admin"))) {
      throw Error("only admins can edit news items");
    }
    const { id } = getParams(req);
    const newsId = getInteger(id);
    if (newsId == null) {
      throw Error("invalid news id");
    }
    const news = await getNewsItem(newsId, false);
    if (news == null) {
      throw Error("news item not found");
    }
    res.json({ news, success: true });
  } catch (err) {
    res.json({ error: `${err.message}` });
  }
}
