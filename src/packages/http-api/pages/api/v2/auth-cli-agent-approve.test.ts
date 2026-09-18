/** @jest-environment node */
import { createMocks } from "@cocalc/http-api/lib/api/test-framework";
import handler from "./auth/cli/agent/approve";
import installations from "./auth/cli/agent/installations";

const mockAccount = jest.fn(),
  mockParams = jest.fn(),
  mockSession = jest.fn(),
  mockApprove = jest.fn();
const mockRevoke = jest.fn(),
  mockList = jest.fn();
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
jest.mock("@cocalc/server/agents/store", () => ({ AgentStore: class {} }));
jest.mock("@cocalc/http-api/lib/api/assert-same-origin-mutation", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("@cocalc/server/agents/external", () => ({
  approveExternalAgentLogin: (...args) => mockApprove(...args),
  assertExternalAgentLoginEnabled: jest.fn(),
  externalStore: () => ({ revoke: mockRevoke, list: mockList }),
}));

beforeEach(() => {
  mockAccount.mockReset().mockResolvedValue("real-account");
  mockSession.mockReset().mockReturnValue("real-session");
  mockParams.mockReset().mockReturnValue({
    account_id: "forged-account",
    session_hash: "forged-session",
    origin_bay_id: "origin",
    challenge_id: "challenge",
    agent_session_id: "session",
    ttl_seconds: 3600,
  });
  mockApprove
    .mockReset()
    .mockResolvedValue({ installation: { installation_id: "challenge" } });
});

test("installation revocation uses the signed-in account, not supplied authority", async () => {
  mockParams.mockReturnValue({
    action: "revoke",
    installation_id: "installation",
    account_id: "forged",
  });
  mockRevoke.mockReset().mockResolvedValue(undefined);
  mockList.mockReset().mockResolvedValue([]);
  const { req, res } = createMocks({ method: "POST" });
  await installations(req, res);
  expect(mockRevoke).toHaveBeenCalledWith("real-account", "installation");
  expect(res._getJSONData()).toEqual({ enabled: true, installations: [] });
  const keyed = createMocks({
    method: "POST",
    headers: { authorization: "Bearer external-token" },
  });
  await installations(keyed.req, keyed.res);
  expect(keyed.res._getJSONData().error).toMatch(/browser session/);
  expect(mockRevoke).toHaveBeenCalledTimes(1);
});

test("external approval takes principal and bound session only from authenticated request", async () => {
  const { req, res } = createMocks({ method: "POST" });
  await handler(req, res);
  expect(mockApprove).toHaveBeenCalledWith({
    account_id: "real-account",
    session_hash: "real-session",
    origin_bay_id: "origin",
    challenge_id: "challenge",
    agent_session_id: "session",
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
