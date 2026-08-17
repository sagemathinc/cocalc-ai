/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type {
  AccountProjectListWindowRow,
  AccountProjectListWindowSort,
} from "@cocalc/conat/hub/api/projects";
import { listProjectedProjectsForAccount } from "@cocalc/database/postgres/account-project-index";

const MAX_LIMIT = 500;

function normalizeLimit(limit?: number): number {
  if (limit == null) return 50;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw Error("limit must be a positive integer");
  }
  return Math.min(limit, MAX_LIMIT);
}

function normalizeOffset(offset?: number): number {
  if (offset == null) return 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw Error("offset must be a nonnegative integer");
  }
  return offset;
}

function normalizeSort(
  sort?: AccountProjectListWindowSort,
): AccountProjectListWindowSort {
  switch (sort) {
    case undefined:
      return "last_edited";
    case "last_edited":
    case "title":
    case "state":
      return sort;
    default:
      throw Error(`unsupported project list sort '${sort}'`);
  }
}

export async function listAccountProjectWindow({
  account_id,
  hidden,
  limit,
  offset,
  project_id,
  search,
  sort,
}: {
  account_id: string;
  hidden?: boolean;
  limit?: number;
  offset?: number;
  project_id?: string;
  search?: string;
  sort?: AccountProjectListWindowSort;
}): Promise<AccountProjectListWindowRow[]> {
  return await listProjectedProjectsForAccount({
    account_id,
    include_hidden: !!hidden,
    limit: normalizeLimit(limit),
    offset: normalizeOffset(offset),
    project_id,
    search,
    sort: normalizeSort(sort),
  });
}
