/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockAuthenticate = jest.fn();
const mockAnswer = jest.fn();
const mockWarn = jest.fn();
jest.mock("@cocalc/server/auth/oauth/clients", () => ({
  authenticateOAuthClient: (...args: any[]) => mockAuthenticate(...args),
}));
jest.mock("@cocalc/server/sagebrush/admin-grant", () => ({
  getSagebrushAdminAnswer: (...args: any[]) => mockAnswer(...args),
}));
jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({
    warn: (...args: any[]) => mockWarn(...args),
    debug: () => {},
  }),
}));

import handler from "./admin";

const account_id = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthenticate.mockResolvedValue({ client_id: "sagebrush" });
});

async function post() {
  const { req, res } = createMocks({
    method: "POST",
    headers: { authorization: "Basic synthetic-client-secret" },
    body: { account_id, grant: "synthetic-grant" },
  });
  await handler(req, res);
  return res;
}

it("refuses an authenticated client other than Sagebrush before account lookup", async () => {
  mockAuthenticate.mockResolvedValue({ client_id: "other-client" });
  const res = await post();
  expect(res._getStatusCode()).toBe(401);
  expect(res._getJSONData()).toEqual({ error: "invalid_client" });
  expect(mockAnswer).not.toHaveBeenCalled();
});

it("does not log grant, session or client values from lookup failures", async () => {
  mockAnswer.mockRejectedValue(
    Error("synthetic-grant synthetic-session-hash synthetic-client-secret"),
  );
  const res = await post();
  expect(res._getStatusCode()).toBe(500);
  expect(res._getJSONData()).toEqual({ error: "server_error" });
  expect(mockWarn).toHaveBeenCalledWith("admin check failed");
  expect(JSON.stringify(mockWarn.mock.calls)).not.toMatch(/synthetic-/);
});

it("reads the JSON body, retains no-store, and does not read query parameters", async () => {
  mockAnswer.mockResolvedValue({ admin: false });
  const res = await post();
  expect(res._getStatusCode()).toBe(200);
  expect(res._getHeaders()["cache-control"]).toBe("no-store");
  expect(mockAnswer).toHaveBeenCalledWith({
    account_id,
    grant: "synthetic-grant",
  });
  const { req, res: queryOnly } = createMocks({
    method: "POST",
    query: { account_id, grant: "query-grant" },
    body: {},
  });
  await handler(req, queryOnly);
  expect(queryOnly._getStatusCode()).toBe(400);
  expect(mockAnswer).toHaveBeenCalledTimes(1);
});

it("refuses GET before authentication or account lookup", async () => {
  const { req, res } = createMocks({
    method: "GET",
    query: { account_id, grant: "query-grant" },
  });
  await handler(req, res);
  expect(res._getStatusCode()).toBe(405);
  expect(res._getHeaders().allow).toBe("POST");
  expect(res._getHeaders()["cache-control"]).toBe("no-store");
  expect(mockAuthenticate).not.toHaveBeenCalled();
  expect(mockAnswer).not.toHaveBeenCalled();
});
