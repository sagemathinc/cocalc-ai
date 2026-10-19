/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Codex on #1134: once this request has created the site pool's global
// hold, any failure before its reservation is returned (the connection,
// BEGIN, any query, COMMIT, even ROLLBACK) releases that hold exactly once;
// a hold it did not create is never released. The database and the site
// pool are stand-ins here, so each step can fail on its own.

const mockConnect = jest.fn();
const mockPoolQuery = jest.fn(async () => ({ rows: [] }));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ connect: mockConnect, query: mockPoolQuery }),
}));
const mockReserveGlobal = jest.fn();
const mockFinishGlobal = jest.fn();
jest.mock("./site-funded-speech-reservations", () => ({
  reserveSiteFundedSpeechGlobal: (o: any) => mockReserveGlobal(o),
  finishSiteFundedSpeechGlobal: (o: any) => mockFinishGlobal(o),
}));
jest.mock("./save-response", () => ({
  ensureExactAIUsageSchema: async () => {},
}));
jest.mock("@cocalc/server/membership/usage-windows", () => ({
  ensureAccountUsageWindowsForEvent: async () => {},
}));
jest.mock("./usage-status", () => ({
  getAIUsageStatus: async () => ({
    units_per_dollar: 100_000,
    windows: [
      {
        window: "5h",
        used: 0,
        limit: 100,
        starts_at: new Date(0),
        resets_at: new Date(8.64e15),
      },
    ],
  }),
}));

import { siteFundedDecideFunding } from "./board-decide-funding";

const request = {
  accountId: "11111111-1111-4111-8111-111111111111",
  requestId: "22222222-2222-4222-8222-222222222222",
  microusd: 2,
  board: {
    projectId: "33333333-3333-4333-8333-333333333333",
    path: "/home/user/plan.board.json",
  },
};

// A client whose query fails at the statement matching `failOn`.
function client(failOn?: RegExp, rollbackFails = false) {
  const sql: string[] = [];
  const c = {
    sql,
    release: jest.fn(),
    query: jest.fn(async (text: string) => {
      sql.push(text.trim().split(/\s+/).slice(0, 3).join(" "));
      if (/^ROLLBACK/.test(text) && rollbackFails) {
        throw new Error("connection terminated");
      }
      if (failOn?.test(text)) throw new Error(`failed: ${failOn}`);
      if (/FROM accounts/.test(text))
        return { rows: [{ account_id: request.accountId }] };
      if (/COUNT\(\*\)/.test(text)) return { rows: [{ n: 0 }] };
      if (/SUM\(/.test(text)) return { rows: [{ used: 0 }] };
      return { rows: [] };
    }),
  };
  return c;
}

const funding = siteFundedDecideFunding({ model: "typesafe/jev-1.14" });
const released = () =>
  mockFinishGlobal.mock.calls.filter(([o]) => o.status === "released");

beforeEach(() => {
  jest.clearAllMocks();
  mockReserveGlobal.mockResolvedValue({
    requestId: request.requestId,
    reservedMicrousd: 2,
    created: true,
  });
  mockFinishGlobal.mockResolvedValue(undefined);
});

test("the connection fails: the hold is released once", async () => {
  mockConnect.mockRejectedValueOnce(new Error("too many clients"));
  await expect(funding.reserve(request)).rejects.toThrow("too many clients");
  expect(released()).toEqual([
    [{ requestId: request.requestId, status: "released" }],
  ]);
});

test("BEGIN fails: released once, rolled back, the client returned", async () => {
  const c = client(/^BEGIN/);
  mockConnect.mockResolvedValueOnce(c);
  await expect(funding.reserve(request)).rejects.toThrow("failed");
  expect(released()).toHaveLength(1);
  expect(c.sql).toContain("ROLLBACK");
  expect(c.release).toHaveBeenCalledTimes(1);
  expect(c.release).toHaveBeenCalledWith(undefined);
});

test.each([
  ["the account lock", /FOR UPDATE/],
  ["the stale-hold update", /^UPDATE ai_usage_log/],
  ["the minute count", /INTERVAL '1 minute'/],
  ["the board count", /project_id=\$5/],
  ["the allowance sum", /SUM\(/],
  ["the insert", /^INSERT INTO ai_usage_log/],
  ["COMMIT", /^COMMIT/],
])("%s fails: released once", async (_name, failOn) => {
  const c = client(failOn);
  mockConnect.mockResolvedValueOnce(c);
  await expect(funding.reserve(request)).rejects.toThrow("failed");
  expect(released()).toHaveLength(1);
  expect(c.release).toHaveBeenCalledTimes(1);
});

test("the rollback fails too: still released once, the client discarded", async () => {
  const c = client(/FOR UPDATE/, true);
  mockConnect.mockResolvedValueOnce(c);
  await expect(funding.reserve(request)).rejects.toThrow("failed");
  expect(released()).toHaveLength(1);
  expect(c.release).toHaveBeenCalledTimes(1);
  expect(c.release).toHaveBeenCalledWith(true);
});

test("a release that fails is not retried and doesn't hide the error", async () => {
  mockConnect.mockRejectedValueOnce(new Error("too many clients"));
  mockFinishGlobal.mockRejectedValueOnce(new Error("seed bay unreachable"));
  await expect(funding.reserve(request)).rejects.toThrow("too many clients");
  expect(released()).toHaveLength(1);
});

test("a hold this request didn't create is never released", async () => {
  mockReserveGlobal.mockResolvedValueOnce({
    requestId: request.requestId,
    reservedMicrousd: 2,
    created: false,
  });
  await expect(funding.reserve(request)).rejects.toMatchObject({ code: 409 });
  expect(mockConnect).not.toHaveBeenCalled();
  expect(mockFinishGlobal).not.toHaveBeenCalled();
});

test("a reservation returned holds the global hold for its commit or release", async () => {
  const c = client();
  mockConnect.mockResolvedValueOnce(c);
  const r = await funding.reserve(request);
  expect(mockFinishGlobal).not.toHaveBeenCalled();
  expect(c.sql).toContain("COMMIT");
  expect(c.release).toHaveBeenCalledTimes(1);
  await r.release();
  expect(released()).toHaveLength(1);
});
