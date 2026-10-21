/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const query = jest.fn();
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args: any[]) => query(...args) }),
}));
jest.mock("@cocalc/backend/logger", () => ({
  getLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

import {
  liveRememberMeHashes,
  onSignedOutSessionSweepRequest,
  requestSignedOutSessionSweep,
  sweepSignedOutSessionConnections,
} from "./sign-in-session-sweep";

const A = "a".repeat(127);
const B = "b".repeat(127);

beforeEach(() => query.mockReset());

it("disconnects every socket of a signed-out session, and only those", async () => {
  const disconnect = jest.fn();
  await sweepSignedOutSessionConnections({
    connections: [
      ["s1", { account_id: "x", auth_session_hash: A }],
      ["s2", { account_id: "x", auth_session_hash: B }],
      ["s3", { account_id: "x", auth_session_hash: B }],
      // Not a cookie session (API key, project, bay, hub): never touched.
      ["s4", { account_id: "x" }],
      ["s5", { project_id: "p" }],
      ["s6", undefined],
    ],
    liveSessionHashes: async (hashes) => {
      expect(hashes.sort()).toEqual([A, B]);
      return new Set([A]);
    },
    disconnect,
  });
  expect(disconnect).toHaveBeenCalledWith(["s2", "s3"]);
});

it("keeps everyone connected when the check fails (the next sweep retries)", async () => {
  const disconnect = jest.fn();
  await sweepSignedOutSessionConnections({
    connections: [["s1", { auth_session_hash: A }]],
    liveSessionHashes: async () => {
      throw new Error("db down");
    },
    disconnect,
  });
  expect(disconnect).not.toHaveBeenCalled();
});

it("doesn't query when no socket has a session", async () => {
  const liveSessionHashes = jest.fn();
  await sweepSignedOutSessionConnections({
    connections: [["s1", { project_id: "p" }]],
    liveSessionHashes,
    disconnect: jest.fn(),
  });
  expect(liveSessionHashes).not.toHaveBeenCalled();
});

it("reads live sessions from remember_me, whether or not they expired", async () => {
  query.mockResolvedValue({ rows: [{ hash: A }] });
  await expect(liveRememberMeHashes([A, B])).resolves.toEqual(new Set([A]));
  const [sql, params] = query.mock.calls[0];
  expect(sql).toMatch(/FROM remember_me WHERE hash = ANY\(\$1::CHAR\(127\)\[\]\)/);
  expect(sql).not.toMatch(/expire/);
  expect(params).toEqual([[A, B]]);
});

it("sweeps at once when a sign-out in this process asks", () => {
  const fn = jest.fn();
  const stop = onSignedOutSessionSweepRequest(fn);
  requestSignedOutSessionSweep();
  expect(fn).toHaveBeenCalledTimes(1);
  stop();
  requestSignedOutSessionSweep();
  expect(fn).toHaveBeenCalledTimes(1);
});
