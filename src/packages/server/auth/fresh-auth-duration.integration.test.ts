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
  listActiveFreshAuthSessions,
  recordNewAuthSession,
  resolveFreshAuthDurationMs,
  setSessionFreshAuth,
} from "./auth-sessions";
import { createLocalCliLoginSession } from "@cocalc/server/inter-bay/accounts";
import { setImpersonationActorFreshAuth } from "./impersonation";
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

// The public id of a session, as the server derives it (in SQL).
async function idOf(session_hash: string): Promise<string> {
  const { rows } = await getPool().query(
    "SELECT left(encode(sha256(convert_to('fresh-auth-session:' || rtrim($1::TEXT), 'UTF8')), 'hex'), 32) AS id",
    [session_hash],
  );
  return rows[0].id;
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

// The email is sent without delaying the verification: wait until the
// expected number arrived (or, for none, give a stray one time to show up).
async function emailsSettle(expected = 0): Promise<void> {
  const deadline = Date.now() + (expected > 0 ? 15_000 : 1_000);
  while (Date.now() < deadline && testEmails.length < Math.max(expected, 1)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

it("emails the account when a fresh auth longer than 8 hours starts", async () => {
  const account_id = await newAccount();
  const hash = await session(account_id);
  await freshFor(account_id, hash, 8 * HOUR);
  await emailsSettle();
  expect(testEmails).toHaveLength(0);
  await freshFor(account_id, hash, 72 * HOUR);
  await emailsSettle(1);
  expect(testEmails).toHaveLength(1);
  expect(testEmails[0].to).toBe(`${account_id}@example.test`);
  expect(testEmails[0].subject).toMatch(/72 hours/);
  expect(testEmails[0].text).toMatch(/End now/);
  expect(testEmails[0].text).toMatch(/\/settings\/profile#security/);
});

// The in-app notices about long verifications, newest first.
async function longFreshAuthNotices(account_id: string): Promise<any[]> {
  const { rows } = await getPool().query(
    `SELECT payload_json->'summary' AS summary
       FROM notification_target_outbox
      WHERE target_account_id = $1
        AND kind = 'account_notice'
        AND payload_json->'summary'->>'notice_type' = 'long_fresh_auth'
      ORDER BY created_at DESC`,
    [account_id],
  );
  return rows.map(({ summary }) => summary);
}

// The in-app notice is written right after the email is queued: wait for it.
async function noticesSettle(account_id: string, expected: number) {
  const deadline = Date.now() + (expected > 0 ? 15_000 : 1_000);
  let notices = await longFreshAuthNotices(account_id);
  while (Date.now() < deadline && notices.length < Math.max(expected, 1)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    notices = await longFreshAuthNotices(account_id);
  }
  return notices;
}

it("also leaves an in-app notice when a fresh auth longer than 8 hours starts", async () => {
  const account_id = await newAccount();
  const hash = await session(account_id);
  await freshFor(account_id, hash, 8 * HOUR);
  expect(await noticesSettle(account_id, 0)).toHaveLength(0);
  await freshFor(account_id, hash, 72 * HOUR);
  const notices = await noticesSettle(account_id, 1);
  expect(notices).toHaveLength(1);
  expect(notices[0].title).toMatch(/72 hours/);
  expect(notices[0].severity).toBe("warning");
  expect(notices[0].action_link).toBe("/settings/profile#security");
});

it("a CLI sign-in carrying a verification over 8 hours sends the email and the in-app notice", async () => {
  const account_id = await newAccount();
  await createLocalCliLoginSession({
    account_id,
    approved_challenge_id: randomUUID(),
    factor_level: "totp",
    fresh_auth_until: new Date(Date.now() + 8 * HOUR),
    ip_address: "192.0.2.7",
    user_agent: "cocalc-cli/1.0",
  });
  await emailsSettle();
  expect(testEmails).toHaveLength(0);
  expect(await noticesSettle(account_id, 0)).toHaveLength(0);

  await createLocalCliLoginSession({
    account_id,
    approved_challenge_id: randomUUID(),
    factor_level: "totp",
    fresh_auth_until: new Date(Date.now() + 72 * HOUR),
    ip_address: "192.0.2.7",
    // A client chooses its own user agent: it must not become a link.
    user_agent: "cocalc-cli/1.0 [click](https://evil.example)",
  });
  await emailsSettle(1);
  expect(testEmails).toHaveLength(1);
  expect(testEmails[0].to).toBe(`${account_id}@example.test`);
  expect(testEmails[0].subject).toMatch(/72 hours/);
  expect(testEmails[0].text).toMatch(/A CLI sign-in/);
  expect(testEmails[0].text).toMatch(/IP address: 192\.0\.2\.7/);
  expect(testEmails[0].text).toMatch(/cocalc-cli\/1\.0/);
  const notices = await noticesSettle(account_id, 1);
  expect(notices).toHaveLength(1);
  expect(notices[0].title).toMatch(/CLI sign-in/);
  expect(notices[0].body_markdown).toContain("192\\.0\\.2\\.7");
  expect(notices[0].body_markdown).not.toContain("](");
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
  expect(list.map((s) => s.id)).toEqual([await idOf(a), await idOf(b)]);
  expect(list.map((s) => s.current)).toEqual([false, true]);
  expect(list[0].fresh_auth_until.valueOf()).toBeGreaterThan(
    Date.now() + 71 * HOUR,
  );
  // The session hash itself never leaves the server.
  expect(JSON.stringify(list)).not.toContain(a.trim());
  expect(list.map((s) => s.id)).not.toContain(await idOf(none));
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

  expect(await endFreshAuth({ account_id, id: await idOf(a) })).toEqual({
    ended: 1,
  });
  expect((await row(a)).fresh_auth_until).toBeNull();
  expect((await row(a)).revoked_at).toBeNull();
  expect((await row(b)).fresh_auth_until).not.toBeNull();

  // Another account's session id ends nothing here.
  expect(await endFreshAuth({ account_id, id: await idOf(theirs) })).toEqual({
    ended: 0,
  });
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

it("an admin acting as someone else gets at most 8 hours", async () => {
  const subject = await newAccount();
  const actor = await newAccount();
  const hash = await session(subject);
  await getPool().query(
    `INSERT INTO account_impersonation_sessions
       (session_hash, subject_account_id, actor_account_id, created, updated, expire)
     VALUES ($1::CHAR(127), $2, $3, NOW(), NOW(), NOW() + INTERVAL '1 hour')`,
    [hash, subject, actor],
  );
  await expect(freshFor(subject, hash, 72 * HOUR)).rejects.toThrow(
    /at most 8 hours/,
  );
  expect((await row(hash)).fresh_auth_until).toBeNull();
  await expect(
    setImpersonationActorFreshAuth({
      subject_account_id: subject,
      session_hash: hash,
      factor_level: "totp",
      fresh_auth_until: new Date(Date.now() + 72 * HOUR),
    }),
  ).rejects.toThrow(/at most 8 hours/);
  await freshFor(subject, hash, 8 * HOUR);
  await emailsSettle();
  expect(testEmails).toHaveLength(0);
});

it("ending all is not bounded by the 200 sessions the browser lists", async () => {
  const account_id = await newAccount();
  const n = 205;
  await getPool().query(
    `INSERT INTO account_auth_sessions
       (session_hash, account_id, created, updated, expire, authenticated_at,
        fresh_auth_until, factor_level)
     SELECT 'bulk-' || md5(random()::TEXT || g::TEXT), $1::UUID, NOW(), NOW(),
            NOW() + INTERVAL '1 day', NOW(), NOW() + INTERVAL '72 hours', 'totp'
       FROM generate_series(1, $2::INT) AS g`,
    [account_id, n],
  );
  expect(await listActiveFreshAuthSessions({ account_id })).toHaveLength(200);
  expect(await endFreshAuth({ account_id, all: true })).toEqual({ ended: n });
  const { rows } = await getPool().query(
    "SELECT count(*)::INT AS n FROM account_auth_sessions WHERE account_id = $1 AND fresh_auth_until IS NOT NULL",
    [account_id],
  );
  expect(rows[0].n).toBe(0);
});

it("ends the caller's own fresh auth by its session hash", async () => {
  const account_id = await newAccount();
  const a = await session(account_id);
  const b = await session(account_id);
  await freshFor(account_id, a, HOUR);
  await freshFor(account_id, b, HOUR);
  expect(await endFreshAuth({ account_id, session_hash: a })).toEqual({
    ended: 1,
  });
  expect((await row(a)).fresh_auth_until).toBeNull();
  expect((await row(b)).fresh_auth_until).not.toBeNull();
});
