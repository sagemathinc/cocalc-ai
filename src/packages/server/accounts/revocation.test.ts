/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const queryMock = jest.fn();
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args: any[]) => queryMock(...args) }),
}));
jest.mock("./security-state", () => ({
  recordAccountSecurityState: jest.fn(async () => {}),
}));
const endOtherSignInSessions = jest.fn(async (_opts: any) => {});
const endAllSignInSessions = jest.fn(async (_id: string) => {});
jest.mock("@cocalc/server/auth/auth-sessions", () => ({
  endOtherSignInSessions: (opts: any) => endOtherSignInSessions(opts),
  endAllSignInSessions: (id: string) => endAllSignInSessions(id),
}));
const requestSweep = jest.fn();
jest.mock("@cocalc/server/conat/socketio/sign-in-session-sweep", () => ({
  requestSignedOutSessionSweep: () => requestSweep(),
}));
const error = jest.fn();
jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({ error, warn: jest.fn(), debug: jest.fn(), info: jest.fn() }),
}));

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  contentCutoffNow,
  endOtherSessions,
  endOtherSessionsOrExplain,
  listAccountRevocationsSince,
  recordContentRevocation,
  revokeContentLinksBestEffort,
} from "./revocation";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [] });
  error.mockClear();
  endOtherSignInSessions.mockClear();
  endAllSignInSessions.mockClear();
});

function contentUpdate(): [string, any[]] {
  const call = queryMock.mock.calls.find(([sql]) =>
    `${sql}`.includes("INSERT INTO account_revocations"),
  );
  if (!call) throw new Error("no revocation write");
  return call as [string, any[]];
}

it("records a content-only cutoff that hosts sync, leaving session revocation alone", async () => {
  await recordContentRevocation(ACCOUNT, 1_800_000_000_000);
  // The first write in this process also adds the column.
  expect(
    queryMock.mock.calls.some(([q]) =>
      /ADD COLUMN IF NOT EXISTS content_revoked_before TIMESTAMP/.test(`${q}`),
    ),
  ).toBe(true);
  const [sql, params] = contentUpdate();
  expect(params).toEqual([ACCOUNT, new Date(1_800_000_000_000)]);
  // Never moves back, and bumps the hosts' sync cursor.
  expect(sql).toMatch(/content_revoked_before = GREATEST\(/);
  expect(sql).toMatch(/updated_at = NOW\(\)/);
  // The ON CONFLICT update doesn't touch revoked_before (sessions).
  expect(sql.split("DO UPDATE SET")[1]).not.toMatch(/\brevoked_before\b(?! *=)/);
  expect(sql.split("DO UPDATE SET")[1]).not.toMatch(/^\s*revoked_before\s*=/m);
});

it("sends the content cutoff to hosts with the session one", async () => {
  queryMock.mockImplementation(async (sql: string) =>
    sql.includes("FROM account_revocations")
      ? {
          rows: [
            {
              account_id: ACCOUNT,
              revoked_before_ms: "0",
              // Like the database: only if selected.
              ...(sql.includes("AS content_revoked_before_ms")
                ? { content_revoked_before_ms: "1800000000000" }
                : {}),
              ...(sql.includes("AS browser_revoked_before_ms")
                ? { browser_revoked_before_ms: "1800000000001" }
                : {}),
              updated_ms: "5",
            },
          ],
        }
      : { rows: [] },
  );
  await expect(listAccountRevocationsSince({})).resolves.toEqual([
    {
      account_id: ACCOUNT,
      revoked_before_ms: 0,
      content_revoked_before_ms: 1_800_000_000_000,
      browser_revoked_before_ms: 1_800_000_000_001,
      updated_ms: 5,
    },
  ]);
});

it("best effort: a failure is logged, not thrown (the password already changed)", async () => {
  queryMock.mockRejectedValue(new Error("db down"));
  await expect(revokeContentLinksBestEffort(ACCOUNT)).resolves.toBeUndefined();
  expect(error).toHaveBeenCalled();
});

it("rejects an invalid account id", async () => {
  await expect(recordContentRevocation("nope")).rejects.toThrow("invalid");
});

it("is called wherever a password changes or other sessions are signed out", () => {
  const read = (path: string) => readFileSync(join(__dirname, path), "utf8");
  // Password change: after the new hash is saved, keeping this browser.
  expect(read("set-password.ts")).toMatch(
    /UPDATE accounts SET password_hash[\s\S]*await endOtherSessionsOrExplain\(\{ account_id, keep_session_hash \}\);/,
  );
  // Password reset: every session ends.
  expect(read("set-password-from-reset.ts")).toMatch(
    /UPDATE accounts SET password_hash[\s\S]*await endOtherSessionsOrExplain\(\{ account_id \}\);/,
  );
  // The API route keeps the browser that changed the password.
  expect(
    read("../../http-api/pages/api/v2/accounts/set-password.ts"),
  ).toMatch(/setPassword\([^)]*getRememberMeHash\(req\),?\s*\)/);
  // Passkey and 2FA setup sign out other sessions, everywhere.
  for (const path of ["../auth/passkeys.ts", "../auth/two-factor.ts"]) {
    expect(read(path)).toMatch(
      /await endOtherSessionsOrExplain\(\{\s*account_id: accountId,\s*keep_session_hash: currentHash,\s*\}\);/,
    );
  }
  // Signing out other sessions goes through endOtherSessions, which also ends
  // them on project hosts: no other caller of the hub-only helpers.
  const callers = (dir: string, re: RegExp): string[] =>
    readdirSync(join(__dirname, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? e.name === "node_modules" || e.name === "dist"
          ? []
          : callers(`${dir}/${e.name}`, re)
        : e.name.endsWith(".ts") &&
            !e.name.endsWith(".test.ts") &&
            re.test(read(`${dir}/${e.name}`))
          ? [`${dir}/${e.name}`]
          : [],
    );
  expect(callers("..", /await endOtherSignInSessions\(/)).toEqual([
    "../accounts/revocation.ts",
  ]);
});

it("ends other sessions on the hub and on hosts, keeping this browser", async () => {
  const order: string[] = [];
  endOtherSignInSessions.mockImplementationOnce(async () => {
    order.push("sessions");
  });
  queryMock.mockImplementation(async (sql: string) => {
    if (`${sql}`.includes("INSERT INTO account_revocations")) order.push("cutoff");
    return { rows: [] };
  });
  let t = Date.UTC(2026, 9, 20, 22, 0, 0, 700);
  const sleep = jest.fn(async (ms: number) => {
    order.push(`sleep ${ms}`);
    t += ms;
  });
  await endOtherSessions({
    account_id: ACCOUNT,
    keep_session_hash: "h".repeat(127),
    now: () => t,
    sleep,
  });
  expect(endOtherSignInSessions).toHaveBeenCalledWith({
    account_id: ACCOUNT,
    keep_session_hash: "h".repeat(127),
  });
  expect(endAllSignInSessions).not.toHaveBeenCalled();
  // Sessions end before the cutoff (no new host credential in between), and
  // we return only once the cutoff's second is over.
  expect(order).toEqual(["sessions", "cutoff", "sleep 300"]);
  const [sql, params] = contentUpdate();
  // To the millisecond: every credential from this second is refused.
  expect(params).toEqual([ACCOUNT, new Date(Date.UTC(2026, 9, 20, 22, 0, 0, 700))]);
  expect(sql).toMatch(/browser_revoked_before = GREATEST\(/);
  expect(sql).toMatch(/content_revoked_before = GREATEST\(/);
  // Not the account-wide cutoff: the hub socket and agent runs read that.
  expect(sql.split("DO UPDATE SET")[1]).not.toMatch(/^\s*revoked_before\s*=/m);
  // This process's sockets of the ended sessions close now.
  expect(requestSweep).toHaveBeenCalled();
});

it("ends every session when there is no session to keep (password reset)", async () => {
  await endOtherSessions({ account_id: ACCOUNT, sleep: async () => {} });
  expect(endAllSignInSessions).toHaveBeenCalledWith(ACCOUNT);
  expect(endOtherSignInSessions).not.toHaveBeenCalled();
  contentUpdate();
});

it("says so when other sessions could not be signed out", async () => {
  endOtherSignInSessions.mockRejectedValueOnce(new Error("db down"));
  await expect(
    endOtherSessionsOrExplain({
      account_id: ACCOUNT,
      keep_session_hash: "h",
      sleep: async () => {},
    }),
  ).rejects.toThrow(/could not be signed out/);
  expect(error).toHaveBeenCalled();
});

it("ends the cutoff just before the current second, so links re-issued now stay valid", () => {
  const now = Date.UTC(2026, 9, 19, 4, 0, 0, 700);
  const cutoff = contentCutoffNow(now);
  const iatNow = Math.floor(now / 1000);
  // The host refuses iat * 1000 <= cutoff.
  expect(iatNow * 1000 <= cutoff).toBe(false);
  expect((iatNow - 1) * 1000 <= cutoff).toBe(true);
});
