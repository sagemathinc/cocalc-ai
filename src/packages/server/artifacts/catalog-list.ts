/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Account-wide catalog pages (recent first) and search.
//
// The browser's hub forwards to the account's home bay. The home bay reads
// only its own account-scoped data: which owner bays to ask (the account's
// project projection, plus itself), and the requester's own name book and
// alias names, which become bounded filter lists. Each owner bay derives and
// authorizes its own project set from its project rows; the filter lists only
// narrow it. A client-supplied project_id never chooses a destination.

import { requireUuid } from "@cocalc/conat/agents/protocol";
import type {
  ArtifactCatalogApi,
  CatalogAccountListRequest,
  CatalogAccountPage,
  CatalogEntry,
  CatalogProjectVersion,
  CatalogView,
} from "@cocalc/conat/hub/api/artifact-catalog";
import {
  createInterBayArtifactCatalogClient,
  type CatalogOwnedListReply,
  type CatalogOwnedListRequest,
  type InterBayArtifactCatalogApi,
} from "@cocalc/conat/inter-bay/artifact-catalog";
import getPool from "@cocalc/database/pool";
import {
  artifactCatalogSourceId,
  artifactCatalogStateBackfillRemaining,
} from "@cocalc/database/postgres/artifact-catalog";
import {
  ARTIFACT_CATALOG_LIST_MAX_FILTER,
  artifactCatalogLikePattern,
  compareArtifactCatalogKeys,
  listArtifactCatalogForAccountLocal,
  normalizeArtifactCatalogLimit,
  normalizeArtifactCatalogQuery,
  parseArtifactCatalogCursor,
} from "@cocalc/database/postgres/artifact-catalog-list";
import {
  ARTIFACT_CATALOG_NOT_PERMITTED,
  authorizedArtifactCatalogProjects,
} from "@cocalc/database/postgres/artifact-catalog-read";
import { isValidUUID } from "@cocalc/util/misc";
import * as metrics from "@cocalc/backend/metrics";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import {
  ensureAccountSecurityStateReady,
  isAccountBannedCached,
} from "@cocalc/server/accounts/security-state";
import { withArtifactCatalogReadLimit } from "./catalog-read-limits";

/**
 * The view used when a request names none. This is the one place that
 * decides it (a reversible default: "mine" = the requester's named agents'
 * conversations plus Library chats; "all" = every readable catalog row).
 */
export const ARTIFACT_CATALOG_DEFAULT_VIEW: CatalogView = "mine";

// Owner bays asked at once, and how long each may take. Every bay is asked;
// this bounds concurrency, not coverage.
export const ARTIFACT_CATALOG_LIST_BAY_PARALLELISM = 8;
export const ARTIFACT_CATALOG_LIST_BAY_TIMEOUT_MS = 3000;

// The synthetic agent name the Library conversation is listed under.
const LIBRARY_AGENT_NAME = "artifacts";

/** Fails closed with the uniform error for a banned account. */
export async function assertArtifactCatalogReaderNotBanned(
  account_id: string,
): Promise<void> {
  await ensureAccountSecurityStateReady();
  if (isAccountBannedCached(account_id))
    throw Error(ARTIFACT_CATALOG_NOT_PERMITTED);
}

interface ValidListRequest {
  account_id: string;
  limit: number;
  before?: string;
  query?: string;
  project_id?: string;
  view: CatalogView;
  versions: boolean;
}

/** Validates and bounds the whole request before any lookup or routing. */
export function validateArtifactCatalogListRequest(
  opts: CatalogAccountListRequest,
): ValidListRequest {
  requireUuid(opts?.account_id, "account_id");
  const limit = normalizeArtifactCatalogLimit(opts.limit);
  parseArtifactCatalogCursor(opts.before);
  if (
    opts.project_id !== undefined &&
    (typeof opts.project_id !== "string" || !isValidUUID(opts.project_id))
  )
    throw Error("invalid project_id");
  if (opts.view !== undefined && opts.view !== "mine" && opts.view !== "all")
    throw Error("invalid catalog view");
  return {
    account_id: opts.account_id!,
    limit,
    ...(opts.before ? { before: opts.before } : {}),
    ...(normalizeArtifactCatalogQuery(opts.query) !== undefined
      ? { query: normalizeArtifactCatalogQuery(opts.query) }
      : {}),
    ...(opts.project_id ? { project_id: opts.project_id } : {}),
    view: opts.view ?? ARTIFACT_CATALOG_DEFAULT_VIEW,
    versions: opts.versions === true || limit === 0,
  };
}

function interBay(bay_id: string): InterBayArtifactCatalogApi {
  return createInterBayArtifactCatalogClient({
    client: getInterBayFabricClient(),
    bay_id,
  });
}

/**
 * Hub entry point. Rate limits are per hub process: a page or a probe, and
 * additionally search for any request with a query.
 */
export const listAccount: ArtifactCatalogApi["listAccount"] = async (opts) => {
  const request = validateArtifactCatalogListRequest(opts);
  const { account_id } = request;
  const run = async () => {
    const { home_bay_id } = await resolveAccountHomeBay({ account_id });
    if (!home_bay_id) throw Error("account home unavailable");
    if (home_bay_id === getConfiguredBayId())
      return await listAccountOnHomeBay(request);
    return await interBay(home_bay_id).listAccountHome({
      ...request,
      home_bay_id,
    });
  };
  return await withArtifactCatalogReadLimit(
    account_id,
    request.limit === 0 ? "listAccountProbe" : "listAccount",
    () =>
      request.query
        ? withArtifactCatalogReadLimit(account_id, "search", run)
        : run(),
  );
};

/** Trusted inter-bay entry on the home bay; never re-routes a stale home. */
export async function listAccountHomeControl(
  opts: CatalogAccountListRequest & { home_bay_id: string },
): Promise<CatalogAccountPage> {
  const request = validateArtifactCatalogListRequest(opts);
  const { home_bay_id } = await resolveAccountHomeBay({
    account_id: request.account_id,
  });
  if (home_bay_id !== getConfiguredBayId() || opts.home_bay_id !== home_bay_id)
    throw Error("stale account-home route");
  return await listAccountOnHomeBay(request);
}

interface ThreadFilter {
  source_ids: string[];
  thread_ids: string[];
}

/** The requester's own named agents' current conversations (cap + 1 read). */
async function namedAgentThreads(
  account_id: string,
  { project_id, pattern }: { project_id?: string; pattern?: string },
): Promise<{ filter: ThreadFilter; limited: boolean }> {
  const { rows } = await getPool().query(
    `SELECT project_id, metadata->>'path' AS path,
       metadata->>'thread_id' AS thread_id
     FROM agent_personal_names
     WHERE account_id = $1 AND retired_at IS NULL
       AND ($2::uuid IS NULL OR project_id = $2::uuid)
       AND ($3::text IS NULL OR name ILIKE $3 ESCAPE '\\')
     ORDER BY updated_at DESC, name
     LIMIT $4`,
    [
      account_id,
      project_id ?? null,
      pattern ?? null,
      ARTIFACT_CATALOG_LIST_MAX_FILTER + 1,
    ],
  );
  const filter: ThreadFilter = { source_ids: [], thread_ids: [] };
  for (const row of rows.slice(0, ARTIFACT_CATALOG_LIST_MAX_FILTER)) {
    if (
      typeof row.path !== "string" ||
      !row.path ||
      typeof row.thread_id !== "string" ||
      !row.thread_id ||
      row.thread_id.length > 200
    )
      continue;
    filter.source_ids.push(
      artifactCatalogSourceId({
        project_id: row.project_id,
        chat_path: row.path,
      }),
    );
    filter.thread_ids.push(row.thread_id);
  }
  return { filter, limited: rows.length > ARTIFACT_CATALOG_LIST_MAX_FILTER };
}

/** The requester's own active aliases whose name matches (cap + 1 read). */
async function aliasTargets(
  account_id: string,
  pattern: string,
): Promise<{
  filter: { project_ids: string[]; entry_ids: string[] };
  limited: boolean;
}> {
  const { rows } = await getPool().query(
    `SELECT project_id, entry_id FROM personal_library_aliases
     WHERE account_id = $1 AND active AND name ILIKE $2 ESCAPE '\\'
     ORDER BY name LIMIT $3`,
    [account_id, pattern, ARTIFACT_CATALOG_LIST_MAX_FILTER + 1],
  );
  const kept = rows
    .slice(0, ARTIFACT_CATALOG_LIST_MAX_FILTER)
    .filter((row) => /^[a-f0-9]{64}$/.test(row.entry_id));
  return {
    filter: {
      project_ids: kept.map((row) => row.project_id),
      entry_ids: kept.map((row) => row.entry_id),
    },
    limited: rows.length > ARTIFACT_CATALOG_LIST_MAX_FILTER,
  };
}

/**
 * The owner bays to ask: every bay the account's own project projection
 * lists, plus this (home) bay, with the number of projected projects each.
 */
async function projectedBays(
  account_id: string,
  home: string,
): Promise<Map<string, number>> {
  const { rows } = await getPool().query(
    `SELECT COALESCE(NULLIF(BTRIM(owning_bay_id), ''), $2) AS bay_id,
       count(*)::int AS projects
     FROM account_project_index WHERE account_id = $1 GROUP BY 1`,
    [account_id, home],
  );
  const bays = new Map<string, number>(
    rows.map((row) => [row.bay_id as string, Number(row.projects)]),
  );
  if (!bays.has(home)) bays.set(home, 0);
  return bays;
}

let projectionMismatch: any;
function countProjectionMismatch() {
  projectionMismatch ??= metrics.newCounter(
    "server",
    "artifact_catalog_projection_empty_bay_total",
    "Account-wide catalog reads where an owner bay found no readable project although the account's projection lists projects there (stale projection, or viewer-only access).",
  );
  projectionMismatch.inc();
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("owner bay timed out")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs fn over items with at most `parallel` in flight; keeps every result. */
async function settleAll<I, T>(
  items: I[],
  parallel: number,
  fn: (item: I) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(parallel, items.length) }, worker),
  );
  return results;
}

/** Test hook: how the home bay reaches an owner bay. */
export type OwnerBayCall = (
  bay_id: string,
  request: CatalogOwnedListRequest,
) => Promise<CatalogOwnedListReply>;

const callOwnerBay: OwnerBayCall = async (bay_id, request) =>
  bay_id === getConfiguredBayId()
    ? await listAccountOwnedControl(request)
    : await withTimeout(
        interBay(bay_id).listAccountOwned(request),
        ARTIFACT_CATALOG_LIST_BAY_TIMEOUT_MS,
      );

/** The home bay's part: build the filters, ask every owner bay, merge. */
export async function listAccountOnHomeBay(
  request: ValidListRequest,
  call: OwnerBayCall = callOwnerBay,
): Promise<CatalogAccountPage> {
  const { account_id, limit, query, view } = request;
  await assertArtifactCatalogReaderNotBanned(account_id);
  const home = getConfiguredBayId();
  const bays = await projectedBays(account_id, home);
  const pattern = query ? artifactCatalogLikePattern(query) : undefined;
  const mine =
    view === "mine"
      ? await namedAgentThreads(account_id, { project_id: request.project_id })
      : undefined;
  const names = pattern
    ? await namedAgentThreads(account_id, {
        project_id: request.project_id,
        pattern,
      })
    : undefined;
  const aliases = pattern ? await aliasTargets(account_id, pattern) : undefined;
  const owned: CatalogOwnedListRequest = {
    account_id,
    limit,
    ...(request.before ? { before: request.before } : {}),
    ...(request.project_id ? { project_id: request.project_id } : {}),
    view,
    ...(mine ? { mine: mine.filter } : {}),
    ...(query
      ? {
          query,
          name_hits: names!.filter,
          alias_hits: aliases!.filter,
          library_name_hit: LIBRARY_AGENT_NAME.includes(query.toLowerCase()),
        }
      : {}),
    versions: request.versions,
  };
  const bayIds = [...bays.keys()].sort();
  const replies = await settleAll(
    bayIds,
    ARTIFACT_CATALOG_LIST_BAY_PARALLELISM,
    (bay_id) => call(bay_id, owned),
  );

  const candidates: {
    entry: CatalogEntry;
    key: string;
    parsed: { created_ms: number; entry_id: string };
  }[] = [];
  const seen = new Set<string>();
  const versions: Record<string, CatalogProjectVersion> = {};
  let more = false;
  let unavailable = 0,
    tooMany = 0,
    notReady = 0;
  replies.forEach((result, i) => {
    const reply = result.status === "fulfilled" ? result.value : undefined;
    let parsed: { created_ms: number; entry_id: string }[] = [];
    try {
      if (
        !reply ||
        !Array.isArray(reply.entries) ||
        !Array.isArray(reply.keys) ||
        reply.entries.length !== reply.keys.length ||
        reply.entries.length > limit
      )
        throw Error("malformed owner bay reply");
      parsed = reply.keys.map((key) => parseArtifactCatalogCursor(key)!);
      if (parsed.some((key, j) => key?.entry_id !== reply.entries[j].entry_id))
        throw Error("malformed owner bay reply");
    } catch {
      unavailable++;
      return;
    }
    const ok = reply as CatalogOwnedListReply;
    for (let j = 0; j < ok.entries.length; j++) {
      const entry = ok.entries[j];
      if (seen.has(entry.entry_id)) continue;
      seen.add(entry.entry_id);
      candidates.push({ entry, key: ok.keys[j], parsed: parsed[j] });
    }
    if (ok.more) more = true;
    if (request.versions && ok.versions) Object.assign(versions, ok.versions);
    tooMany += ok.too_many_projects ?? 0;
    notReady += ok.not_ready ?? 0;
    if (
      !request.project_id &&
      (bays.get(bayIds[i]) ?? 0) > 0 &&
      ok.authorized === 0
    )
      countProjectionMismatch();
  });
  candidates.sort((a, b) => compareArtifactCatalogKeys(a.parsed, b.parsed));
  const page = candidates.slice(0, limit);
  // More rows exist past this page when the merge dropped candidates, even if
  // no single bay had more of its own.
  const next =
    page.length > 0 && (candidates.length > limit || more)
      ? page[page.length - 1].key
      : undefined;
  const incomplete = {
    ...(tooMany ? { too_many_projects: tooMany } : {}),
    ...(unavailable ? { unavailable_bays: unavailable } : {}),
    ...(notReady ? { not_ready: notReady } : {}),
  };
  const limited = {
    ...(mine?.limited || names?.limited ? { named_agents: true as const } : {}),
    ...(aliases?.limited ? { aliases: true as const } : {}),
  };
  return {
    entries: page.map((c) => c.entry),
    ...(next ? { next } : {}),
    view,
    ...(request.versions ? { versions } : {}),
    ...(Object.keys(incomplete).length ? { incomplete } : {}),
    ...(Object.keys(limited).length ? { limited } : {}),
  };
}

/**
 * Trusted inter-bay entry on an owner bay. The bay authorizes from its own
 * project rows; the result is re-checked after the read with the same
 * predicate, so a project whose access was revoked meanwhile is dropped from
 * both the rows and the versions.
 */
export async function listAccountOwnedControl(
  opts: CatalogOwnedListRequest,
): Promise<CatalogOwnedListReply> {
  requireUuid(opts?.account_id, "account_id");
  const account_id = opts.account_id;
  await assertArtifactCatalogReaderNotBanned(account_id);
  const owning_bay_id = getConfiguredBayId();
  const result = await listArtifactCatalogForAccountLocal({
    account_id,
    owning_bay_id,
    limit: opts.limit,
    before: opts.before,
    project_id: opts.project_id,
    view: opts.view,
    mine: opts.mine,
    query: opts.query,
    name_hits: opts.name_hits,
    alias_hits: opts.alias_hits,
    library_name_hit: opts.library_name_hit,
    versions: opts.versions,
  });
  const allowed = await authorizedArtifactCatalogProjects(getPool(), {
    account_id,
    owning_bay_id,
    project_ids: result.scope,
  });
  const entries: CatalogEntry[] = [];
  const keys: string[] = [];
  result.entries.forEach((entry, i) => {
    if (!allowed.has(entry.project_id)) return;
    entries.push(entry);
    keys.push(result.keys[i]);
  });
  await assertArtifactCatalogReaderNotBanned(account_id);
  return {
    entries,
    keys,
    more: result.more,
    ...(result.versions
      ? {
          versions: Object.fromEntries(
            Object.entries(result.versions).filter(([project_id]) =>
              allowed.has(project_id),
            ),
          ),
        }
      : {}),
    authorized: result.authorized,
    too_many_projects: result.too_many_projects,
    not_ready: result.not_ready,
  };
}

// Versions are authoritative only once every catalog on this bay has one.
// Once complete it stays complete (new catalogs get a version when their
// first source registers), so a positive answer is cached longer.
const READY_TTL_MS = 60_000;
const NOT_READY_TTL_MS = 10_000;
let readiness: { ready: boolean; at: number } | undefined;

export function resetArtifactCatalogCapabilitiesForTests(): void {
  readiness = undefined;
}

export const capabilities: ArtifactCatalogApi["capabilities"] = async (
  opts,
) => {
  requireUuid(opts?.account_id, "account_id");
  const now = Date.now();
  if (
    !readiness ||
    now - readiness.at >= (readiness.ready ? READY_TTL_MS : NOT_READY_TTL_MS)
  ) {
    readiness = {
      ready:
        (await artifactCatalogStateBackfillRemaining(getConfiguredBayId())) ===
        0,
      at: now,
    };
  }
  return { list: readiness.ready ? 1 : 0, deltas: 0, hints: 0 };
};
