/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Requests to connect a computer, and device-first pairing. Runs at the
// account's home bay. Design: src/.agents/computers-direct-host-2026-10-16.md.
//
// 1. The owner creates a request: a name and the one project the computer
//    will serve. The request id is not secret; nothing is allowed yet.
// 2. The machine claims it and gets a random secret (only it ever sees it)
//    and a pairing phrase. A second claim invalidates the request; it never
//    replaces the first.
// 3. The owner approves after comparing the phrase (fresh auth, checked by
//    the RPC layer). The computer row stores the secret's hash: from now on
//    the secret is the computer's token.

import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import getPool from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";
import { pairingPhrase } from "@cocalc/util/computers/pairing-phrase";
import type {
  ComputerRequestSummary,
  MachineInfo,
  PairingClaim,
  PairingStatus,
} from "@cocalc/util/computers/api";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { assertComputersAuthority, type Queryable } from "./authority";

/**
 * How long a request waits for the machine and the owner. Generous: people
 * get distracted, so a short window mostly just expires on them (approval
 * still needs fresh auth and the phrase check).
 */
export const REQUEST_LIFETIME_MS = 60 * 60 * 1000;
export const MAX_OPEN_REQUESTS_PER_ACCOUNT = 10;
export const MAX_COMPUTERS_PER_ACCOUNT = 20;

const NAME = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
// Crockford-like alphabet: no I or O.
const REQUEST_ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const REQUEST_ID = /^R-[0-9A-HJ-NP-Z]{10}$/;

export class ComputerRequestError extends Error {}

export function newRequestId(): string {
  const bytes = randomBytes(10);
  let id = "R-";
  for (const b of bytes) id += REQUEST_ALPHABET[b % REQUEST_ALPHABET.length];
  return id;
}

export function computerName(value: unknown): string {
  if (typeof value !== "string" || !NAME.test(value)) {
    throw new ComputerRequestError(
      "a computer name is 1-32 lowercase letters, digits and dashes, starting with a letter",
    );
  }
  return value;
}

/** The hash a computer's token is stored as. */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * A project can have computers only while its one collaborator is the
 * account (its owner): every process in it can use them. The project must
 * be at this bay (stage 1). Returns its host, if it has one.
 */
export async function projectForComputers(
  db: Queryable,
  account_id: string,
  project_id: string,
): Promise<{ host_id: string | null }> {
  const { rows } = await db.query(
    `SELECT users, host_id, deleted, owning_bay_id FROM projects
      WHERE project_id=$1`,
    [project_id],
  );
  const row = rows[0];
  if (
    row == null ||
    row.deleted ||
    (row.owning_bay_id != null && row.owning_bay_id !== getConfiguredBayId())
  ) {
    throw new ComputerRequestError(
      "no such project here (computers work with projects on your home bay)",
    );
  }
  const users = Object.entries(row.users ?? {});
  const [id, entry] = (users[0] ?? []) as [string, any];
  if (users.length !== 1 || id !== account_id || entry?.group !== "owner") {
    throw new ComputerRequestError(
      "a computer can serve only a project whose one collaborator is you: everything running in it can use the computer",
    );
  }
  return { host_id: row.host_id ?? null };
}

export async function createComputerRequest({
  account_id,
  name,
  project_id,
  now = Date.now(),
}: {
  account_id: string;
  name: string;
  project_id: string;
  now?: number;
}): Promise<{ request_id: string; expires_at: number }> {
  requireUuid(account_id, "account_id");
  requireUuid(project_id, "project_id");
  const alias = computerName(name);
  return await transaction(async (db) => {
    await assertComputersAuthority(db, account_id, "connect a computer");
    await projectForComputers(db, account_id, project_id);
    const open = await db.query(
      `SELECT count(*)::int AS n FROM computer_pairing_requests
        WHERE account_id=$1 AND state IN ('pending','claimed') AND expires_at > $2`,
      [account_id, new Date(now)],
    );
    if (open.rows[0].n >= MAX_OPEN_REQUESTS_PER_ACCOUNT) {
      throw new ComputerRequestError(
        "too many open computer requests; decline some first",
      );
    }
    await assertNameFree(db, account_id, alias);
    const request_id = newRequestId();
    const expires_at = now + REQUEST_LIFETIME_MS;
    await db.query(
      `INSERT INTO computer_pairing_requests
         (request_id, account_id, project_id, name, state, expires_at, created_at)
       VALUES ($1,$2,$3,$4,'pending',$5,$6)`,
      [
        request_id,
        account_id,
        project_id,
        alias,
        new Date(expires_at),
        new Date(now),
      ],
    );
    return { request_id, expires_at };
  });
}

/** What the machine shows the person there before claiming. Not secret. */
export async function getPairingView(
  request_id: string,
  now = Date.now(),
): Promise<{
  request_id: string;
  name: string;
  account_label: string;
  state: string;
  expires_at: number;
}> {
  const row = await loadRequest(getPool(), request_id);
  if (row == null) throw new ComputerRequestError("no such computer request");
  return {
    request_id: row.request_id,
    name: row.name,
    account_label: await accountLabel(row.account_id),
    state: stateOf(row, now),
    expires_at: new Date(row.expires_at).valueOf(),
  };
}

/** The machine claims the request: it alone gets the secret. */
export async function claimComputerRequest({
  request_id,
  machine,
  now = Date.now(),
}: {
  request_id: string;
  machine: unknown;
  now?: number;
}): Promise<PairingClaim> {
  const info = machineInfo(machine);
  const result = await transaction(async (db) => {
    const row = await loadRequest(db, request_id, true);
    if (row == null) throw new ComputerRequestError("no such computer request");
    const state = stateOf(row, now);
    if (state === "claimed") {
      // Two machines claimed it: neither may become the computer.
      await db.query(
        `UPDATE computer_pairing_requests
            SET state='invalidated', claims=claims+1 WHERE request_id=$1`,
        [request_id],
      );
      return { invalidated: true as const };
    }
    if (state !== "pending") {
      throw new ComputerRequestError(
        `this request is ${state}; make a new one in CoCalc`,
      );
    }
    const secret = randomBytes(32).toString("base64url");
    const pairing_phrase = pairingPhrase(randomBytes(4));
    await db.query(
      `UPDATE computer_pairing_requests
          SET state='claimed', claims=claims+1, token_hash=$2,
              pairing_phrase=$3, hostname=$4, os=$5, arch=$6, machine_user=$7
        WHERE request_id=$1`,
      [
        request_id,
        tokenHash(secret),
        pairing_phrase,
        info.hostname,
        info.os,
        info.arch,
        info.user,
      ],
    );
    return {
      claim: {
        request_id,
        name: row.name,
        account_label: await accountLabel(row.account_id),
        pairing_phrase,
        expires_at: new Date(row.expires_at).valueOf(),
        secret,
      },
    };
  });
  if ("invalidated" in result) {
    throw new ComputerRequestError(
      "another machine already claimed this request, so it is no longer valid; make a new one in CoCalc",
    );
  }
  return result.claim;
}

/** What the claiming machine sees while it waits. Needs its secret. */
export async function getPairingStatus({
  request_id,
  secret,
  now = Date.now(),
}: {
  request_id: string;
  secret: unknown;
  now?: number;
}): Promise<PairingStatus> {
  const row = await loadRequest(getPool(), request_id);
  if (
    row == null ||
    typeof secret !== "string" ||
    row.token_hash == null ||
    !sameText(row.token_hash, tokenHash(secret))
  ) {
    throw new ComputerRequestError("no such pairing");
  }
  const state = stateOf(row, now);
  return {
    request_id,
    state,
    expires_at: new Date(row.expires_at).valueOf(),
    ...(state === "approved"
      ? {
          computer_id: row.computer_id,
          name: row.name,
          project_id: row.project_id,
        }
      : {}),
  };
}

/**
 * Approve a claimed request whose phrase the owner compared. Fresh auth is
 * checked by the caller. Creates the computer with the claim's token hash.
 */
export async function approveComputerRequest({
  account_id,
  request_id,
  pairing_phrase,
  now = Date.now(),
}: {
  account_id: string;
  request_id: string;
  pairing_phrase: string;
  now?: number;
}): Promise<{ computer_id: string }> {
  requireUuid(account_id, "account_id");
  return await transaction(async (db) => {
    await assertComputersAuthority(db, account_id, "connect a computer");
    const row = await loadRequest(db, request_id, true);
    if (row == null || row.account_id !== account_id) {
      throw new ComputerRequestError("no such computer request");
    }
    const state = stateOf(row, now);
    if (state !== "claimed") {
      throw new ComputerRequestError(
        state === "pending"
          ? "no machine has claimed this request yet: run its line on the computer first"
          : `this request is ${state}`,
      );
    }
    if (
      typeof pairing_phrase !== "string" ||
      !sameText(pairing_phrase.trim().toLowerCase(), row.pairing_phrase)
    ) {
      throw new ComputerRequestError(
        "the phrase doesn't match the one the machine shows",
      );
    }
    await projectForComputers(db, account_id, row.project_id);
    await assertNameFree(db, account_id, row.name);
    const count = await db.query(
      `SELECT count(*)::int AS n FROM paired_computers
        WHERE account_id=$1 AND revoked_at IS NULL`,
      [account_id],
    );
    if (count.rows[0].n >= MAX_COMPUTERS_PER_ACCOUNT) {
      throw new ComputerRequestError(
        `at most ${MAX_COMPUTERS_PER_ACCOUNT} computers; revoke one first`,
      );
    }
    const computer_id = randomUUID();
    await db.query(
      `INSERT INTO paired_computers
         (computer_id, account_id, project_id, name, hostname, os, arch,
          machine_user, token_hash, request_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        computer_id,
        account_id,
        row.project_id,
        row.name,
        row.hostname,
        row.os,
        row.arch,
        row.machine_user,
        row.token_hash,
        request_id,
        new Date(now),
      ],
    );
    await db.query(
      `UPDATE computer_pairing_requests SET state='approved', computer_id=$2
        WHERE request_id=$1`,
      [request_id, computer_id],
    );
    return { computer_id };
  });
}

export async function declineComputerRequest({
  account_id,
  request_id,
}: {
  account_id: string;
  request_id: string;
}): Promise<void> {
  requireUuid(account_id, "account_id");
  if (typeof request_id !== "string" || !REQUEST_ID.test(request_id)) {
    throw new ComputerRequestError("malformed computer request id");
  }
  await getPool().query(
    `UPDATE computer_pairing_requests SET state='declined'
      WHERE request_id=$1 AND account_id=$2 AND state IN ('pending','claimed')`,
    [request_id, account_id],
  );
}

export async function listComputerRequests(
  account_id: string,
  now = Date.now(),
): Promise<ComputerRequestSummary[]> {
  requireUuid(account_id, "account_id");
  const { rows } = await getPool().query(
    `SELECT * FROM computer_pairing_requests
      WHERE account_id=$1 ORDER BY created_at DESC LIMIT 50`,
    [account_id],
  );
  return rows.map((row) => ({
    request_id: row.request_id,
    name: row.name,
    project_id: row.project_id,
    state: stateOf(row, now),
    pairing_phrase: row.pairing_phrase ?? null,
    machine:
      row.hostname == null
        ? null
        : {
            hostname: row.hostname,
            os: row.os,
            arch: row.arch,
            user: row.machine_user,
          },
    computer_id: row.computer_id ?? null,
    expires_at: new Date(row.expires_at).valueOf(),
    created_at: new Date(row.created_at).valueOf(),
  }));
}

async function assertNameFree(
  db: Queryable,
  account_id: string,
  name: string,
): Promise<void> {
  const { rows } = await db.query(
    `SELECT 1 FROM paired_computers
      WHERE account_id=$1 AND name=$2 AND revoked_at IS NULL`,
    [account_id, name],
  );
  if (rows.length > 0) {
    throw new ComputerRequestError(
      `you already have a computer named @${name}`,
    );
  }
}

/** Open past its expiry is expired, whether or not anything marked it. */
function stateOf(row: any, now: number): string {
  const open = row.state === "pending" || row.state === "claimed";
  return open && new Date(row.expires_at).valueOf() <= now
    ? "expired"
    : row.state;
}

function machineInfo(input: unknown): MachineInfo {
  const o = (input ?? {}) as Record<string, unknown>;
  const text = (value: unknown, max: number) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new ComputerRequestError("the machine's description is malformed");
    }
    // Shown to the owner: printable text only, bounded.
    return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?").slice(0, max);
  };
  return {
    hostname: text(o.hostname, 255),
    os: text(o.os, 32),
    arch: text(o.arch, 32),
    user: text(o.user, 64),
  };
}

/**
 * How the machine names the account that will control it, so the person
 * there can tell it's theirs (and spot a line sent by someone else). The
 * email is partly masked: anyone with the request id can see this.
 */
async function accountLabel(account_id: string): Promise<string> {
  const { rows } = await getPool().query(
    `SELECT first_name, last_name, email_address FROM accounts WHERE account_id=$1`,
    [account_id],
  );
  const row = rows[0] ?? {};
  const name = `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim();
  const email = maskEmail(row.email_address);
  return [name, email && `<${email}>`].filter(Boolean).join(" ") || account_id;
}

export function maskEmail(email: unknown): string {
  if (typeof email !== "string" || !email.includes("@")) return "";
  const [user, domain] = email.split("@", 2);
  const mask = (part: string) => (part.length <= 1 ? part : `${part[0]}***`);
  const dot = domain.lastIndexOf(".");
  return dot > 0
    ? `${mask(user)}@${mask(domain.slice(0, dot))}${domain.slice(dot)}`
    : `${mask(user)}@${mask(domain)}`;
}

async function loadRequest(
  db: Queryable,
  request_id: string,
  forUpdate = false,
): Promise<any | undefined> {
  if (typeof request_id !== "string" || !REQUEST_ID.test(request_id)) {
    throw new ComputerRequestError("malformed computer request id");
  }
  const { rows } = await db.query(
    `SELECT * FROM computer_pairing_requests WHERE request_id=$1${
      forUpdate ? " FOR UPDATE" : ""
    }`,
    [request_id],
  );
  return rows[0];
}

export async function transaction<T>(
  fn: (db: Queryable) => Promise<T>,
): Promise<T> {
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

export function requireUuid(value: unknown, where: string): string {
  if (typeof value !== "string" || !isValidUUID(value)) {
    throw new ComputerRequestError(`${where} must be a UUID`);
  }
  return value;
}
