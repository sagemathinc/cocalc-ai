/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

// Fresh auth for a chosen duration (up to 72 hours): the email when a long one
// starts, and listing and ending the active ones.

import { randomUUID } from "node:crypto";

import getPool from "@cocalc/database/pool";
import { resetTestEmails, testEmails } from "@cocalc/server/email/send-email";
import { after, before } from "@cocalc/server/test";

import {
  endFreshAuth,
  freshAuthSessionId,
  listActiveFreshAuthSessions,
  recordNewAuthSession,
  resolveFreshAuthDurationMs,
  setSessionFreshAuth,
} from "./auth-sessions";
import { createRememberMeCookie } from "./remember-me";

const HOUR = 3600_000;

beforeAll(async () => {
  await before({ noConat: true });
}, 60_000);
afterAll(after);
beforeEach(resetTestEmails);

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

async function freshFor(account_id: string, session_hash: string, ms: number) {
  await setSessionFreshAuth({
    account_id,
    session_hash,
    factor_level: "totp",
    fresh_auth_until: new Date(Date.now() + ms),
  });
}

async function row(session_hash: string) {
  const { rows } = await getPool().query(
    "SELECT fresh_auth_until, revoked_at FROM account_auth_sessions WHERE session_hash = $1::CHAR(127)",
    [session_hash],
  );
  return rows[0];
}

it("a 72 hour fresh auth needs a TOTP, passkey or Google verification", () => {
  expect(
    resolveFreshAuthDurationMs({ duration: "72h", factor_level: "totp" }),
  ).toBe(72 * HOUR);
  expect(
    resolveFreshAuthDurationMs({ duration: "72h", factor_level: "passkey" }),
  ).toBe(72 * HOUR);
  expect(
    resolveFreshAuthDurationMs({
      duration: "72h",
      factor_level: "google_oidc",
    }),
  ).toBe(72 * HOUR);
  for (const factor_level of ["none", "recovery_code"] as const) {
    expect(() =>
      resolveFreshAuthDurationMs({ duration: "72h", factor_level }),
    ).toThrow(/72 hours fresh auth requires/);
  }
  expect(() =>
    resolveFreshAuthDurationMs({
      duration: "100h" as any,
      factor_level: "totp",
    }),
  ).toThrow(/invalid fresh auth duration/);
});

it("emails the account when a fresh auth longer than 8 hours starts", async () => {
  const account_id = await newAccount();
  const hash = await session(account_id);
  await freshFor(account_id, hash, 8 * HOUR);
  expect(testEmails).toHaveLength(0);
  await freshFor(account_id, hash, 72 * HOUR);
  expect(testEmails).toHaveLength(1);
  expect(testEmails[0].to).toBe(`${account_id}@example.test`);
  expect(testEmails[0].subject).toMatch(/72 hours/);
  expect(testEmails[0].text).toMatch(/End now/);
  expect(testEmails[0].text).toMatch(/\/settings\/profile#security/);
});

it("lists the active fresh auths of an account, marking the current one", async () => {
  const account_id = await newAccount();
  const a = await session(account_id);
  const b = await session(account_id);
  const none = await session(account_id);
  await freshFor(account_id, a, 72 * HOUR);
  await freshFor(account_id, b, 15 * 60_000);
  const other = await newAccount();
  await freshFor(other, await session(other), HOUR);

  const list = await listActiveFreshAuthSessions({
    account_id,
    current_session_hash: b,
  });
  expect(list.map((s) => s.id)).toEqual([
    freshAuthSessionId(a),
    freshAuthSessionId(b),
  ]);
  expect(list.map((s) => s.current)).toEqual([false, true]);
  expect(list[0].fresh_auth_until.valueOf()).toBeGreaterThan(
    Date.now() + 71 * HOUR,
  );
  // The session hash itself never leaves the server.
  expect(JSON.stringify(list)).not.toContain(a.trim());
  expect(list.map((s) => s.id)).not.toContain(freshAuthSessionId(none));
});

it("ends one fresh auth, or all of them, and keeps the sessions signed in", async () => {
  const account_id = await newAccount();
  const a = await session(account_id);
  const b = await session(account_id);
  const c = await session(account_id);
  for (const hash of [a, b, c]) await freshFor(account_id, hash, 72 * HOUR);
  const other = await newAccount();
  const theirs = await session(other);
  await freshFor(other, theirs, 72 * HOUR);

  expect(await endFreshAuth({ account_id, id: freshAuthSessionId(a) })).toEqual(
    { ended: 1 },
  );
  expect((await row(a)).fresh_auth_until).toBeNull();
  expect((await row(a)).revoked_at).toBeNull();
  expect((await row(b)).fresh_auth_until).not.toBeNull();

  // Another account's session id ends nothing here.
  expect(
    await endFreshAuth({ account_id, id: freshAuthSessionId(theirs) }),
  ).toEqual({ ended: 0 });
  expect((await row(theirs)).fresh_auth_until).not.toBeNull();

  expect(await endFreshAuth({ account_id, all: true })).toEqual({ ended: 2 });
  for (const hash of [a, b, c]) {
    expect((await row(hash)).fresh_auth_until).toBeNull();
    expect((await row(hash)).revoked_at).toBeNull();
  }
  expect((await row(theirs)).fresh_auth_until).not.toBeNull();
  expect(await listActiveFreshAuthSessions({ account_id })).toEqual([]);
});

it("refuses to end without a well-formed id or all", async () => {
  const account_id = await newAccount();
  await expect(endFreshAuth({ account_id })).rejects.toThrow(/session id/);
  await expect(endFreshAuth({ account_id, id: "x" })).rejects.toThrow(
    /session id/,
  );
  await expect(
    endFreshAuth({ account_id: "not-a-uuid", all: true }),
  ).rejects.toThrow(/account_id/);
});
