/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Request, Response } from "express";

import { getAdminIndex } from "@cocalc/database/postgres/news";
import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import userIsInGroup from "@cocalc/server/accounts/is-in-group";

function getPositiveInteger(
  value: unknown,
  fallback: number,
  opts?: { max?: number },
): number {
  const max = opts?.max ?? Number.POSITIVE_INFINITY;
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isInteger(numeric) || numeric < 0) {
    return fallback;
  }
  return Math.min(numeric, max);
}

export default async function handle(req: Request, res: Response) {
  try {
    const account_id = await getAccountId(req);
    if (account_id == null) {
      throw Error("must be signed in to view news drafts");
    }
    if (!(await userIsInGroup(account_id, "admin"))) {
      throw Error("only admins can view news drafts");
    }
    const { limit, offset } = getParams(req);
    const items = await getAdminIndex(
      getPositiveInteger(limit, 100, { max: 500 }),
      getPositiveInteger(offset, 0),
    );
    res.json({ items, success: true });
  } catch (err) {
    res.json({ error: `${err.message}` });
  }
}
