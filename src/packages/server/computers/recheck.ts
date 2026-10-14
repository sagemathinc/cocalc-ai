/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Project ineligibility reaches running work: the home bay re-checks, at the
// project's bay, every project a computer may still be doing work for, and
// raises that project's floor in the computer's signed state when it is no
// longer eligible (or was hard-deleted).
// Design: src/.agents/computers-revocation-gate-2026-10-14.md (§5, §6).
//
// - The ticket transaction records the project as possibly active until
//   its ticket's start_by plus the operation's longest life plus clock skew
//   (a job: open-ended until computer->hub reports exist, gate 3). Under the
//   per-computer ticket lock, safely expired pairs are dropped first, and a
//   project outside the set is refused while it has 500 entries, so a
//   snapshot never carries more than 500 project floors.
// - A due-work queue: hubs claim due rows (SKIP LOCKED) one window of 8 at
//   a time and re-check them in parallel, each within one deadline that
//   every inter-bay call it makes inherits as its own timeout (so nothing
//   outlives the claim's lease); again 30 s after a success, later with
//   backoff after a failure.
// - An attestation at epoch e raises the floor to e, eligible or not: an
//   ineligible one means no ticket at e was ever valid, and an eligible one
//   at a newer epoch means the project changed since older tickets (a
//   collaborator added and removed, a delete and undelete, between two
//   re-checks). Only a verified, signed hard-delete tombstone raises the
//   terminal floor; an unknown owner, a missing row or a routing failure
//   only retries.

import getPool from "@cocalc/database/pool";
import type { KeyObject } from "node:crypto";
import { randomBytes } from "node:crypto";
import { Gauge, register } from "prom-client";
import getLogger from "@cocalc/backend/logger";
import {
  MAX_STATE_PROJECT_FLOORS,
  parseProjectAttestation,
  parseProjectDeleted,
  parseSignedEnvelope,
  SIGNED_KINDS,
  TERMINAL_PRIVACY_EPOCH,
  type ProjectAttestation,
  type ProjectDeleted,
  type SignedEnvelope,
} from "@cocalc/util/computers/protocol";
import type { InterBayComputersApi } from "@cocalc/conat/inter-bay/computers";
import { verifyEnvelope } from "@cocalc/backend/computers/crypto";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  getConfiguredClusterBayIdsForStaticEnumerationOnly,
  getConfiguredClusterId,
} from "@cocalc/server/cluster-config";
import { resolveProjectBayDirect } from "@cocalc/server/inter-bay/directory";
import { createInterBayDirectoryClient } from "@cocalc/conat/inter-bay/api";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { assertComputersAuthority, type Queryable } from "./authority";
import { kickComputerStateDelivery } from "./delivery";
import { keyMap, listSigningKeyDirectory } from "./signing-keys";
import { computersSite } from "./site";
import { bumpComputerState } from "./state";

const logger = getLogger("server:computers:recheck");

/** At most this many projects a computer may be serving at once. */
export const MAX_ACTIVE_PROJECTS = MAX_STATE_PROJECT_FLOORS;
/** Clock skew allowed between the hub and a computer. */
export const SKEW_MS = 5 * 60 * 1000;
export const RECHECK_EVERY_MS = 30_000;
/** One re-check, every call it makes included. */
export const RECHECK_DEADLINE_MS = 20_000;
/** Re-checks in flight per hub process, and so rows per claim. */
const MAX_IN_FLIGHT = 8;
/** A claim's lease: its whole window runs in parallel within one deadline. */
const LEASE_MS = 3 * RECHECK_DEADLINE_MS;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
/** The cluster-wide tombstone lookup runs at most this often per project. */
const FANOUT_MIN_INTERVAL_MS = 5 * 60 * 1000;
const POLL_MS = 2_000;
const QUEUE_AGE_ALERT_MS = 5 * 60 * 1000;

const HUB = randomBytes(12).toString("base64url");

export class ActiveProjectsError extends Error {}

/**
 * In the ticket transaction, holding the per-computer ticket lock: drop
 * safely expired pairs, enforce the bound, and record the project as
 * possibly active (never shortening what an earlier ticket allowed).
 */
export async function admitActiveProject(
  db: Queryable,
  t: {
    computer_id: string;
    account_id: string;
    project_id: string;
    /** null: a job (open-ended until reports exist). */
    possibly_active_until: number | null;
    start_by: number;
    attesting_bay_id: string;
    now: number;
  },
): Promise<void> {
  await dropExpired(db, t.computer_id);
  const { rows } = await db.query(
    `SELECT count(*)::int AS n,
            bool_or(project_id=$2) AS present
       FROM account_computer_active_projects WHERE computer_id=$1`,
    [t.computer_id, t.project_id],
  );
  if (!rows[0].present && rows[0].n >= MAX_ACTIVE_PROJECTS) {
    throw new ActiveProjectsError(
      "this computer is serving too many projects at once; try again later",
    );
  }
  await db.query(
    `INSERT INTO account_computer_active_projects AS a
       (computer_id, project_id, account_id, possibly_active_until,
        last_start_by, last_attesting_bay_id, next_check_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (computer_id, project_id) DO UPDATE SET
       possibly_active_until = CASE
         WHEN a.possibly_active_until IS NULL
           OR EXCLUDED.possibly_active_until IS NULL THEN NULL
         ELSE GREATEST(a.possibly_active_until, EXCLUDED.possibly_active_until)
       END,
       last_start_by = GREATEST(a.last_start_by, EXCLUDED.last_start_by),
       last_attesting_bay_id = EXCLUDED.last_attesting_bay_id,
       -- A fresh, attested ticket: re-check on the normal schedule again,
       -- however far a run of failures had backed it off (a claim in
       -- progress keeps its lease).
       next_check_at = LEAST(a.next_check_at, EXCLUDED.next_check_at),
       attempts = 0,
       last_error = NULL`,
    [
      t.computer_id,
      t.project_id,
      t.account_id,
      t.possibly_active_until == null
        ? null
        : new Date(t.possibly_active_until),
      new Date(t.start_by),
      t.attesting_bay_id,
      new Date(t.now + RECHECK_EVERY_MS),
    ],
  );
}

/**
 * Pairs past both their possibly-active time and their last start_by: no
 * job, stream or admissible ticket of that project can remain on that
 * computer, so neither the row nor its floor has anything left to stop.
 * (The daemon's own floors only grow; that is harmless.)
 */
export async function dropExpired(
  db: Queryable,
  computer_id?: string,
): Promise<void> {
  const { rows } = await db.query(
    `DELETE FROM account_computer_active_projects
      WHERE ($1::uuid IS NULL OR computer_id=$1)
        AND possibly_active_until IS NOT NULL
        AND possibly_active_until < now() AND last_start_by < now()
      RETURNING computer_id, project_id`,
    [computer_id ?? null],
  );
  for (const r of rows) {
    await db.query(
      `DELETE FROM account_computer_project_floors
        WHERE computer_id=$1 AND project_id=$2`,
      [r.computer_id, r.project_id],
    );
  }
}

/**
 * Raise a project's floor on a computer (never lower it), and bump the
 * computer's state so every session gets it.
 */
export async function raiseProjectFloor({
  account_id,
  computer_id,
  project_id,
  privacy_epoch,
}: {
  account_id: string;
  computer_id: string;
  project_id: string;
  privacy_epoch: number;
}): Promise<boolean> {
  // A floor of 0 stops nothing.
  if (privacy_epoch <= 0) return false;
  const db = await getPool().connect();
  let raised = false;
  try {
    await db.query("BEGIN");
    await assertComputersAuthority(db, account_id, "raise a project floor");
    const computer = await db.query(
      `SELECT 1 FROM account_computers WHERE computer_id=$1 AND account_id=$2
        FOR UPDATE`,
      [computer_id, account_id],
    );
    if (computer.rows.length > 0) {
      const { rows } = await db.query(
        `INSERT INTO account_computer_project_floors AS f
           (computer_id, project_id, account_id, privacy_epoch, updated_at)
         VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (computer_id, project_id) DO UPDATE
           SET privacy_epoch=EXCLUDED.privacy_epoch, updated_at=now()
           WHERE f.privacy_epoch < EXCLUDED.privacy_epoch
         RETURNING project_id`,
        [computer_id, project_id, account_id, privacy_epoch],
      );
      raised = rows.length > 0;
      if (raised) await bumpComputerState(db, [computer_id]);
    }
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    db.release();
  }
  if (raised) void kickComputerStateDelivery();
  return raised;
}

interface Due {
  computer_id: string;
  project_id: string;
  account_id: string;
  last_attesting_bay_id: string;
  attempts: number;
}

/** How a re-check came out. */
export type RecheckOutcome =
  | { kind: "eligible"; bay_id: string; privacy_epoch: number }
  | { kind: "ineligible"; bay_id: string; privacy_epoch: number }
  | { kind: "deleted"; bay_id: string }
  /** minWaitMs: after a cluster-wide lookup, the next is minutes away. */
  | { kind: "retry"; reason: string; minWaitMs?: number };

/**
 * What the re-check needs from the cluster (tests replace it). Each call
 * gets timeoutMs and must end by then: it is the call's own timeout, so no
 * call outlives its re-check.
 */
export interface RecheckDeps {
  resolveOwner(project_id: string, timeoutMs: number): Promise<string | null>;
  atBay(
    bay_id: string,
    timeoutMs: number,
  ): Pick<InterBayComputersApi, "recheckProject" | "projectHardDeleteEvidence">;
  configuredBays(): string[];
}

let deps: RecheckDeps | undefined;
let deadlineMs = RECHECK_DEADLINE_MS;

async function defaultDeps(): Promise<RecheckDeps> {
  const { computersAtBay } = await import("./routing");
  return {
    resolveOwner: async (project_id, timeout) =>
      (
        (await resolveProjectBayDirect(project_id)) ??
        (await createInterBayDirectoryClient({
          client: getInterBayFabricClient(),
          timeout,
        }).resolveProjectBay({ project_id }))
      )?.bay_id ?? null,
    atBay: (bay_id, timeout) => computersAtBay(bay_id, { timeout }),
    configuredBays: () => {
      const bays = getConfiguredClusterBayIdsForStaticEnumerationOnly();
      return bays.length > 0 ? bays : [getConfiguredBayId()];
    },
  };
}

/** Tests: the deps in use. */
export function __depsForTesting(): RecheckDeps | undefined {
  return deps;
}

/** Tests: replace how the cluster is asked, and the deadline. */
export function setRecheckDepsForTesting(
  d: RecheckDeps | undefined,
  deadline?: number,
): void {
  deps = d;
  deadlineMs = deadline ?? RECHECK_DEADLINE_MS;
}

/**
 * One pass: drop expired pairs, then claim one window of due rows at a time
 * and re-check it in parallel, until none are due. Returns how many rows
 * were re-checked.
 */
export async function recheckDueProjects(): Promise<number> {
  await dropExpired(getPool());
  await recordQueueAge();
  const d = deps ?? (await defaultDeps());
  let total = 0;
  for (;;) {
    const due = await claimDue();
    await Promise.all(
      due.map((row) =>
        recheckOne(row, d).catch((err) =>
          logger.warn("re-checking a project failed", err),
        ),
      ),
    );
    total += due.length;
    if (due.length < MAX_IN_FLIGHT) return total;
  }
}

async function claimDue(): Promise<Due[]> {
  const { rows } = await getPool().query(
    `WITH due AS (
       SELECT computer_id, project_id FROM account_computer_active_projects
        WHERE next_check_at <= now()
          AND (lease_until IS NULL OR lease_until < now())
        ORDER BY next_check_at LIMIT $1
        FOR UPDATE SKIP LOCKED)
     UPDATE account_computer_active_projects a
        SET lease_until=now() + make_interval(secs => $2::float8 / 1000),
            claimed_by_hub=$3
       FROM due
      WHERE a.computer_id=due.computer_id AND a.project_id=due.project_id
      RETURNING a.computer_id, a.project_id, a.account_id,
                a.last_attesting_bay_id, a.attempts`,
    [MAX_IN_FLIGHT, LEASE_MS, HUB],
  );
  return rows.map((r) => ({ ...r, attempts: Number(r.attempts) }));
}

async function recheckOne(row: Due, d: RecheckDeps): Promise<void> {
  let outcome: RecheckOutcome;
  try {
    outcome = await determine(row, d, Date.now() + deadlineMs);
  } catch (err) {
    outcome = { kind: "retry", reason: `${(err as Error)?.message ?? err}` };
  }
  if (outcome.kind !== "retry") {
    await raiseProjectFloor({
      account_id: row.account_id,
      computer_id: row.computer_id,
      project_id: row.project_id,
      privacy_epoch:
        outcome.kind === "deleted"
          ? TERMINAL_PRIVACY_EPOCH
          : outcome.privacy_epoch,
    });
  }
  if (outcome.kind === "retry") {
    const wait = Math.max(
      outcome.minWaitMs ?? 0,
      Math.min(
        MAX_BACKOFF_MS,
        RECHECK_EVERY_MS * 2 ** Math.min(row.attempts, 10),
      ),
    );
    await getPool().query(
      `UPDATE account_computer_active_projects
          SET next_check_at=now() + make_interval(secs => $3::float8 / 1000),
              attempts=attempts+1, last_error=$4, lease_until=NULL,
              claimed_by_hub=NULL
        WHERE computer_id=$1 AND project_id=$2 AND claimed_by_hub=$5`,
      [
        row.computer_id,
        row.project_id,
        wait,
        outcome.reason.slice(0, 300),
        HUB,
      ],
    );
    return;
  }
  await getPool().query(
    `UPDATE account_computer_active_projects
        SET next_check_at=now() + make_interval(secs => $3::float8 / 1000),
            attempts=0, last_error=NULL, lease_until=NULL,
            claimed_by_hub=NULL, last_attesting_bay_id=$4
      WHERE computer_id=$1 AND project_id=$2 AND claimed_by_hub=$5`,
    [
      row.computer_id,
      row.project_id,
      // A deleted project stays deleted: nothing more to learn.
      outcome.kind === "deleted" ? 24 * 60 * 60 * 1000 : RECHECK_EVERY_MS,
      outcome.bay_id,
      HUB,
    ],
  );
}

/**
 * Ask the owner; with no owner, the last attesting bay; then the cluster.
 * Everything by `deadline`: each call gets the time left as its own
 * timeout.
 */
export async function determine(
  row: Pick<
    Due,
    "project_id" | "account_id" | "last_attesting_bay_id" | "attempts"
  >,
  d: RecheckDeps,
  deadline: number,
): Promise<RecheckOutcome> {
  const left = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error("the re-check ran out of time");
    return ms;
  };
  const owner = await bounded(d.resolveOwner(row.project_id, left()), left());
  const bay = owner ?? row.last_attesting_bay_id;
  const answer = await bounded(
    d.atBay(bay, left()).recheckProject({
      project_id: row.project_id,
      account_id: row.account_id,
      home_bay_id: getConfiguredBayId(),
    }),
    left(),
  );
  if (answer.kind === "attestation") {
    const a = await verifiedAttestation(answer.attestation, row, bay);
    return {
      kind: a.eligible ? "eligible" : "ineligible",
      bay_id: bay,
      privacy_epoch: a.privacy_epoch,
    };
  }
  if (answer.kind === "deleted") {
    await verifiedDeleted(answer.evidence, row, bay);
    return { kind: "deleted", bay_id: bay };
  }
  if (owner != null) {
    // The directory names an owner that doesn't have it (a rehome in
    // progress, a stale entry): ask again later.
    return { kind: "retry", reason: "the project's bay doesn't know it yet" };
  }
  // No owner, and the last attesting bay doesn't know it: a rehome just
  // followed by a hard delete leaves the row naming the old bay. Ask the
  // configured cluster for a tombstone (then not again for minutes).
  const found = await resolveProjectHardDeleteEvidenceAcrossCluster(
    row,
    d,
    deadline,
  );
  if (found.kind === "deleted") {
    return { kind: "deleted", bay_id: found.bay_id };
  }
  return {
    kind: "retry",
    reason:
      found.kind === "retry" ? found.reason : "the project's owner is unknown",
    minWaitMs: FANOUT_MIN_INTERVAL_MS,
  };
}

/**
 * Ask every configured bay, over the authenticated inter-bay fabric, for
 * its durable hard-delete tombstone of this project. Patterned on the
 * configured-bay enumeration of resolveProjectBayAcrossCluster, but typed
 * on its own and never using that function's live result. Conservative:
 * "unknown" is inert; a malformed or forged answer fails closed (no
 * terminal floor) and raises an alert; a transport failure retries; only a
 * valid signed tombstone counts.
 */
export async function resolveProjectHardDeleteEvidenceAcrossCluster(
  row: Pick<Due, "project_id" | "account_id">,
  d: RecheckDeps,
  deadline: number,
): Promise<
  | { kind: "deleted"; bay_id: string }
  | { kind: "unknown" }
  | { kind: "retry"; reason: string }
> {
  let valid: string | undefined;
  let transport = false;
  let bad = false;
  // All bays at once, each call ending by the same deadline: a slow or
  // unreachable bay can't hide another bay's tombstone, and nothing is
  // left running afterwards.
  const ms = deadline - Date.now();
  if (ms <= 0) return { kind: "retry", reason: "the re-check ran out of time" };
  const bays = [...new Set(d.configuredBays().filter((b) => !!b))];
  const answers = await Promise.allSettled(
    bays.map((bay_id) =>
      bounded(
        d.atBay(bay_id, ms).projectHardDeleteEvidence({
          project_id: row.project_id,
          account_id: row.account_id,
        }),
        ms,
      ),
    ),
  );
  for (let i = 0; i < bays.length; i++) {
    const bay_id = bays[i];
    const settled = answers[i];
    if (settled.status === "rejected") {
      transport = true;
      continue;
    }
    const answer = settled.value as
      | { kind?: unknown; evidence?: unknown }
      | undefined;
    if (answer?.kind === "unknown") continue;
    if (answer?.kind !== "deleted") {
      bad = true;
      logger.error("a bay answered a tombstone lookup with nonsense", {
        bay_id,
        project_id: row.project_id,
      });
      continue;
    }
    try {
      await verifiedDeleted(answer.evidence, row, bay_id);
      valid ??= bay_id;
    } catch (err) {
      bad = true;
      logger.error("a bay sent a hard-delete tombstone that doesn't verify", {
        bay_id,
        project_id: row.project_id,
        err: `${err}`,
      });
    }
  }
  if (bad) {
    return { kind: "retry", reason: "inconsistent hard-delete evidence" };
  }
  if (valid != null) return { kind: "deleted", bay_id: valid };
  if (transport) return { kind: "retry", reason: "a bay was unreachable" };
  return { kind: "unknown" };
}

async function trustedKey(
  kid: string,
  bay_id: string,
): Promise<KeyObject | undefined> {
  const directory = await listSigningKeyDirectory();
  const entry = directory.find((k) => k.kid === kid);
  if (entry == null || entry.bay_id !== bay_id) return undefined;
  return keyMap([entry]).get(kid);
}

/** A signed attestation, by that bay, for this project, account and home. */
async function verifiedAttestation(
  input: unknown,
  row: Pick<Due, "project_id" | "account_id">,
  bay_id: string,
): Promise<ProjectAttestation> {
  const env: SignedEnvelope<ProjectAttestation> = parseSignedEnvelope(
    input,
    parseProjectAttestation,
    "attestation",
  );
  const key = await trustedKey(env.kid, bay_id);
  const a = env.payload;
  if (
    key == null ||
    !verifyEnvelope(SIGNED_KINDS.attestation, env, (kid) =>
      kid === env.kid ? key : undefined,
    ) ||
    a.project_id !== row.project_id ||
    a.account_id !== row.account_id ||
    a.project_bay_id !== bay_id ||
    a.home_bay_id !== getConfiguredBayId() ||
    a.site !== (await computersSite()) ||
    a.cluster_id !== getConfiguredClusterId()
  ) {
    throw new Error(
      "the project's bay sent an attestation that doesn't verify",
    );
  }
  return a;
}

/** A signed tombstone, by that bay, for this project and account. */
async function verifiedDeleted(
  input: unknown,
  row: Pick<Due, "project_id" | "account_id">,
  bay_id: string,
): Promise<ProjectDeleted> {
  const env: SignedEnvelope<ProjectDeleted> = parseSignedEnvelope(
    input,
    parseProjectDeleted,
    "project-deleted",
  );
  const key = await trustedKey(env.kid, bay_id);
  const p = env.payload;
  if (
    key == null ||
    !verifyEnvelope(SIGNED_KINDS.project_deleted, env, (kid) =>
      kid === env.kid ? key : undefined,
    ) ||
    p.project_id !== row.project_id ||
    p.account_id !== row.account_id ||
    p.project_bay_id !== bay_id ||
    p.site !== (await computersSite()) ||
    p.cluster_id !== getConfiguredClusterId()
  ) {
    throw new Error("a hard-delete tombstone doesn't verify");
  }
  return p;
}

/**
 * A call that was given `ms` as its own timeout, also bounded here (a guard
 * against a client that overruns it; the call itself ends by then).
 */
async function bounded<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("the project's bay did not answer in time")),
          ms + 1000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let queueAge: Gauge | undefined;
let lastAlert = 0;

/**
 * The age of the oldest due row: how far behind the re-checks are (an admin
 * alert above 5 minutes). Detection latency is documented, not promised:
 * due rows / (hubs x 8 / mean re-check time), plus delivery.
 */
export async function recheckQueueAgeMs(): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT EXTRACT(EPOCH FROM (now() - min(next_check_at))) * 1000 AS age
       FROM account_computer_active_projects
      WHERE next_check_at <= now()`,
  );
  return Math.max(0, Number(rows[0]?.age ?? 0));
}

async function recordQueueAge(): Promise<void> {
  const age = await recheckQueueAgeMs();
  queueAge ??=
    (register.getSingleMetric("cocalc_computers_recheck_queue_age_seconds") as
      | Gauge
      | undefined) ??
    new Gauge({
      name: "cocalc_computers_recheck_queue_age_seconds",
      help: "Age of the oldest due project re-check for connected computers",
    });
  queueAge.set(age / 1000);
  if (age > QUEUE_AGE_ALERT_MS && Date.now() - lastAlert > QUEUE_AGE_ALERT_MS) {
    lastAlert = Date.now();
    logger.error(
      "computers: project re-checks are more than 5 minutes behind",
      { age_ms: age },
    );
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;

/** Every hub process re-checks (claims never overlap). */
export function startProjectRecheck(): void {
  if (timer != null) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await recheckDueProjects();
    } catch (err) {
      logger.warn("project re-check pass failed", err);
    } finally {
      running = false;
    }
  }, POLL_MS);
  timer.unref?.();
}

export function stopProjectRecheck(): void {
  if (timer != null) clearInterval(timer);
  timer = undefined;
}
