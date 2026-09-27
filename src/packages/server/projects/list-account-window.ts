/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type {
  AccountProjectListWindowRow,
  AccountProjectListWindowSort,
} from "@cocalc/conat/hub/api/projects";
import { listProjectedProjectsForAccount } from "@cocalc/database/postgres/account-project-index";
import getPool from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";
import {
  admitAccountSearch,
  type SearchAdmissionKey,
} from "@cocalc/server/api/search-admission";
import type {
  ApiProjectSummary,
  ApiProjectSummaryPage,
} from "@cocalc/conat/hub/api/projects";

const MAX_LIMIT = 500;
const MAX_SEARCH_LENGTH = 200;
const MAX_SEARCH_TERMS = 16;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

export async function listProjectSummaries({
  admission_key,
  account_id,
  project_id,
  limit = 100,
  offset = 0,
  search,
}: {
  admission_key?: SearchAdmissionKey;
  account_id: string;
  project_id?: string;
  limit?: number;
  offset?: number;
  search?: string;
}): Promise<ApiProjectSummaryPage> {
  if (!isValidUUID(account_id)) throw Error("invalid account id");
  if (project_id != null && !isValidUUID(project_id)) {
    throw Error("invalid project id");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw Error(`limit must be between 1 and ${MAX_LIMIT}`);
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) {
    throw Error("invalid project list offset");
  }
  if (
    search != null &&
    (typeof search !== "string" || search.length > MAX_SEARCH_LENGTH)
  ) {
    throw Error("invalid project list search");
  }
  const terms = (search ?? "").trim().split(/\s+/).filter(Boolean);
  if (terms.length > MAX_SEARCH_TERMS) {
    throw Error("too many project list search terms");
  }
  await admitAccountSearch(account_id, admission_key);
  const params: unknown[] = [account_id];
  const where = [
    "account_id=$1::UUID",
    "COALESCE(is_hidden, FALSE) IS NOT TRUE",
  ];
  if (project_id != null) {
    params.push(project_id);
    where.push(`project_id=$${params.length}::UUID`);
  }
  for (const term of terms) {
    const escaped = term
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    params.push(`%${escaped}%`);
    where.push(
      `(LEFT(COALESCE(title, ''), 512) ILIKE $${params.length} ESCAPE chr(92) OR LEFT(COALESCE(description, ''), 2048) ILIKE $${params.length} ESCAPE chr(92))`,
    );
  }
  params.push(limit + 1, offset);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const { rows } = await client.query<{
      project_id: string;
      title: string;
      description: string;
      host_id: string | null;
      state: string | null;
      last_edited: Date | string | null;
    }>(
      `SELECT project_id, LEFT(COALESCE(title, ''), 512) AS title,
              LEFT(COALESCE(description, ''), 2048) AS description,
              host_id, state_summary->>'state' AS state, last_edited
         FROM account_project_index
        WHERE ${where.join(" AND ")}
        ORDER BY last_edited DESC NULLS LAST, project_id
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    await client.query("COMMIT");
    const projects: ApiProjectSummary[] = [];
    let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      const project: ApiProjectSummary = {
        project_id: row.project_id,
        title: row.title,
        description: row.description,
        host_id: row.host_id,
        state: row.state,
        last_edited:
          row.last_edited == null
            ? null
            : new Date(row.last_edited).toISOString(),
      };
      const size = Buffer.byteLength(JSON.stringify(project), "utf8");
      const count = projects.length + 1;
      const envelopeBytes = Buffer.byteLength(
        JSON.stringify({
          projects: [],
          next_offset: count < rows.length ? offset + count : null,
        }),
        "utf8",
      );
      const nextBytes = bytes + size + (projects.length > 0 ? 1 : 0);
      if (nextBytes + envelopeBytes > MAX_PAGE_BYTES) {
        if (projects.length === 0) {
          throw Error("project summary exceeds page byte budget");
        }
        break;
      }
      projects.push(project);
      bytes = nextBytes;
    }
    return {
      projects,
      next_offset:
        projects.length < rows.length ? offset + projects.length : null,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

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
