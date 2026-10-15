/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A computer's conat sessions at its home bay. Plan:
// src/.agents/computers-plan-2026-10-11.md (part 4b, revision 3).
//
// 1. The daemon asks for a login challenge (unauthenticated, rate-limited):
//    a single-use row with a random nonce, valid for 60 s.
// 2. It signs a login transcript with the computer's key, binding the site,
//    cluster, home bay, computer, account, certificate hash, the challenge
//    and audience "conat", and presents it in the conat handshake.
// 3. One transaction consumes the challenge and claims one of the
//    computer's two session slots (reclaiming the oldest if both are taken),
//    with a lease of at most 15 minutes, never past the computer's deadline
//    or certificate. The session id is the challenge id.
// 4. Every authorization decision for the socket rechecks the session row
//    uncached: open, same generation, lease not over, computer not revoked
//    and at the epoch it logged in with. Revoking, or any epoch bump, ends
//    the session within one revalidation.
//
// Nothing reusable is ever issued: a stolen transcript is useless once its
// challenge is consumed (or after 60 s).
//
// A session starts not ready: it may only subscribe to its op subject and
// acknowledge its state snapshot (delivery.ts). Ordinary authority needs
// ready_version >= the computer's state_version. An ended computer asking
// for a challenge gets its signed ended state instead, even with the site's
// computers switch off.

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import getPool from "@cocalc/database/pool";
import type { KeyObject } from "node:crypto";
import {
  parseComputerChallengeRequest,
  parseComputerLogin,
  parseSignedEnvelope,
  SIGNED_KINDS,
  MAX_FUTURE_SKEW_MS,
  type ComputerLogin,
  type ComputerState,
  type SignedEnvelope,
} from "@cocalc/util/computers/protocol";
import {
  canonicalHash,
  fingerprintOf,
  randomNonce,
  signingPublicKeyFromDer,
  verifyEnvelope,
} from "@cocalc/backend/computers/crypto";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterId } from "@cocalc/server/cluster-config";
import { assertComputersAuthority } from "./authority";
import { computersSite } from "./site";
import { addSessionTarget, computerStateSnapshot, endedOf } from "./state";

export const CHALLENGE_LIFETIME_MS = 60 * 1000;
/** A session's lease: it must log in again (a new challenge) after this. */
export const SESSION_LEASE_MS = 15 * 60 * 1000;
export const SESSION_SLOTS = [1, 2] as const;
/**
 * A session is live only if its router saw it this recently (the router
 * revalidates every 15 s and records it); the relay never picks another.
 */
export const SESSION_LIVENESS_MS = 45_000;
const MAX_OPEN_CHALLENGES = 5;
const MAX_CHALLENGES_PER_MINUTE = 10;
/** Used challenges and closed sessions are kept this long (audit). */
const RETENTION_MS = 24 * 60 * 60 * 1000;

export class ComputerSessionError extends Error {}

export interface LoginChallenge {
  challenge_id: string;
  nonce: string;
  expires_at: number;
  site: string;
  cluster_id: string;
  home_bay_id: string;
}

/** Instead of a challenge: this computer has ended, for good. */
export interface LoginEnded {
  ended: SignedEnvelope<ComputerState>;
}

/**
 * A single-use challenge, for a request signed by the computer's own key
 * (so someone who only knows its id can't use up its challenges). Unknown
 * and foreign computers, and bad signatures, get the same answer.
 *
 * An ended computer (revoked, replaced, its account deleted) whose request
 * verifies gets its signed ended state, before assertEnabled (the site's
 * switch): so a daemon that was offline stops its jobs when it comes back.
 * The computer's row is locked, so count and insert are serialized.
 */
export async function createLoginChallenge(
  input: unknown,
  now = Date.now(),
  { assertEnabled }: { assertEnabled?: () => Promise<void> } = {},
): Promise<LoginChallenge | LoginEnded> {
  const envelope = parseSignedEnvelope(
    input,
    parseComputerChallengeRequest,
    "challenge request",
  );
  const request = envelope.payload;
  if (
    request.site !== (await computersSite()) ||
    request.cluster_id !== getConfiguredClusterId() ||
    request.home_bay_id !== getConfiguredBayId()
  ) {
    throw new ComputerSessionError("no such computer");
  }
  if (Math.abs(request.issued_at - now) > CHALLENGE_LIFETIME_MS) {
    throw new ComputerSessionError(
      "this request is too old (or the computer's clock is off)",
    );
  }
  const verified = (computer: any): boolean => {
    let key: KeyObject | undefined;
    try {
      key =
        computer == null
          ? undefined
          : signingPublicKeyFromDer(computer.signing_public_key);
    } catch {
      key = undefined;
    }
    return (
      computer != null &&
      key != null &&
      computer.account_id === request.account_id &&
      envelope.kid === computer.signing_key &&
      verifyEnvelope(SIGNED_KINDS.challenge_request, envelope, (kid) =>
        kid === computer.signing_key ? key : undefined,
      )
    );
  };
  // First, whatever the computer's state: is the request really its own?
  const stored = (
    await getPool().query(
      `SELECT account_id, signing_key, signing_public_key, ended_reason,
              revoked_at, tombstoned_at
         FROM account_computers WHERE computer_id=$1 AND home_bay_id=$2`,
      [request.computer_id, getConfiguredBayId()],
    )
  ).rows[0];
  if (!verified(stored)) {
    throw new ComputerSessionError("no such computer");
  }
  if (endedOf(stored) != null) {
    const snapshot = await computerStateSnapshot(request.computer_id, now);
    if (snapshot?.envelope.payload.ended == null) {
      throw new ComputerSessionError("no such computer");
    }
    return { ended: snapshot.envelope };
  }
  await assertEnabled?.();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const computer = (
      await client.query(
        `SELECT account_id, signing_key, signing_public_key FROM account_computers
          WHERE computer_id=$1 AND revoked_at IS NULL AND tombstoned_at IS NULL
            AND ended_reason IS NULL AND home_bay_id=$2
          FOR UPDATE`,
        [request.computer_id, getConfiguredBayId()],
      )
    ).rows[0];
    if (!verified(computer)) {
      // Ended (or changed) since the check above: the next request gets
      // the ended state.
      throw new ComputerSessionError("no such computer");
    }
    // Retention, bounded and inline: this computer's challenges past a day
    // (a signed request is only accepted within a minute, so its nonce
    // record is long past use by then).
    await client.query(
      `DELETE FROM account_computer_challenges
        WHERE computer_id=$1 AND expires_at < $2`,
      [request.computer_id, new Date(now - RETENTION_MS)],
    );
    const counts = (
      await client.query(
        `SELECT
           count(*) FILTER (WHERE used_at IS NULL AND expires_at > $2)::int AS open,
           count(*) FILTER (WHERE created_at > $3)::int AS recent
         FROM account_computer_challenges WHERE computer_id=$1`,
        [request.computer_id, new Date(now), new Date(now - 60_000)],
      )
    ).rows[0];
    if (
      counts.open >= MAX_OPEN_CHALLENGES ||
      counts.recent >= MAX_CHALLENGES_PER_MINUTE
    ) {
      throw new ComputerSessionError("too many login attempts; try again");
    }
    // Each signed request is good for one challenge (rows are kept a day,
    // and a request is only accepted within a minute of its signing).
    const seen = await client.query(
      `SELECT 1 FROM account_computer_challenges
        WHERE computer_id=$1 AND request_nonce=$2`,
      [request.computer_id, request.nonce],
    );
    if (seen.rows.length > 0) {
      throw new ComputerSessionError("this request was already used");
    }
    const challenge = {
      challenge_id: randomUUID(),
      nonce: randomNonce(),
      expires_at: now + CHALLENGE_LIFETIME_MS,
    };
    await client.query(
      `INSERT INTO account_computer_challenges
         (challenge_id, computer_id, account_id, nonce, request_nonce,
          expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        challenge.challenge_id,
        request.computer_id,
        computer.account_id,
        challenge.nonce,
        request.nonce,
        new Date(challenge.expires_at),
        new Date(now),
      ],
    );
    await client.query("COMMIT");
    return {
      ...challenge,
      site: await computersSite(),
      cluster_id: getConfiguredClusterId(),
      home_bay_id: getConfiguredBayId(),
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** This router process (random per start): recorded on its sessions. */
export const ROUTER = randomBytes(12).toString("base64url");

/** Who a socket is, once a computer has logged in. */
export interface ComputerSession {
  computer_id: string;
  account_id: string;
  session_id: string;
  slot: number;
  generation: number;
  epoch: number;
  lease_until: number;
}

/**
 * Verify a login and claim a session slot, consuming the challenge, all in
 * one transaction.
 */
export async function loginComputer(
  input: unknown,
  { now = Date.now(), router = ROUTER }: { now?: number; router?: string } = {},
): Promise<ComputerSession> {
  const envelope = parseSignedEnvelope(input, parseComputerLogin, "login");
  const login: ComputerLogin = envelope.payload;
  if (
    login.site !== (await computersSite()) ||
    login.cluster_id !== getConfiguredClusterId()
  ) {
    throw new ComputerSessionError("this login is for another site");
  }
  if (login.home_bay_id !== getConfiguredBayId()) {
    throw new ComputerSessionError("log in at the computer's home bay");
  }
  if (login.issued_at > now + MAX_FUTURE_SKEW_MS || login.expires_at <= now) {
    throw new ComputerSessionError("this login has expired; try again");
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // The fence first, as in every computers transaction.
    await assertComputersAuthority(
      client,
      login.account_id,
      "log in a computer",
    );
    const computer = (
      await client.query(
        `SELECT * FROM account_computers WHERE computer_id=$1 FOR UPDATE`,
        [login.computer_id],
      )
    ).rows[0];
    if (
      computer == null ||
      computer.account_id !== login.account_id ||
      computer.home_bay_id !== login.home_bay_id ||
      Number(computer.home_epoch) !== login.home_epoch ||
      computer.revoked_at != null ||
      computer.tombstoned_at != null ||
      computer.ended_reason != null
    ) {
      throw new ComputerSessionError("no such computer");
    }
    if (
      computer.signing_key !== login.signing_key ||
      envelope.kid !== login.signing_key
    ) {
      throw new ComputerSessionError("this login is signed by another key");
    }
    const key = signingPublicKeyFromDer(computer.signing_public_key);
    if (
      fingerprintOf(key) !== computer.signing_key ||
      !verifyEnvelope(SIGNED_KINDS.login, envelope, (kid) =>
        kid === computer.signing_key ? key : undefined,
      )
    ) {
      throw new ComputerSessionError("the login signature is invalid");
    }
    if (canonicalHash(computer.certificate) !== login.certificate_hash) {
      throw new ComputerSessionError("this login is for another certificate");
    }
    const deadline =
      computer.deadline == null ? null : new Date(computer.deadline).valueOf();
    if (deadline != null && deadline <= now) {
      throw new ComputerSessionError("this computer's time is over");
    }
    const notAfter = Number(computer.certificate?.payload?.not_after);
    if (!Number.isFinite(notAfter) || notAfter <= now) {
      throw new ComputerSessionError("this computer's certificate has expired");
    }
    // Consume the challenge: exactly once, for this computer, unexpired.
    const challenge = (
      await client.query(
        `SELECT * FROM account_computer_challenges WHERE challenge_id=$1 FOR UPDATE`,
        [login.challenge_id],
      )
    ).rows[0];
    if (
      challenge == null ||
      challenge.computer_id !== login.computer_id ||
      challenge.used_at != null ||
      new Date(challenge.expires_at).valueOf() <= now ||
      !sameText(challenge.nonce, login.nonce)
    ) {
      throw new ComputerSessionError("this login challenge is not valid");
    }
    await client.query(
      `UPDATE account_computer_challenges SET used_at=$2 WHERE challenge_id=$1`,
      [login.challenge_id, new Date(now)],
    );
    // Retention: this computer's sessions closed more than a day ago.
    await client.query(
      `DELETE FROM account_computer_sessions
        WHERE computer_id=$1 AND closed_at < $2`,
      [login.computer_id, new Date(now - RETENTION_MS)],
    );
    // Sessions no router has seen alive lately, or past their lease, are
    // closed first: bumping the generation cuts off any socket still
    // holding one at its next check.
    await client.query(
      `UPDATE account_computer_sessions
          SET closed_at=$2, generation=generation+1
        WHERE computer_id=$1 AND closed_at IS NULL
          AND (lease_until <= $2 OR last_seen <= $3)`,
      [login.computer_id, new Date(now), new Date(now - SESSION_LIVENESS_MS)],
    );
    // A slot: a free one, else reclaim the oldest (its generation moves, so
    // its socket loses every authorization at the next check).
    const open = (
      await client.query(
        `SELECT session_id, slot FROM account_computer_sessions
          WHERE computer_id=$1 AND closed_at IS NULL ORDER BY connected_at`,
        [login.computer_id],
      )
    ).rows;
    const free = SESSION_SLOTS.find((s) => !open.some((o) => o.slot === s));
    const slot: number = free ?? open[0].slot;
    if (free == null) {
      await closeSessionInTransaction(client, open[0].session_id, now);
    }
    const lease_until = Math.min(
      now + SESSION_LEASE_MS,
      deadline ?? Infinity,
      notAfter,
    );
    await client.query(
      `INSERT INTO account_computer_sessions
         (session_id, computer_id, account_id, slot, epoch, generation, router,
          lease_until, connected_at, last_seen)
       VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,$8)`,
      [
        login.challenge_id,
        login.computer_id,
        login.account_id,
        slot,
        Number(computer.epoch),
        router,
        new Date(lease_until),
        new Date(now),
      ],
    );
    // Not ready until its daemon acks the current state: under this row
    // lock, so every later bump raises this target too.
    await addSessionTarget(client, {
      session_id: login.challenge_id,
      account_id: login.account_id,
      computer_id: login.computer_id,
      generation: 1,
      state_version: `${computer.state_version}`,
    });
    await client.query(
      `UPDATE account_computers SET connected_at=$2, last_seen=$2 WHERE computer_id=$1`,
      [login.computer_id, new Date(now)],
    );
    await client.query("COMMIT");
    return {
      computer_id: login.computer_id,
      account_id: login.account_id,
      session_id: login.challenge_id,
      slot,
      generation: 1,
      epoch: Number(computer.epoch),
      lease_until,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function closeSessionInTransaction(
  client,
  session_id: string,
  now: number,
): Promise<void> {
  await client.query(
    `UPDATE account_computer_sessions
        SET closed_at=$2, generation=generation+1
      WHERE session_id=$1 AND closed_at IS NULL`,
    [session_id, new Date(now)],
  );
}

/**
 * Is this session still exactly what logged in? Uncached: called for every
 * authorization decision and every revalidation of the socket.
 * requireReady: and has its daemon applied the computer's current state?
 * (Not for the session's own revalidation or its op subscription: a
 * session isn't closed for lagging before delivery.)
 */
export async function sessionIsCurrent(
  s: Pick<
    ComputerSession,
    "computer_id" | "session_id" | "generation" | "epoch"
  >,
  now = Date.now(),
  {
    touch = false,
    requireReady = false,
  }: { touch?: boolean; requireReady?: boolean } = {},
): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT s.generation, s.lease_until, s.closed_at, s.epoch,
            (s.ready_version IS NOT NULL AND s.ready_version >= c.state_version)
              AS ready,
            c.epoch AS computer_epoch, c.revoked_at, c.tombstoned_at, c.deadline
       FROM account_computer_sessions s
       JOIN account_computers c ON c.computer_id = s.computer_id
      WHERE s.session_id=$1 AND s.computer_id=$2`,
    [s.session_id, s.computer_id],
  );
  const r = rows[0];
  return (
    r != null &&
    r.closed_at == null &&
    Number(r.generation) === s.generation &&
    new Date(r.lease_until).valueOf() > now &&
    Number(r.epoch) === s.epoch &&
    Number(r.computer_epoch) === s.epoch &&
    r.revoked_at == null &&
    r.tombstoned_at == null &&
    (r.deadline == null || new Date(r.deadline).valueOf() > now) &&
    (!requireReady || r.ready === true) &&
    (!touch || (await touchSession(s, now)))
  );
}

/**
 * The one thing a session may publish before it is ready (or after a bump
 * made it stale): the ack of a claimed state delivery, on exactly that
 * attempt's reply subject, while the claim lasts, for this very session and
 * generation.
 */
export async function isStateReceipt(
  s: Pick<ComputerSession, "computer_id" | "session_id" | "generation">,
  subject: string,
): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT 1 FROM account_computer_session_targets t
       JOIN account_computer_sessions s ON s.session_id = t.session_id
      WHERE t.session_id=$1 AND t.computer_id=$2 AND t.generation=$3
        AND s.generation=$3 AND s.closed_at IS NULL
        AND t.reply_subject=$4 AND t.claimed_by_hub IS NOT NULL
        AND t.lease_until > now()`,
    [s.session_id, s.computer_id, s.generation, subject],
  );
  return rows.length > 0;
}

/**
 * The router saw this exact session alive (its periodic revalidation): one
 * statement that records it only if it is still entirely current.
 */
async function touchSession(
  s: Pick<
    ComputerSession,
    "computer_id" | "session_id" | "generation" | "epoch"
  >,
  now: number,
): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE account_computer_sessions s SET last_seen=$5
       FROM account_computers c
      WHERE s.session_id=$1 AND s.computer_id=$2 AND s.generation=$3
        AND s.closed_at IS NULL AND s.lease_until > $5 AND s.epoch=$4
        AND c.computer_id=s.computer_id AND c.epoch=$4
        AND c.revoked_at IS NULL AND c.tombstoned_at IS NULL
        AND (c.deadline IS NULL OR c.deadline > $5)`,
    [s.session_id, s.computer_id, s.generation, s.epoch, new Date(now)],
  );
  return (rowCount ?? 0) > 0;
}

/** The session to send to: the newest current, ready one, if any. */
export async function currentSession(
  computer_id: string,
  now = Date.now(),
): Promise<ComputerSession | undefined> {
  const { rows } = await getPool().query(
    `SELECT s.* FROM account_computer_sessions s
       JOIN account_computers c ON c.computer_id = s.computer_id
      WHERE s.computer_id=$1 AND s.closed_at IS NULL AND s.lease_until > $2
        AND s.last_seen > $3 AND s.ready_version >= c.state_version
        AND s.epoch = c.epoch AND c.revoked_at IS NULL AND c.tombstoned_at IS NULL
      ORDER BY s.last_seen DESC, s.connected_at DESC LIMIT 1`,
    [computer_id, new Date(now), new Date(now - SESSION_LIVENESS_MS)],
  );
  const r = rows[0];
  if (r == null) return undefined;
  return {
    computer_id: r.computer_id,
    account_id: r.account_id,
    session_id: r.session_id,
    slot: Number(r.slot),
    generation: Number(r.generation),
    epoch: Number(r.epoch),
    lease_until: new Date(r.lease_until).valueOf(),
  };
}

/** The socket closed: free its slot (only that exact generation). */
export async function closeComputerSession(
  s: Pick<ComputerSession, "session_id" | "generation">,
  now = Date.now(),
): Promise<void> {
  await getPool().query(
    `UPDATE account_computer_sessions
        SET closed_at=$3, generation=generation+1
      WHERE session_id=$1 AND generation=$2 AND closed_at IS NULL`,
    [s.session_id, s.generation, new Date(now)],
  );
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(`${a}`, "utf8");
  const y = Buffer.from(`${b}`, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}
