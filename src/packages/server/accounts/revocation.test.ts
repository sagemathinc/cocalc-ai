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
const error = jest.fn();
jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({ error, warn: jest.fn(), debug: jest.fn(), info: jest.fn() }),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  contentCutoffNow,
  listAccountRevocationsSince,
  recordContentRevocation,
  revokeContentLinksBestEffort,
} from "./revocation";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [] });
  error.mockClear();
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
  // Password change: after the new hash is saved.
  expect(read("set-password.ts")).toMatch(
    /UPDATE accounts SET password_hash[\s\S]*await revokeContentLinksBestEffort\(account_id\);/,
  );
  // Passkey and 2FA setup sign out other sessions, then revoke content links.
  for (const path of ["../auth/passkeys.ts", "../auth/two-factor.ts"]) {
    expect(read(path)).toMatch(
      /await deleteOtherRememberMe\(accountId, currentHash\);\s*await revokeOtherAuthSessions\(\{[^}]*\}\);\s*(\/\/[^\n]*\n\s*)?await revokeContentLinksBestEffort\(accountId\);/,
    );
  }
});

it("ends the cutoff just before the current second, so links re-issued now stay valid", () => {
  const now = Date.UTC(2026, 9, 19, 4, 0, 0, 700);
  const cutoff = contentCutoffNow(now);
  const iatNow = Math.floor(now / 1000);
  // The host refuses iat * 1000 <= cutoff.
  expect(iatNow * 1000 <= cutoff).toBe(false);
  expect((iatNow - 1) * 1000 <= cutoff).toBe(true);
});
