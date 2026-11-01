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

async function get() {
  const { req, res } = createMocks({
    method: "GET",
    headers: { authorization: "Basic synthetic-client-secret" },
    query: { account_id, grant: "synthetic-grant" },
  });
  await handler(req, res);
  return res;
}

it("refuses an authenticated client other than Sagebrush before account lookup", async () => {
  mockAuthenticate.mockResolvedValue({ client_id: "other-client" });
  const res = await get();
  expect(res._getStatusCode()).toBe(401);
  expect(res._getJSONData()).toEqual({ error: "invalid_client" });
  expect(mockAnswer).not.toHaveBeenCalled();
});

it("does not log grant, session or client values from lookup failures", async () => {
  mockAnswer.mockRejectedValue(Error("synthetic-grant synthetic-session-hash synthetic-client-secret"));
  const res = await get();
  expect(res._getStatusCode()).toBe(500);
  expect(res._getJSONData()).toEqual({ error: "server_error" });
  expect(mockWarn).toHaveBeenCalledWith("admin check failed");
  expect(JSON.stringify(mockWarn.mock.calls)).not.toMatch(/synthetic-/);
});
