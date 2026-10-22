/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";

import getPool from "@cocalc/database/pool";
import { after, before } from "@cocalc/server/test";

import {
  endAllSignInSessions,
  endOtherSignInSessions,
  endSignInSession,
  recordNewAuthSession,
} from "./auth-sessions";
import { createRememberMeCookie } from "./remember-me";

beforeAll(async () => {
  await before({ noConat: true });
}, 60_000);
afterAll(after);

async function newAccount(): Promise<string> {
  const account_id = randomUUID();
  await getPool().query(
    "INSERT INTO accounts (account_id, email_address) VALUES ($1, $2)",
    [account_id, `${account_id}@example.test`],
  );
  return account_id;
}

async function session(account_id: string): Promise<string> {
  const { hash, expire } = await createRememberMeCookie(account_id);
  await recordNewAuthSession({ account_id, session_hash: hash, expire });
  return hash;
}

// Whether the cookie still works, and whether its auth session is revoked.
async function state(hash: string) {
  const cookie = await getPool().query(
    "SELECT 1 FROM remember_me WHERE hash = $1::CHAR(127)",
    [hash],
  );
  const auth = await getPool().query(
    "SELECT revoked_at FROM account_auth_sessions WHERE session_hash = $1::CHAR(127)",
    [hash],
  );
  return {
    cookie: cookie.rows.length > 0,
    revoked: auth.rows[0]?.revoked_at != null,
  };
}

const LIVE = { cookie: true, revoked: false };
const ENDED = { cookie: false, revoked: true };

async function ensureRehomeTable() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS account_rehome_operations (
      op_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id UUID NOT NULL,
      source_bay_id TEXT NOT NULL,
      dest_bay_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      stage TEXT NOT NULL DEFAULT 'requested',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
}

async function startRehome(account_id: string, db = getPool()) {
  await db.query(
    `INSERT INTO account_rehome_operations (account_id, source_bay_id, dest_bay_id, stage)
     VALUES ($1, 'bay-0', 'bay-1', 'source_flipped')`,
    [account_id],
  );
}

async function finishRehome(account_id: string) {
  await getPool().query(
    "UPDATE account_rehome_operations SET status = 'succeeded' WHERE account_id = $1",
    [account_id],
  );
}

it("ends one session: its cookie stops working and its auth session is revoked", async () => {
  const account_id = await newAccount();
  const ended = await session(account_id);
  const other = await session(account_id);
  // By the session's own account, as sign-out does for each of its cookies.
  await endSignInSession({ session_hash: ended });
  expect(await state(ended)).toEqual(ENDED);
  expect(await state(other)).toEqual(LIVE);
});

it("ends all, or all other, sessions of an account", async () => {
  const account_id = await newAccount();
  const keep = await session(account_id);
  const a = await session(account_id);
  await endOtherSignInSessions({ account_id, keep_session_hash: keep });
  expect(await state(keep)).toEqual(LIVE);
  expect(await state(a)).toEqual(ENDED);
  await endAllSignInSessions(account_id);
  expect(await state(keep)).toEqual(ENDED);
});

it("during a rehome, ending a session changes nothing rather than half of it", async () => {
  // The rehome copies both rows to the new bay. Before, the cookie row was
  // deleted outside the fence while the revocation was refused, so the
  // copied cookie came back on the new bay.
  await ensureRehomeTable();
  const account_id = await newAccount();
  const hash = await session(account_id);
  await startRehome(account_id);
  try {
    await expect(endSignInSession({ session_hash: hash })).rejects.toThrow(
      /rehome/,
    );
    await expect(endAllSignInSessions(account_id)).rejects.toThrow(/rehome/);
    await expect(
      endOtherSignInSessions({ account_id, keep_session_hash: "x" }),
    ).rejects.toThrow(/rehome/);
    expect(await state(hash)).toEqual(LIVE);
  } finally {
    await finishRehome(account_id);
  }
  await endSignInSession({ session_hash: hash });
  expect(await state(hash)).toEqual(ENDED);
});

it("a sign-out racing a rehome start waits for it, then changes nothing", async () => {
  await ensureRehomeTable();
  const account_id = await newAccount();
  const hash = await session(account_id);
  // A rehome starts like createOperation: it takes the account fence and
  // records the running rehome in one transaction.
  const rehome = await getPool().connect();
  try {
    await rehome.query("BEGIN");
    await rehome.query(
      "SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))",
      ["account-rehome", account_id],
    );
    const ending = endSignInSession({ session_hash: hash }).then(
      () => "ended",
      (err) => `${err}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await startRehome(account_id, rehome as any);
    await rehome.query("COMMIT");
    expect(await ending).toMatch(/rehome/);
  } finally {
    rehome.release();
  }
  expect(await state(hash)).toEqual(LIVE);
  await finishRehome(account_id);
});
