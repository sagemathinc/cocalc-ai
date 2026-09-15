/** @jest-environment node */
import { createMocks } from "@cocalc/http-api/lib/api/test-framework";
import handler from "./auth/cli/agent/approve";

const mockAccount = jest.fn(),
  mockParams = jest.fn(),
  mockSession = jest.fn(),
  mockApprove = jest.fn();
jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args) => mockAccount(...args),
}));
jest.mock("@cocalc/http-api/lib/api/get-params", () => ({
  __esModule: true,
  default: (...args) => mockParams(...args),
}));
jest.mock("@cocalc/server/auth/remember-me", () => ({
  getRememberMeHash: (...args) => mockSession(...args),
}));
jest.mock("@cocalc/server/agents/external", () => ({
  approveExternalAgentLogin: (...args) => mockApprove(...args),
}));

beforeEach(() => {
  mockAccount.mockReset().mockResolvedValue("real-account");
  mockSession.mockReset().mockReturnValue("real-session");
  mockParams
    .mockReset()
    .mockReturnValue({
      account_id: "forged-account",
      session_hash: "forged-session",
      origin_bay_id: "origin",
      challenge_id: "challenge",
      targets: [],
      ttl_seconds: 3600,
    });
  mockApprove
    .mockReset()
    .mockResolvedValue({ installation: { installation_id: "challenge" } });
});

test("external approval takes principal and bound session only from authenticated request", async () => {
  const { req, res } = createMocks({ method: "POST" });
  await handler(req, res);
  expect(mockApprove).toHaveBeenCalledWith({
    account_id: "real-account",
    session_hash: "real-session",
    origin_bay_id: "origin",
    challenge_id: "challenge",
    targets: [],
    ttl_seconds: 3600,
    agent_id: undefined,
  });
  expect(res._getJSONData()).toEqual({
    installation: { installation_id: "challenge" },
  });
});
test("API-key or missing-cookie approval fails before the enrollment service", async () => {
  const keyed = createMocks({
    method: "POST",
    headers: { authorization: "Bearer not-a-human-session" },
  });
  await handler(keyed.req, keyed.res);
  expect(keyed.res._getJSONData().error).toMatch(/API keys/);
  mockSession.mockReturnValueOnce(undefined);
  const missing = createMocks({ method: "POST" });
  await handler(missing.req, missing.res);
  expect(missing.res._getJSONData().error).toMatch(/signed in/);
  expect(mockApprove).not.toHaveBeenCalled();
});
test("fresh auth failure remains machine-readable for the existing modal flow", async () => {
  mockApprove.mockRejectedValueOnce(
    Object.assign(new Error("fresh auth is required"), {
      code: "fresh_auth_required",
    }),
  );
  const { req, res } = createMocks({ method: "POST" });
  await handler(req, res);
  expect(res._getJSONData()).toEqual({
    error: "fresh auth is required",
    code: "fresh_auth_required",
  });
});
