/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";

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
import {
  renewSessionLifetime,
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
  return { account_id, hash: created.hash };
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
  await touchSession(capped.hash);
  near((await row(capped.hash)).expire, Date.now() + 2 * DAY);
});

it("an idle session stops working and is not revived by use", async () => {
  const { hash } = await session();
  await setRow(hash, { last_used: "-15 days", expire: "-1 day" });
  expect(await getAccountIdFromRememberMe(hash)).toBeUndefined();
  await touchSession(hash);
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
