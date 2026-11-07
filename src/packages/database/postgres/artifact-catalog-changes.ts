/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Catalog deltas and the change-hint outbox, on the project-owning bay.
//
// listChanges returns, for one readable project, the current state of every
// entry changed in a range of the project's change sequence, so a reader can
// move its copy from one version to the next without reloading.
//
// The outbox delivers {project, epoch, seq} hints (no metadata) to readers
// with a live browser session. One delivery target per project is retained
// across failed attempts; every owner operation is a compare-and-swap on the
// claim's token and target, so a stale or taken-over claim changes nothing.

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import type { CatalogEntry } from "@cocalc/conat/hub/api/artifact-catalog";
import { isValidUUID } from "@cocalc/util/misc";
import { liveOnBay } from "./artifact-catalog";
import {
  ARTIFACT_CATALOG_NOT_PERMITTED,
  ARTIFACT_CATALOG_READ_GROUPS,
  authorizedArtifactCatalogProjects,
} from "./artifact-catalog-read";

type Queryable = Pick<PoolClient, "query">;

export const ARTIFACT_CATALOG_CHANGES_MAX_IDS = 500;
export const ARTIFACT_CATALOG_CHANGES_MAX_BYTES = 1024 * 1024;
export const ARTIFACT_CATALOG_CHANGES_TIMEOUT_MS = 3000;
export const ARTIFACT_CATALOG_CHANGE_RANGE_INVALID =
  "invalid catalog change range";

const ENTRY_ID = /^[a-f0-9]{64}$/;

export interface CatalogChangesRequest {
  project_id: string;
  from: { epoch: string; seq: number };
  through_seq?: number;
  after_entry?: string;
}

export type CatalogChangesReply =
  | { reset: true; current?: { epoch: string; seq: number } }
  | {
      from_seq: number;
      through_seq: number;
      current: { epoch: string; seq: number };
      upserts: CatalogEntry[];
      removes: string[];
      next_entry?: string;
    };

const safeSeq = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/**
 * Validation that does not depend on the project (so it reveals nothing):
 * formats, from.seq <= through_seq, and after_entry only with through_seq.
 */
export function validateArtifactCatalogChangesRequest(
  opts: unknown,
): CatalogChangesRequest {
  const o = (opts ?? {}) as any;
  const valid =
    typeof o.project_id === "string" &&
    isValidUUID(o.project_id) &&
    o.from != null &&
    typeof o.from.epoch === "string" &&
    isValidUUID(o.from.epoch) &&
    safeSeq(o.from.seq) &&
    (o.through_seq === undefined ||
      (safeSeq(o.through_seq) && o.through_seq >= o.from.seq)) &&
    (o.after_entry === undefined ||
      (typeof o.after_entry === "string" &&
        ENTRY_ID.test(o.after_entry) &&
        o.through_seq !== undefined));
  if (!valid) throw Error("invalid catalog change request");
  return {
    project_id: o.project_id,
    from: { epoch: o.from.epoch, seq: o.from.seq },
    ...(o.through_seq !== undefined ? { through_seq: o.through_seq } : {}),
    ...(o.after_entry !== undefined ? { after_entry: o.after_entry } : {}),
  };
}

const utf8 = (value: string) => Buffer.byteLength(value, "utf8");

/**
 * One page of changes for a readable project. Authorization comes first,
 * before anything that depends on the project (no seq or epoch oracle). The
 * caller re-checks access after the read and checks bans.
 */
export async function readArtifactCatalogChangesForAccount(opts: {
  account_id: string;
  owning_bay_id: string;
  request: unknown;
}): Promise<CatalogChangesReply> {
  const request = validateArtifactCatalogChangesRequest(opts.request);
  const db = await getPool().connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await db.query(
      `SET LOCAL statement_timeout = ${ARTIFACT_CATALOG_CHANGES_TIMEOUT_MS}`,
    );
    const reply = await readChanges(db, opts, request);
    await db.query("COMMIT");
    return reply;
  } catch (err) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    db.release();
  }
}

async function readChanges(
  db: Queryable,
  opts: { account_id: string; owning_bay_id: string },
  request: CatalogChangesRequest,
): Promise<CatalogChangesReply> {
  const { project_id, from } = request;
  const allowed = await authorizedArtifactCatalogProjects(db, {
    account_id: opts.account_id,
    owning_bay_id: opts.owning_bay_id,
    project_ids: [project_id],
  });
  if (!allowed.has(project_id)) throw Error(ARTIFACT_CATALOG_NOT_PERMITTED);
  const state = (
    await db.query(
      `SELECT epoch,seq,retention_floor_seq FROM artifact_catalog_project_state
       WHERE project_id=$1`,
      [project_id],
    )
  ).rows[0];
  if (!state) return { reset: true };
  const current = { epoch: state.epoch as string, seq: Number(state.seq) };
  if (
    from.epoch !== current.epoch ||
    from.seq < Number(state.retention_floor_seq) ||
    from.seq > current.seq
  )
    return { reset: true, current };
  const through = request.through_seq ?? current.seq;
  if (through > current.seq) throw Error(ARTIFACT_CATALOG_CHANGE_RANGE_INVALID);
  const reset = await db.query(
    `SELECT 1 FROM artifact_catalog_changes
     WHERE project_id=$1 AND seq>$2 AND seq<=$3 AND op='reset' LIMIT 1`,
    [project_id, from.seq, through],
  );
  if (reset.rows.length) return { reset: true, current };
  const { rows: changed } = await db.query(
    `SELECT DISTINCT entry_id FROM artifact_catalog_changes
     WHERE project_id=$1 AND seq>$2 AND seq<=$3 AND op<>'reset'
       AND entry_id>$4
     ORDER BY entry_id LIMIT $5`,
    [
      project_id,
      from.seq,
      through,
      request.after_entry ?? "",
      ARTIFACT_CATALOG_CHANGES_MAX_IDS + 1,
    ],
  );
  const ids = changed
    .slice(0, ARTIFACT_CATALOG_CHANGES_MAX_IDS)
    .map((row) => row.entry_id as string);
  const { rows: present } = ids.length
    ? await db.query(
        `SELECT c.entry_id,s.chat_path,c.metadata
         FROM artifact_catalog c
         JOIN artifact_catalog_sources s ON s.source_id=c.source_id
         WHERE c.project_id=$1 AND c.entry_id=ANY($2::text[]) AND NOT c.deleted`,
        [project_id, ids],
      )
    : { rows: [] as any[] };
  const byId = new Map(present.map((row) => [row.entry_id as string, row]));
  const upserts: CatalogEntry[] = [];
  const removes: string[] = [];
  let bytes = 0;
  let last: string | undefined;
  let stopped = false;
  for (const entry_id of ids) {
    const row = byId.get(entry_id);
    const entry: CatalogEntry | undefined = row
      ? {
          entry_id,
          project_id,
          chat_path: row.chat_path,
          item: row.metadata,
        }
      : undefined;
    const size = entry ? utf8(JSON.stringify(entry)) : utf8(entry_id) + 3;
    // Always at least one entry, so the cursor advances.
    if (
      last !== undefined &&
      bytes + size > ARTIFACT_CATALOG_CHANGES_MAX_BYTES
    ) {
      stopped = true;
      break;
    }
    bytes += size;
    if (entry) upserts.push(entry);
    else removes.push(entry_id);
    last = entry_id;
  }
  const more = stopped || changed.length > ARTIFACT_CATALOG_CHANGES_MAX_IDS;
  return {
    from_seq: from.seq,
    through_seq: through,
    current,
    upserts,
    removes,
    ...(more && last !== undefined ? { next_entry: last } : {}),
  };
}

// --- the hint outbox (rev6: retained target, fresh token per claim) ---

export const ARTIFACT_CATALOG_HINT_MAX_ATTEMPTS = 5;
export const ARTIFACT_CATALOG_HINT_LEASE_SECONDS = 60;

/** Projects on this bay that owe a hint and can be claimed now. */
export async function artifactCatalogHintsDue({
  owning_bay_id,
  limit = 100,
}: {
  owning_bay_id: string;
  limit?: number;
}): Promise<string[]> {
  const { rows } = await getPool().query(
    `SELECT st.project_id FROM artifact_catalog_project_state st
     JOIN projects p ON p.project_id=st.project_id
     WHERE st.published_seq IS NOT NULL
       AND (st.target_seq IS NOT NULL OR st.seq > st.published_seq)
       AND (st.claim_token IS NULL OR st.claim_expires_at < now())
       AND (st.retry_at IS NULL OR st.retry_at <= now())
       AND ${liveOnBay("p", "$1")}
     ORDER BY st.project_id LIMIT $2`,
    [owning_bay_id, limit],
  );
  return rows.map((row) => row.project_id as string);
}

export interface ArtifactCatalogHintClaim {
  project_id: string;
  token: string;
  target_seq: number;
  epoch: string;
  attempts: number;
}

/**
 * Claims a project's delivery: opens a target at the current seq, or retries
 * the retained one. Taking over an expired, unreleased claim counts as a
 * failed attempt. One autocommit statement; no lock is held afterwards.
 */
export async function claimArtifactCatalogHint(
  project_id: string,
  token: string = randomUUID(),
): Promise<ArtifactCatalogHintClaim | null> {
  const { rows } = await getPool().query(
    `UPDATE artifact_catalog_project_state
        SET claim_token = $2,
            target_seq = COALESCE(target_seq, seq),
            attempts = CASE
              WHEN target_seq IS NULL THEN 0
              WHEN claim_token IS NOT NULL THEN attempts + 1
              ELSE attempts END,
            claim_expires_at = now() + make_interval(secs => $3)
      WHERE project_id = $1
        AND published_seq IS NOT NULL
        AND (target_seq IS NOT NULL OR seq > published_seq)
        AND (claim_token IS NULL OR claim_expires_at < now())
        AND (retry_at IS NULL OR retry_at <= now())
      RETURNING target_seq, epoch, attempts`,
    [project_id, token, ARTIFACT_CATALOG_HINT_LEASE_SECONDS],
  );
  const row = rows[0];
  return row
    ? {
        project_id,
        token,
        target_seq: Number(row.target_seq),
        epoch: row.epoch,
        attempts: Number(row.attempts),
      }
    : null;
}

const CAS = "project_id=$1 AND claim_token=$2 AND target_seq=$3";

/** Extends the claim; false means it was lost (stop publishing). */
export async function renewArtifactCatalogHint(
  claim: ArtifactCatalogHintClaim,
): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE artifact_catalog_project_state
     SET claim_expires_at = now() + make_interval(secs => $4) WHERE ${CAS}`,
    [
      claim.project_id,
      claim.token,
      claim.target_seq,
      ARTIFACT_CATALOG_HINT_LEASE_SECONDS,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Delivered (or given up on): advance to the target and close it. */
export async function completeArtifactCatalogHint(
  claim: ArtifactCatalogHintClaim,
): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE artifact_catalog_project_state
     SET published_seq = GREATEST(published_seq, target_seq), target_seq = NULL,
         attempts = 0, retry_at = NULL, claim_token = NULL,
         claim_expires_at = NULL
     WHERE ${CAS}`,
    [claim.project_id, claim.token, claim.target_seq],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Not delivered: keep the target, count the attempt, retry later. */
export async function failArtifactCatalogHint(
  claim: ArtifactCatalogHintClaim,
  backoffMs: number,
): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE artifact_catalog_project_state
     SET attempts = attempts + 1,
         retry_at = now() + make_interval(secs => $4),
         claim_token = NULL, claim_expires_at = NULL
     WHERE ${CAS}`,
    [claim.project_id, claim.token, claim.target_seq, backoffMs / 1000],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * The candidates (accounts with a live session) who may read the project on
 * this bay: owner or collaborator of a live project. Bans are the caller's
 * (cached account security state, as for every read).
 */
export async function artifactCatalogHintRecipients(opts: {
  project_id: string;
  owning_bay_id: string;
  candidates: string[];
}): Promise<string[]> {
  if (opts.candidates.length === 0) return [];
  const { rows } = await getPool().query(
    `SELECT member.account_id FROM projects p
     CROSS JOIN LATERAL jsonb_each(p.users) AS member(account_id, info)
     WHERE p.project_id=$1 AND ${liveOnBay("p", "$2")}
       AND member.account_id = ANY($3::text[])
       AND member.info->>'group' = ANY($4::text[])`,
    [
      opts.project_id,
      opts.owning_bay_id,
      opts.candidates,
      ARTIFACT_CATALOG_READ_GROUPS,
    ],
  );
  return rows.map((row) => row.account_id as string);
}
