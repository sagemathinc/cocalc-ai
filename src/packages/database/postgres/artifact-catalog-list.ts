/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Account-wide, recent-first catalog pages on the project-owning bay. The
// authorized set is derived here, in SQL, from this bay's own project rows.
// Filter lists (named-agent threads, alias targets) come from the account's
// home bay and only ever narrow that set: every one is applied inside the
// scan of an authorized project, never as authority.

import getPool from "@cocalc/database/pool";
import type { CatalogEntry } from "@cocalc/conat/hub/api/artifact-catalog";
import { isValidUUID } from "@cocalc/util/misc";
import { liveOnBay } from "./artifact-catalog";
import { ARTIFACT_CATALOG_READ_GROUPS } from "./artifact-catalog-read";

export const ARTIFACT_CATALOG_LIST_DEFAULT_LIMIT = 50;
export const ARTIFACT_CATALOG_LIST_MAX_LIMIT = 200;
// Authorized projects per owner bay served in one reply (P_max).
export const ARTIFACT_CATALOG_LIST_MAX_PROJECTS = 1000;
export const ARTIFACT_CATALOG_LIST_MAX_FILTER = 500;
export const ARTIFACT_CATALOG_LIST_MAX_QUERY = 200;
export const ARTIFACT_CATALOG_LIST_TIMEOUT_MS = 3000;
// Hand-made artifacts live in each project's Library conversation.
export const ARTIFACT_CATALOG_LIBRARY_CHAT_SUFFIX =
  "/.local/share/cocalc/artifacts.chat";

export type ArtifactCatalogView = "mine" | "all";

const ENTRY_ID = /^[a-f0-9]{64}$/;
const CURSOR = /^(0|[1-9][0-9]{0,15}):([0-9a-f]{64})$/;
const MAX_TIME_MS = 8.64e15;

export interface ArtifactCatalogCursor {
  created_ms: number;
  entry_id: string;
}

/** Parses the opaque keyset cursor "<created_at_ms>:<entry_id>". */
export function parseArtifactCatalogCursor(
  before: unknown,
): ArtifactCatalogCursor | undefined {
  if (before === undefined || before === null || before === "")
    return undefined;
  const match = typeof before === "string" ? CURSOR.exec(before) : null;
  const created_ms = match ? Number(match[1]) : NaN;
  if (!match || !Number.isSafeInteger(created_ms) || created_ms > MAX_TIME_MS)
    throw Error("invalid catalog cursor");
  return { created_ms, entry_id: match[2] };
}

export function artifactCatalogCursor(key: ArtifactCatalogCursor): string {
  return `${key.created_ms}:${key.entry_id}`;
}

/** Newest first; the entry id breaks ties. */
export function compareArtifactCatalogKeys(
  a: ArtifactCatalogCursor,
  b: ArtifactCatalogCursor,
): number {
  if (a.created_ms !== b.created_ms) return b.created_ms - a.created_ms;
  return a.entry_id < b.entry_id ? 1 : a.entry_id > b.entry_id ? -1 : 0;
}

/** Trims and bounds a search query; undefined when there is none. */
export function normalizeArtifactCatalogQuery(
  query: unknown,
): string | undefined {
  if (query === undefined || query === null) return undefined;
  if (typeof query !== "string") throw Error("invalid catalog search");
  const trimmed = query.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > ARTIFACT_CATALOG_LIST_MAX_QUERY)
    throw Error("invalid catalog search");
  return trimmed;
}

/** A substring pattern for ILIKE ... ESCAPE '\'. */
export function artifactCatalogLikePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function normalizeArtifactCatalogLimit(limit: unknown): number {
  if (limit === undefined || limit === null)
    return ARTIFACT_CATALOG_LIST_DEFAULT_LIMIT;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 0 ||
    limit > ARTIFACT_CATALOG_LIST_MAX_LIMIT
  )
    throw Error("invalid catalog page size");
  return limit;
}

/** (source_id, thread_id) pairs: a named agent's current conversation. */
export interface ArtifactCatalogThreadFilter {
  source_ids: string[];
  thread_ids: string[];
}

/** (project_id, entry_id) pairs: the requester's own artifact aliases. */
export interface ArtifactCatalogEntryFilter {
  project_ids: string[];
  entry_ids: string[];
}

export interface OwnedArtifactCatalogListRequest {
  account_id: string;
  owning_bay_id: string;
  limit: number;
  before?: string;
  project_id?: string;
  view: ArtifactCatalogView;
  /** view "mine": the requester's named agents' conversations. */
  mine?: ArtifactCatalogThreadFilter;
  query?: string;
  /** search: named agents whose personal name matches the query. */
  name_hits?: ArtifactCatalogThreadFilter;
  /** search: aliases whose name matches the query. */
  alias_hits?: ArtifactCatalogEntryFilter;
  /** search: the query matches the Library conversation's name. */
  library_name_hit?: boolean;
  versions?: boolean;
  /** Tests only. */
  max_projects?: number;
}

export interface OwnedArtifactCatalogListResult {
  entries: CatalogEntry[];
  /** Keyset position of each entry, aligned with entries. */
  keys: string[];
  /** This bay has more rows after the last entry. */
  more: boolean;
  /** Every in-scope project, when versions were requested. */
  versions?: Record<string, { epoch: string; seq: number }>;
  /** The in-scope projects (for the caller's post-read re-check). */
  scope: string[];
  /** Readable projects on this bay, with or without a catalog. */
  authorized: number;
  too_many_projects: number;
  not_ready: number;
}

function threadFilter(value: unknown): ArtifactCatalogThreadFilter {
  const v = (value ?? { source_ids: [], thread_ids: [] }) as any;
  if (
    !Array.isArray(v.source_ids) ||
    !Array.isArray(v.thread_ids) ||
    v.source_ids.length !== v.thread_ids.length ||
    v.source_ids.length > ARTIFACT_CATALOG_LIST_MAX_FILTER ||
    v.source_ids.some(
      (s: unknown) => typeof s !== "string" || !ENTRY_ID.test(s),
    ) ||
    v.thread_ids.some(
      (t: unknown) => typeof t !== "string" || !t || t.length > 200,
    )
  )
    throw Error("invalid catalog filter");
  return { source_ids: v.source_ids, thread_ids: v.thread_ids };
}

function entryFilter(value: unknown): ArtifactCatalogEntryFilter {
  const v = (value ?? { project_ids: [], entry_ids: [] }) as any;
  if (
    !Array.isArray(v.project_ids) ||
    !Array.isArray(v.entry_ids) ||
    v.project_ids.length !== v.entry_ids.length ||
    v.project_ids.length > ARTIFACT_CATALOG_LIST_MAX_FILTER ||
    v.project_ids.some(
      (p: unknown) => typeof p !== "string" || !isValidUUID(p),
    ) ||
    v.entry_ids.some((e: unknown) => typeof e !== "string" || !ENTRY_ID.test(e))
  )
    throw Error("invalid catalog filter");
  return { project_ids: v.project_ids, entry_ids: v.entry_ids };
}

/** Validates a whole owner-bay request; returns a normalized copy. */
export function validateOwnedArtifactCatalogListRequest(
  opts: OwnedArtifactCatalogListRequest,
) {
  if (!isValidUUID(opts?.account_id)) throw Error("invalid account_id");
  if (typeof opts.owning_bay_id !== "string" || !opts.owning_bay_id)
    throw Error("invalid owning bay");
  if (opts.project_id !== undefined && !isValidUUID(opts.project_id))
    throw Error("invalid project_id");
  if (opts.view !== "mine" && opts.view !== "all")
    throw Error("invalid catalog view");
  const query = normalizeArtifactCatalogQuery(opts.query);
  return {
    account_id: opts.account_id,
    owning_bay_id: opts.owning_bay_id,
    limit: normalizeArtifactCatalogLimit(opts.limit),
    before: parseArtifactCatalogCursor(opts.before),
    project_id: opts.project_id,
    view: opts.view,
    mine: opts.view === "mine" ? threadFilter(opts.mine) : undefined,
    query,
    name_hits: query ? threadFilter(opts.name_hits) : undefined,
    alias_hits: query ? entryFilter(opts.alias_hits) : undefined,
    library_name_hit: query ? opts.library_name_hit === true : false,
    versions: opts.versions === true || opts.limit === 0,
    max_projects:
      Number.isInteger(opts.max_projects) && opts.max_projects! > 0
        ? Math.min(opts.max_projects!, ARTIFACT_CATALOG_LIST_MAX_PROJECTS)
        : ARTIFACT_CATALOG_LIST_MAX_PROJECTS,
  };
}

type Valid = ReturnType<typeof validateOwnedArtifactCatalogListRequest>;

/**
 * The SQL for one page over the in-scope projects ($1). Every filter is a
 * conjunct of the per-project scan `c.project_id = <in-scope project>`.
 *
 * Shape: one probe per project finds its best passing key below the cursor;
 * only the n projects with the best probe keys can hold any of the top n rows
 * (a lower-ranked project has n better rows above its best), so the page is a
 * top-n scan over just those projects.
 */
function pageQuery(valid: Valid, scope: string[], n: number) {
  const params: unknown[] = [scope];
  const p = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const ctes: string[] = [];
  let needLibrary = false;
  const conds = ["NOT c.deleted"];
  if (valid.before) {
    // The key is a millisecond instant: ingest stores created_at from a
    // millisecond value, so this compares exactly the instant in the cursor
    // (and stays on the (project_id, created_at, entry_id) index).
    const t = p(new Date(valid.before.created_ms).toISOString());
    const e = p(valid.before.entry_id);
    conds.push(
      `c.created_at <= ${t}::timestamptz AND (c.created_at < ${t}::timestamptz OR c.entry_id < ${e})`,
    );
  }
  if (valid.view === "mine") {
    needLibrary = true;
    const s = p(valid.mine!.source_ids);
    const th = p(valid.mine!.thread_ids);
    conds.push(`((c.source_id, c.thread_id) IN
      (SELECT * FROM unnest(${s}::text[], ${th}::text[]))
      OR c.source_id IN (SELECT source_id FROM library))`);
  }
  if (valid.query) {
    const pat = p(artifactCatalogLikePattern(valid.query));
    ctes.push(`path_hits AS (
      SELECT source_id FROM artifact_catalog_sources
      WHERE project_id = ANY($1::uuid[]) AND chat_path ILIKE ${pat} ESCAPE '\\')`);
    const fields = [
      "c.metadata->>'title'",
      "c.metadata->>'description'",
      "c.metadata->>'kind'",
      "c.metadata->'target'->>'path'",
      "c.metadata->'target'->>'repository'",
      "c.metadata->'target'->>'sha'",
    ].map((f) => `${f} ILIKE ${pat} ESCAPE '\\'`);
    const ns = p(valid.name_hits!.source_ids);
    const nt = p(valid.name_hits!.thread_ids);
    const ap = p(valid.alias_hits!.project_ids);
    const ae = p(valid.alias_hits!.entry_ids);
    const match = [
      ...fields,
      "c.source_id IN (SELECT source_id FROM path_hits)",
      `(c.source_id, c.thread_id) IN (SELECT * FROM unnest(${ns}::text[], ${nt}::text[]))`,
      `(c.project_id, c.entry_id) IN (SELECT * FROM unnest(${ap}::uuid[], ${ae}::text[]))`,
    ];
    if (valid.library_name_hit) {
      needLibrary = true;
      match.push("c.source_id IN (SELECT source_id FROM library)");
    }
    conds.push(`(${match.join("\n      OR ")})`);
  }
  if (needLibrary) {
    const suffix = p(ARTIFACT_CATALOG_LIBRARY_CHAT_SUFFIX);
    ctes.unshift(`library AS (
      SELECT source_id FROM artifact_catalog_sources
      WHERE project_id = ANY($1::uuid[])
        AND right(chat_path, length(${suffix})) = ${suffix})`);
  }
  const limit = p(n);
  const where = conds.join("\n        AND ");
  const scan = (
    project: string,
    cap: string,
  ) => `SELECT c.created_at, c.entry_id
        FROM artifact_catalog c
        WHERE c.project_id = ${project}
        AND ${where}
        ORDER BY c.created_at DESC, c.entry_id DESC
        LIMIT ${cap}`;
  const sql = `WITH ${[
    ...ctes,
    `scope AS (SELECT unnest($1::uuid[]) AS project_id)`,
    `probe AS (
      SELECT sc.project_id, b.created_at, b.entry_id FROM scope sc
      CROSS JOIN LATERAL (${scan("sc.project_id", "1")}) b)`,
    `top_projects AS (
      SELECT project_id FROM probe
      ORDER BY created_at DESC, entry_id DESC LIMIT ${limit})`,
    `page AS (
      SELECT k.created_at, k.entry_id FROM top_projects t
      CROSS JOIN LATERAL (${scan("t.project_id", limit)}) k
      ORDER BY k.created_at DESC, k.entry_id DESC LIMIT ${limit})`,
  ].join(",\n    ")}
    SELECT c.project_id, c.entry_id, s.chat_path, c.metadata,
      (extract(epoch FROM c.created_at) * 1000)::bigint AS created_ms
    FROM page
    JOIN artifact_catalog c ON c.entry_id = page.entry_id
    JOIN artifact_catalog_sources s ON s.source_id = c.source_id
    ORDER BY page.created_at DESC, page.entry_id DESC`;
  return { sql, params };
}

/**
 * One account-wide page on this owning bay, read in a single consistent
 * snapshot: the authorized set, the in-scope projects and their versions,
 * and the page all come from the same statement snapshot. The caller
 * re-checks access after the read and rate-limits.
 */
export async function listArtifactCatalogForAccountLocal(
  opts: OwnedArtifactCatalogListRequest,
): Promise<OwnedArtifactCatalogListResult> {
  const valid = validateOwnedArtifactCatalogListRequest(opts);
  const db = await getPool().connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await db.query(
      `SET LOCAL statement_timeout = ${ARTIFACT_CATALOG_LIST_TIMEOUT_MS}`,
    );
    const { rows: projects } = await db.query(
      `SELECT p.project_id, st.epoch, st.seq,
         (extract(epoch FROM st.latest_created_at) * 1000)::bigint AS latest_ms,
         (st.project_id IS NULL AND EXISTS (
           SELECT 1 FROM artifact_catalog_sources s
           WHERE s.project_id = p.project_id)) AS not_ready
       FROM projects p
       LEFT JOIN artifact_catalog_project_state st ON st.project_id = p.project_id
       WHERE p.users ? $1
         AND p.users -> $1 ->> 'group' = ANY($3::text[])
         AND ${liveOnBay("p", "$2")}
         AND ($4::uuid IS NULL OR p.project_id = $4::uuid)`,
      [
        valid.account_id,
        valid.owning_bay_id,
        ARTIFACT_CATALOG_READ_GROUPS,
        valid.project_id ?? null,
      ],
    );
    const versioned = projects
      .filter((row) => row.epoch != null)
      .sort((a, b) => {
        const am = a.latest_ms == null ? -1 : Number(a.latest_ms);
        const bm = b.latest_ms == null ? -1 : Number(b.latest_ms);
        if (am !== bm) return bm - am;
        return a.project_id < b.project_id
          ? -1
          : a.project_id > b.project_id
            ? 1
            : 0;
      });
    const inScope = versioned.slice(0, valid.max_projects);
    const scope = inScope.map((row) => row.project_id as string);
    let rows: any[] = [];
    if (valid.limit > 0 && scope.length > 0) {
      const { sql, params } = pageQuery(valid, scope, valid.limit + 1);
      rows = (await db.query(sql, params)).rows;
    }
    await db.query("COMMIT");
    const page = rows.slice(0, valid.limit);
    return {
      entries: page.map((row) => ({
        entry_id: row.entry_id,
        project_id: row.project_id,
        chat_path: row.chat_path,
        item: row.metadata,
      })),
      keys: page.map((row) =>
        artifactCatalogCursor({
          created_ms: Number(row.created_ms),
          entry_id: row.entry_id,
        }),
      ),
      more: rows.length > valid.limit,
      ...(valid.versions
        ? {
            versions: Object.fromEntries(
              inScope.map((row) => [
                row.project_id,
                { epoch: row.epoch, seq: Number(row.seq) },
              ]),
            ),
          }
        : {}),
      scope,
      authorized: projects.length,
      too_many_projects: versioned.length - inScope.length,
      not_ready: projects.filter((row) => row.not_ready).length,
    };
  } catch (err) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    db.release();
  }
}
