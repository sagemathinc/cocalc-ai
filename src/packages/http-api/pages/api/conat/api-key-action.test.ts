/** @jest-environment node */
import { createMocks } from "@cocalc/http-api/lib/api/test-framework";
import { getAccountFromApiKey } from "@cocalc/server/auth/api";
import { requestApiKeyAction } from "@cocalc/server/api/key-action-routing";
import handler from "./api-key-action";

jest.mock("@cocalc/server/auth/api", () => ({
  getAccountFromApiKey: jest.fn(),
}));
jest.mock("@cocalc/server/api/key-action-routing", () => ({
  requestApiKeyAction: jest.fn(),
}));
const principal = {
  account_id: "11111111-1111-4111-8111-111111111111",
  api_key_id: 1,
  key_id: "requester-key",
  auth_method: "api_key" as const,
  capabilities: ["api-key:revoke:request" as const],
  allowed_project_ids: [],
  scope_revision: 1,
};
const body = {
  request_id: "22222222-2222-4222-8222-222222222222",
  action: { kind: "revoke_api_key", target_key_id: "target-key" },
};
beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(getAccountFromApiKey).mockResolvedValue(principal);
});
test("requests an action using the authenticated principal, never a body principal", async () => {
  const { req, res } = createMocks({ method: "POST", body });
  jest
    .mocked(requestApiKeyAction)
    .mockResolvedValue({ status: "pending" } as any);
  await handler(req, res);
  expect(requestApiKeyAction).toHaveBeenCalledWith(principal, body);
  expect(res._getJSONData()).toEqual({ status: "pending" });
});
test.each(["GET", "DELETE"])(
  "rejects %s before authentication",
  async (method) => {
    const { req, res } = createMocks({ method: method as any, body });
    await handler(req, res);
    expect(res._getJSONData().error).toBe("POST required");
    expect(getAccountFromApiKey).not.toHaveBeenCalled();
  },
);
test("requires explicit management request scope", async () => {
  jest
    .mocked(getAccountFromApiKey)
    .mockResolvedValue({ ...principal, capabilities: ["account:read"] });
  const { req, res } = createMocks({ method: "POST", body });
  await handler(req, res);
  expect(res._getJSONData().error).toBeTruthy();
  expect(requestApiKeyAction).not.toHaveBeenCalled();
});
test("does not accept a cookie-only request", async () => {
  jest.mocked(getAccountFromApiKey).mockResolvedValue(undefined);
  const { req, res } = createMocks({ method: "POST", body });
  await handler(req, res);
  expect(res._getJSONData().error).toMatch(/API key authentication/);
  expect(requestApiKeyAction).not.toHaveBeenCalled();
});

test.each(["principal", "account_id", "approved", "session_hash"])(
  "rejects injected %s",
  async (field) => {
    const { req, res } = createMocks({
      method: "POST",
      body: { ...body, [field]: "forged" },
    });
    await handler(req, res);
    expect(res._getJSONData().error).toMatch(/unknown/);
    expect(requestApiKeyAction).not.toHaveBeenCalled();
  },
);
