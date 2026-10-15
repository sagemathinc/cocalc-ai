/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Delivery of a computer's signed state snapshot to each open session.
// Design: src/.agents/computers-revocation-gate-2026-10-14.md (§3, §4).
//
// 1. Claim due targets (SKIP LOCKED, a 30 s lease, a fresh attempt token and
//    the exact reply subject), then commit: no lock is held across I/O.
// 2. Publish the snapshot on the session's op subject and wait for the ack
//    on that reply subject (isComputerAllowed lets a session publish there,
//    and only there, while its claim lasts, even before it is ready or
//    after a bump made it stale).
// 3. An ok ack naming exactly the version and envelope hash sent finalizes
//    in one transaction, under the computer row lock, and only while the
//    computer is still at that version: the target (this exact attempt) is
//    deleted and the session becomes ready. Anything else just retries.
//
// Writes here touch only delivery bookkeeping (targets, ready_version), never
// computer state, so they take no rehome fence (a rehome is refused anyway
// while any computer state exists); they must still work for a deleted
// account, whose "ended" is exactly what is being delivered.

import { randomBytes } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import getLogger from "@cocalc/backend/logger";
import { canonicalHash } from "@cocalc/backend/computers/crypto";
import type { Client } from "@cocalc/conat/core/client";
import type { ReceiveLimits } from "@cocalc/conat/core/receive-budget";
import {
  COMPUTER_STATE_WAKE_SUBJECT,
  computerOpSubject,
  computerReplySubject,
  type ComputerOpMessage,
  type ComputerReplyMessage,
} from "@cocalc/conat/computers/subjects";
import { STATE_VERSION_PATTERN } from "@cocalc/util/computers/protocol";
import { HUB_PROCESS, hubClient } from "./relay";
import { computerStateSnapshot } from "./state";
import { FailureLog } from "./failure-log";

const logger = getLogger("server:computers:delivery");

/** How long a claimed attempt holds its target (and the receipt grace). */
export const DELIVERY_LEASE_MS = 30_000;
/** How long one attempt waits for the ack. */
export const DELIVERY_WAIT_MS = 10_000;
/**
 * Attempts in flight per hub process, and so targets per claim: a claim is
 * one window, all delivered at once, well within its lease (one attempt
 * takes at most DELIVERY_WAIT_MS plus a few queries).
 */
const MAX_IN_FLIGHT = 8;
/** Nobody subscribed yet (a session that just logged in): retry soon. */
const NO_SUBSCRIBER_RETRY_MS = 250;
const MAX_BACKOFF_MS = 60_000;

/** An ack is tiny; anything bigger is refused before reassembly. */
const ACK_RECEIVE_LIMITS: ReceiveLimits = {
  maxMessageBytes: 4096,
  maxInflightBytes: 4096,
  maxInflightMessages: 1,
  maxFragmentsPerMessage: 1,
};

interface Claimed {
  session_id: string;
  computer_id: string;
  generation: number;
  state_version: string;
  attempt_token: string;
  reply_subject: string;
  attempts: number;
}

let client: Client | undefined;
function deliveryClient(): Client {
  return client ?? hubClient();
}
let waitMs = DELIVERY_WAIT_MS;

/** Tests: the conat client used to publish. */
export function setDeliveryClientForTesting(c: Client | undefined): void {
  client = c;
}

/** Tests: how long an attempt waits for its ack. */
export function setDeliveryWaitForTesting(ms: number | undefined): void {
  waitMs = ms ?? DELIVERY_WAIT_MS;
}

/**
 * One pass: drop targets of sessions that ended, then claim and deliver
 * one window of due targets at a time until none are due. Returns how many
 * sessions became ready.
 */
export async function deliverDueStates(): Promise<number> {
  await dropClosedTargets();
  let ready = 0;
  for (;;) {
    const claimed = await claimDue();
    const results = await Promise.all(
      claimed.map((t) =>
        deliverOne(t).catch((err) => {
          targetErrors += 1;
          problems.failed(err);
          return false;
        }),
      ),
    );
    ready += results.filter((x) => x).length;
    if (claimed.length < MAX_IN_FLIGHT) return ready;
  }
}

/**
 * A target whose session closed or moved to another generation has no one
 * to deliver to: its daemon logs in again (and gets the snapshot first) or
 * is answered "ended" at the challenge.
 */
async function dropClosedTargets(): Promise<void> {
  await getPool().query(
    `DELETE FROM account_computer_session_targets t
      WHERE NOT EXISTS (
        SELECT 1 FROM account_computer_sessions s
         WHERE s.session_id = t.session_id AND s.closed_at IS NULL
           AND s.generation = t.generation)`,
  );
}

async function claimDue(): Promise<Claimed[]> {
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    const { rows } = await db.query(
      `SELECT session_id, computer_id, generation, state_version, attempts
         FROM account_computer_session_targets
        WHERE lease_until IS NULL OR lease_until < now()
        ORDER BY lease_until NULLS FIRST
        LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [MAX_IN_FLIGHT],
    );
    const claimed: Claimed[] = [];
    for (const r of rows) {
      const attempt_token = randomBytes(16).toString("base64url");
      const reply_subject = computerReplySubject(
        r.computer_id,
        r.session_id,
        HUB_PROCESS,
        attempt_token,
      );
      await db.query(
        `UPDATE account_computer_session_targets
            SET attempt_token=$2, claimed_by_hub=$3, reply_subject=$4,
                lease_until=now() + make_interval(secs => $5::float8 / 1000),
                attempts=attempts+1
          WHERE session_id=$1`,
        [
          r.session_id,
          attempt_token,
          HUB_PROCESS,
          reply_subject,
          DELIVERY_LEASE_MS,
        ],
      );
      claimed.push({
        session_id: r.session_id,
        computer_id: r.computer_id,
        generation: Number(r.generation),
        state_version: `${r.state_version}`,
        attempt_token,
        reply_subject,
        attempts: Number(r.attempts) + 1,
      });
    }
    await db.query("COMMIT");
    return claimed;
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

async function deliverOne(t: Claimed): Promise<boolean> {
  const snapshot = await computerStateSnapshot(t.computer_id);
  if (snapshot == null) {
    // No such computer, or its certificate's key is gone (so the
    // certificate has expired and the daemon has ended itself).
    await getPool().query(
      `DELETE FROM account_computer_session_targets
        WHERE session_id=$1 AND attempt_token=$2`,
      [t.session_id, t.attempt_token],
    );
    return false;
  }
  const envelope_hash = canonicalHash(snapshot.envelope);
  const cn = deliveryClient();
  let ack: unknown;
  const sub = await cn.subscribe(t.reply_subject, {
    receiveLimits: ACK_RECEIVE_LIMITS,
  });
  try {
    const op: ComputerOpMessage = {
      v: 1,
      correlation: t.attempt_token,
      reply_subject: t.reply_subject,
      hub_now: Date.now(),
      push: { state: snapshot.envelope },
    };
    const { count } = await cn.publish(
      computerOpSubject(t.computer_id, t.session_id),
      op,
    );
    if (count === 0) {
      await release(t, "no subscriber yet", NO_SUBSCRIBER_RETRY_MS);
      return false;
    }
    ack = await firstAck(sub, t.attempt_token);
  } finally {
    sub.close();
  }
  if (ack === undefined) {
    await release(t, "no acknowledgement", backoff(t.attempts));
    return false;
  }
  const a = ack as any;
  if (
    a == null ||
    typeof a !== "object" ||
    a.ok !== true ||
    typeof a.state_version !== "string" ||
    !STATE_VERSION_PATTERN.test(a.state_version) ||
    a.state_version !== snapshot.state_version ||
    a.envelope_hash !== envelope_hash
  ) {
    const error =
      a?.ok === false && typeof a.error === "string"
        ? a.error.slice(0, 300)
        : "an acknowledgement that doesn't match what was sent";
    await release(t, error, backoff(t.attempts));
    return false;
  }
  return await finalize(t, snapshot.state_version);
}

async function firstAck(
  sub: AsyncIterable<any> & { close: () => void },
  correlation: string,
): Promise<unknown | undefined> {
  const timer = setTimeout(() => sub.close(), waitMs);
  try {
    for await (const mesg of sub) {
      let data: ComputerReplyMessage | undefined;
      try {
        data = mesg.data;
      } catch {
        continue;
      }
      if (data?.v !== 1 || data.correlation !== correlation) continue;
      return data.reply;
    }
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Promotion: one transaction with the computer row locked. Only while the
 * computer is still at the acked version, the exact attempt's target is
 * deleted and its session becomes ready; otherwise nothing changes and the
 * newer target stays pending.
 */
export async function finalize(
  t: Pick<
    Claimed,
    "computer_id" | "session_id" | "generation" | "attempt_token"
  >,
  acked: string,
): Promise<boolean> {
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    const current = (
      await db.query(
        `SELECT state_version FROM account_computers
          WHERE computer_id=$1 FOR UPDATE`,
        [t.computer_id],
      )
    ).rows[0];
    if (current == null || `${current.state_version}` !== acked) {
      await db.query("COMMIT");
      return false;
    }
    const done = await db.query(
      `DELETE FROM account_computer_session_targets
        WHERE session_id=$1 AND computer_id=$2 AND generation=$3
          AND attempt_token=$4 AND state_version <= $5
        RETURNING session_id`,
      [t.session_id, t.computer_id, t.generation, t.attempt_token, acked],
    );
    if (done.rows.length === 0) {
      await db.query("COMMIT");
      return false;
    }
    const ready = await db.query(
      `UPDATE account_computer_sessions SET ready_version=$3
        WHERE session_id=$1 AND generation=$2 AND closed_at IS NULL
        RETURNING session_id`,
      [t.session_id, t.generation, acked],
    );
    await db.query("COMMIT");
    return ready.rows.length > 0;
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

/** Give up this attempt (only if it is still ours) and retry later. */
async function release(t: Claimed, error: string, retryMs: number) {
  await getPool().query(
    `UPDATE account_computer_session_targets
        SET attempt_token=NULL, claimed_by_hub=NULL, reply_subject=NULL,
            lease_until=now() + make_interval(secs => $3::float8 / 1000),
            last_error=$4
      WHERE session_id=$1 AND attempt_token=$2`,
    [t.session_id, t.attempt_token, retryMs, error],
  );
}

function backoff(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempts, 16));
}

/** Nothing owed: look again this often anyway (a lost wake costs at most this). */
export const IDLE_POLL_MS = 30_000;
/** The soonest a pass follows one that left a retry due. */
export const MIN_POLL_MS = 250;
/** After a failed pass (the database is away): 1 s, 2 s, ... up to this. */
export const MAX_ERROR_BACKOFF_MS = 30_000;
/** The first pass after a hub starts (sessions owed state from before). */
const FIRST_POLL_MS = 1_000;

/**
 * When the next pass runs: soon after a failure (backing off), when the
 * earliest owed target is due, and otherwise at the idle poll.
 */
export function nextPassDelay({
  enabled,
  failures,
  dueInMs,
}: {
  enabled: boolean;
  failures: number;
  dueInMs: number | null;
}): number {
  if (failures > 0) {
    return Math.min(
      MAX_ERROR_BACKOFF_MS,
      1000 * 2 ** Math.min(failures - 1, 16),
    );
  }
  if (!enabled || dueInMs == null) return IDLE_POLL_MS;
  return Math.min(IDLE_POLL_MS, Math.max(MIN_POLL_MS, dueInMs));
}

/** How long until the earliest target is due (null: none is owed). */
async function nextDueInMs(): Promise<number | null> {
  const { rows } = await getPool().query(
    `SELECT EXTRACT(EPOCH FROM
              min(COALESCE(lease_until, now())) - now()) * 1000 AS ms
       FROM account_computer_session_targets`,
  );
  const ms = rows[0]?.ms;
  return ms == null ? null : Math.max(0, Number(ms));
}

let started = false;
let running: Promise<void> | undefined;
let again = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let delayMs: number | undefined;
let failures = 0;
let targetErrors = 0;
let wakeSub: { close: () => void } | undefined;
let wakesEnabled = false;
const problems = new FailureLog(logger, "computer state delivery");

/**
 * Something is owed (a login, a revocation, a narrowing): deliver now. In
 * a process that delivers this runs a pass (coalesced with one in
 * progress); elsewhere it wakes one process that does. A lost wake costs
 * at most IDLE_POLL_MS.
 */
export function kickComputerStateDelivery(): Promise<void> {
  if (!started) {
    wakeDeliveringHub();
    return Promise.resolve();
  }
  if (running != null) {
    again = true;
    return running;
  }
  if (timer != null) clearTimeout(timer);
  timer = undefined;
  running = (async () => {
    let delay = IDLE_POLL_MS;
    try {
      do {
        again = false;
        delay = await runPass();
      } while (again && failures === 0 && started);
    } finally {
      running = undefined;
      schedule(delay);
    }
  })();
  return running;
}

async function runPass(): Promise<number> {
  try {
    // Off (the default): no computer can connect, so there is no one to
    // deliver to, and an idle hub must not query the database. Owed targets
    // wait until computers are turned on. Settings are cached, so this
    // check costs no query.
    const enabled = (await getServerSettings()).computers_enabled === true;
    let dueInMs: number | null = null;
    if (enabled) {
      targetErrors = 0;
      await deliverDueStates();
      dueInMs = await nextDueInMs();
    }
    failures = 0;
    if (targetErrors === 0) problems.succeeded();
    return nextPassDelay({ enabled, failures, dueInMs });
  } catch (err) {
    failures += 1;
    problems.failed(err);
    return nextPassDelay({ enabled: true, failures, dueInMs: null });
  }
}

function schedule(ms: number): void {
  if (!started) return;
  if (timer != null) clearTimeout(timer);
  delayMs = ms;
  timer = setTimeout(() => {
    timer = undefined;
    void kickComputerStateDelivery();
  }, ms);
  timer.unref?.();
}

/** Tests: how long until the next scheduled pass (undefined: none). */
export function nextComputerStateDeliveryDelayForTesting(): number | undefined {
  return timer == null ? undefined : delayMs;
}

/**
 * How long after a computer's login its first delivery starts. Its daemon
 * subscribes right after the login, but a push published within a few
 * milliseconds of that subscription can be lost (seen in the e2e tests: a
 * publish that counted the daemon as a subscriber never reached it), which
 * costs an ack wait and a backoff, about 12 s. The old 1 s poll rarely
 * published that early; this waits as long as that poll ever did.
 */
export const LOGIN_DELIVERY_DELAY_MS = 1_000;

/** A computer logged in: its new session owes the computer's state. */
export function kickComputerStateDeliveryAfterLogin(): void {
  const t = setTimeout(() => {
    void kickComputerStateDelivery();
  }, LOGIN_DELIVERY_DELAY_MS);
  t.unref?.();
}

/**
 * Every hub process delivers (claims never overlap); one of them answers
 * each wake.
 */
export function startComputerStateDelivery(): void {
  if (started) return;
  started = true;
  failures = 0;
  void listenForWakes();
  schedule(FIRST_POLL_MS);
}

export function stopComputerStateDelivery(): void {
  started = false;
  if (timer != null) clearTimeout(timer);
  timer = undefined;
  wakeSub?.close();
  wakeSub = undefined;
}

/**
 * A hub process that doesn't deliver (a conat router answering a
 * computer's login, say) passes its kicks on to one that does.
 */
export function enableComputerStateDeliveryWakes(): void {
  wakesEnabled = true;
}

function wakeDeliveringHub(): void {
  if (!wakesEnabled) return;
  try {
    deliveryClient().publishSync(COMPUTER_STATE_WAKE_SUBJECT, null);
  } catch (err) {
    logger.debug("waking computer state delivery failed", `${err}`);
  }
}

async function listenForWakes(): Promise<void> {
  try {
    const sub = await deliveryClient().subscribe(COMPUTER_STATE_WAKE_SUBJECT, {
      queue: "computer-state-delivery",
    });
    if (!started || wakeSub != null) {
      sub.close();
      return;
    }
    wakeSub = sub;
    for await (const _ of sub) {
      void kickComputerStateDelivery();
    }
  } catch (err) {
    // Best effort: without wakes, other processes' changes wait for the
    // idle poll.
    logger.debug("listening for computer state wakes failed", `${err}`);
  }
}
