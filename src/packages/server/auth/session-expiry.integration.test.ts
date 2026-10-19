/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { Client } from "pg";

import getPool from "@cocalc/database/pool";
import { after, before } from "@cocalc/server/test";

const settings: Record<string, unknown> = {};
jest.mock("@cocalc/database/settings/server-settings", () => {
  const actual = jest.requireActual(
    "@cocalc/database/settings/server-settings",
  );
  return {
    ...actual,
    getServerSettings: async () => ({
      ...(await actual.getServerSettings()),
      ...settings,
    }),
  };
});

import { getAccountIdFromRememberMe } from "./get-account";
import { createRememberMeCookie } from "./remember-me";
import { recordNewAuthSession, setSessionFreshAuth } from "./auth-sessions";
import { refreshSignInCookies } from "./set-sign-in-cookies";
import {
  renewSessionLifetime,
  resetSessionTouchesForTest,
  runSessionMaintenance,
  touchSession,
} from "./session-expiry";

const DAY = 24 * 3600_000;

beforeAll(async () => {
  await before({ noConat: true });
}, 60_000);
afterAll(after);

beforeEach(() => {
  for (const key of Object.keys(settings)) delete settings[key];
  resetSessionTouchesForTest();
});

async function newAccount(): Promise<string> {
  const account_id = randomUUID();
  await getPool().query(
    "INSERT INTO accounts (account_id, email_address) VALUES ($1, $2)",
    [account_id, `${account_id}@example.test`],
  );
  return account_id;
}

async function row(hash: string) {
  return (
    await getPool().query(
      "SELECT expire, last_used, max_expire FROM remember_me WHERE hash = $1::CHAR(127)",
      [hash],
    )
  ).rows[0];
}

async function authSession(hash: string) {
  return (
    await getPool().query(
      "SELECT expire, revoked_at FROM account_auth_sessions WHERE session_hash = $1::CHAR(127)",
      [hash],
    )
  ).rows[0];
}

function near(date: Date | string, expectedMs: number, slackMs = 120_000) {
  expect(Math.abs(new Date(date).valueOf() - expectedMs)).toBeLessThan(slackMs);
}

async function setRow(
  hash: string,
  fields: { last_used?: string; expire?: string; max_expire?: string },
) {
  for (const [key, value] of Object.entries(fields)) {
    await getPool().query(
      `UPDATE remember_me SET ${key} = NOW() + $2::INTERVAL WHERE hash = $1::CHAR(127)`,
      [hash, value],
    );
  }
}

async function session(lifetime_s?: number) {
  const account_id = await newAccount();
  const created = await createRememberMeCookie(account_id, lifetime_s);
  await recordNewAuthSession({
    account_id,
    session_hash: created.hash,
    expire: created.expire,
  });
  return { account_id, hash: created.hash, value: created.value };
}

it("a new session ends after the idle timeout, at most at its lifetime", async () => {
  const { hash } = await session();
  const r = await row(hash);
  near(r.last_used, Date.now());
  near(r.expire, Date.now() + 14 * DAY);
  near(r.max_expire, Date.now() + 60 * DAY);
  // A short session (impersonation) ends with its own lifetime.
  const short = await session(3600);
  const s = await row(short.hash);
  near(s.expire, Date.now() + 3600_000);
  near(s.max_expire, Date.now() + 3600_000);
});

it("using a session moves its idle deadline, never past its lifetime", async () => {
  const { account_id, hash } = await session();
  // Last used 13 days ago: about to go idle.
  await setRow(hash, { last_used: "-13 days", expire: "1 day" });
  expect(await getAccountIdFromRememberMe(hash)).toBe(account_id);
  await new Promise((resolve) => setTimeout(resolve, 200));
  near((await row(hash)).expire, Date.now() + 14 * DAY);
  // The mirrored auth session follows, since fresh auth checks it.
  near((await authSession(hash)).expire, Date.now() + 14 * DAY);

  // Near the end of its lifetime, use cannot extend it.
  const capped = await session();
  await setRow(capped.hash, {
    last_used: "-2 hours",
    expire: "1 day",
    max_expire: "2 days",
  });
  await touchSession({ hash: capped.hash, account_id: capped.account_id });
  near((await row(capped.hash)).expire, Date.now() + 2 * DAY);
});

it("an idle session stops working and is not revived by use", async () => {
  const { account_id, hash } = await session();
  await setRow(hash, { last_used: "-15 days", expire: "-1 day" });
  expect(await getAccountIdFromRememberMe(hash)).toBeUndefined();
  await touchSession({ hash, account_id });
  expect(new Date((await row(hash)).expire).valueOf()).toBeLessThan(Date.now());
});

it("re-entering the password starts a new lifetime", async () => {
  const { account_id, hash } = await session();
  await setRow(hash, { max_expire: "1 day", expire: "1 day" });
  await renewSessionLifetime({ db: getPool(), hash, account_id });
  const r = await row(hash);
  near(r.max_expire, Date.now() + 60 * DAY);
  near(r.expire, Date.now() + 14 * DAY);
  near((await authSession(hash)).expire, Date.now() + 14 * DAY);
});

it("maintenance starts old sessions' idle clock without signing anyone out", async () => {
  const { account_id, hash } = await session();
  // A session from before idle timeouts: a 180-day expiry, no last use.
  await getPool().query(
    "UPDATE remember_me SET last_used = NULL, max_expire = NULL, expire = NOW() + INTERVAL '170 days' WHERE hash = $1::CHAR(127)",
    [hash],
  );
  await runSessionMaintenance();
  const r = await row(hash);
  near(r.last_used, Date.now());
  near(r.max_expire, Date.now() + 60 * DAY);
  near(r.expire, Date.now() + 14 * DAY);
  expect(await getAccountIdFromRememberMe(hash)).toBe(account_id);
});

it("maintenance applies a changed idle timeout and deletes ended sessions", async () => {
  const kept = await session();
  const ended = await session();
  await setRow(ended.hash, { expire: "-1 minute" });
  settings.session_idle_timeout_days = 7;
  await runSessionMaintenance();
  near((await row(kept.hash)).expire, Date.now() + 7 * DAY);
  near((await authSession(kept.hash)).expire, Date.now() + 7 * DAY);
  expect(await row(ended.hash)).toBeUndefined();
  expect((await authSession(ended.hash)).revoked_at).not.toBeNull();
});

it("fresh auth renews the lifetime, except for an impersonation session", async () => {
  const own = await session();
  await setRow(own.hash, { max_expire: "1 day", expire: "1 day" });
  await setSessionFreshAuth({
    account_id: own.account_id,
    session_hash: own.hash,
    factor_level: "none",
    fresh_auth_until: new Date(Date.now() + 15 * 60_000),
  });
  near((await row(own.hash)).max_expire, Date.now() + 60 * DAY);

  const impersonated = await session(3600);
  await getPool().query(
    `INSERT INTO account_impersonation_sessions
       (session_hash, subject_account_id, actor_account_id, created, updated, expire)
     VALUES ($1::CHAR(127), $2, $3, NOW(), NOW(), NOW() + INTERVAL '1 hour')`,
    [impersonated.hash, impersonated.account_id, await newAccount()],
  );
  await setSessionFreshAuth({
    account_id: impersonated.account_id,
    session_hash: impersonated.hash,
    factor_level: "none",
    fresh_auth_until: new Date(Date.now() + 15 * 60_000),
  });
  near((await row(impersonated.hash)).max_expire, Date.now() + 3600_000);
});

// A running rehome copies the account's remember_me and auth session rows to
// the destination bay; nothing may change them meanwhile.
async function startRehome(account_id: string): Promise<string> {
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
  const { rows } = await getPool().query(
    `INSERT INTO account_rehome_operations (account_id, source_bay_id, dest_bay_id, stage)
     VALUES ($1, 'bay-0', 'bay-1', 'source_flipped') RETURNING op_id`,
    [account_id],
  );
  return rows[0].op_id;
}

async function finishRehome(op_id: string) {
  await getPool().query(
    "UPDATE account_rehome_operations SET status = 'succeeded' WHERE op_id = $1",
    [op_id],
  );
}

it("session use and maintenance leave a rehoming account's sessions alone", async () => {
  const used = await session();
  const legacy = await session();
  await setRow(used.hash, { last_used: "-13 days", expire: "1 day" });
  await getPool().query(
    "UPDATE remember_me SET last_used = NULL, max_expire = NULL, expire = NOW() + INTERVAL '170 days' WHERE hash = $1::CHAR(127)",
    [legacy.hash],
  );
  const before = await row(used.hash);
  const beforeAuth = await authSession(used.hash);
  const op1 = await startRehome(used.account_id);
  const op2 = await startRehome(legacy.account_id);

  // Signing in with the cookie still works; recording its use is refused.
  await touchSession({ hash: used.hash, account_id: used.account_id });
  expect(await row(used.hash)).toEqual(before);
  expect(await authSession(used.hash)).toEqual(beforeAuth);

  await runSessionMaintenance();
  expect((await row(legacy.hash)).last_used).toBeNull();

  // Once the rehome is over, both proceed.
  await finishRehome(op1);
  await finishRehome(op2);
  resetSessionTouchesForTest();
  await touchSession({ hash: used.hash, account_id: used.account_id });
  near((await row(used.hash)).expire, Date.now() + 14 * DAY);
  near((await authSession(used.hash)).expire, Date.now() + 14 * DAY);
  await runSessionMaintenance();
  near((await row(legacy.hash)).last_used, Date.now());
});

it("session use racing a rehome start waits for it, then is refused", async () => {
  const { account_id, hash } = await session();
  await setRow(hash, { last_used: "-13 days", expire: "1 day" });
  // A rehome starts like createOperation: it takes the account fence and
  // records the running rehome in one transaction. A use that comes in
  // meanwhile waits for the fence, then sees the rehome and changes nothing.
  await startRehome(account_id).then(finishRehome); // creates the table
  const database = (await getPool().query("SELECT current_database() AS d"))
    .rows[0].d;
  const rehome = new Client({ database });
  await rehome.connect();
  try {
    await rehome.query("BEGIN");
    await rehome.query(
      "SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))",
      ["account-rehome", account_id],
    );
    const touched = touchSession({ hash, account_id });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await rehome.query(
      `INSERT INTO account_rehome_operations (account_id, source_bay_id, dest_bay_id)
       VALUES ($1, 'bay-0', 'bay-1')`,
      [account_id],
    );
    await rehome.query("COMMIT");
    await touched;
  } finally {
    await rehome.end();
  }
  near((await row(hash)).expire, Date.now() + DAY);
});

it("a stale session limit setting from elsewhere falls back to the default", async () => {
  settings.session_idle_timeout_days = 5000;
  const { hash } = await session();
  near((await row(hash)).expire, Date.now() + 14 * DAY);
});

function cookieRequest(value: string) {
  const headers = { cookie: `remember_me=${value}`, host: "localhost" };
  const set: string[] = [];
  const req = {
    headers,
    protocol: "http",
    secure: false,
    connection: {},
    socket: {},
    header: (name: string) => headers[name.toLowerCase()],
  };
  const res = {
    getHeader: (name: string) =>
      name.toLowerCase() === "set-cookie" ? set : undefined,
    setHeader: (name: string, value: string | string[]) => {
      if (name.toLowerCase() !== "set-cookie") return;
      set.splice(0, set.length, ...(Array.isArray(value) ? value : [value]));
    },
  };
  return { req, res, set };
}

it("an active browser's cookie is set again for the full cookie lifetime", async () => {
  const own = await session();
  const { req, res, set } = cookieRequest(own.value);
  expect(await refreshSignInCookies({ req, res })).toEqual({ refreshed: true });
  const rememberMe = set.find((c) => c.startsWith(`remember_me=${own.value};`));
  expect(rememberMe).toBeDefined();
  const expires = /expires=([^;]+)/i.exec(rememberMe!)?.[1];
  near(new Date(expires!), Date.now() + 400 * DAY);

  // An impersonation session keeps its own short cookie.
  const impersonated = await session(3600);
  await getPool().query(
    `INSERT INTO account_impersonation_sessions
       (session_hash, subject_account_id, actor_account_id, created, updated, expire)
     VALUES ($1::CHAR(127), $2, $3, NOW(), NOW(), NOW() + INTERVAL '1 hour')`,
    [impersonated.hash, impersonated.account_id, await newAccount()],
  );
  const other = cookieRequest(impersonated.value);
  expect(
    await refreshSignInCookies({ req: other.req, res: other.res }),
  ).toEqual({ refreshed: false });
  expect(other.set).toEqual([]);

  // An ended session gets nothing.
  const ended = await session();
  await setRow(ended.hash, { expire: "-1 minute" });
  const gone = cookieRequest(ended.value);
  expect(await refreshSignInCookies({ req: gone.req, res: gone.res })).toEqual({
    refreshed: false,
  });
});
