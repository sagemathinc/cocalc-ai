import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const account = "11111111-1111-4111-8111-111111111111";
const project = "22222222-2222-4222-8222-222222222222";
const mockAccount = jest.fn();
const mockPrincipal = jest.fn();
const mockLegacy = jest.fn();
const mockSummaries = jest.fn();
const mockAdmin = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args) => mockAccount(...args),
}));
jest.mock("@cocalc/server/auth/api", () => ({
  getAccountFromApiKey: (...args) => mockPrincipal(...args),
}));
jest.mock("@cocalc/server/projects/get", () => ({
  __esModule: true,
  default: (...args) => mockLegacy(...args),
}));
jest.mock("@cocalc/server/conat/api/projects", () => ({
  listProjectSummariesForApiKey: (principal, opts) =>
    mockSummaries({ ...opts, account_id: principal.account_id }),
}));
jest.mock("@cocalc/server/accounts/is-in-group", () => ({
  __esModule: true,
  default: (...args) => mockAdmin(...args),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockAccount.mockResolvedValue(account);
  mockPrincipal.mockResolvedValue({
    account_id: account,
    api_key_id: 1,
    key_id: "key-1",
    auth_method: "api_key",
    capabilities: ["project:list"],
    allowed_project_ids: [],
  });
  mockSummaries.mockResolvedValue({
    projects: [
      {
        project_id: project,
        title: "SageMath",
        description: "Worksheets",
        host_id: "host-1",
        state: "running",
        last_edited: null,
      },
    ],
    next_offset: 499,
  });
  mockLegacy.mockResolvedValue([]);
  mockAdmin.mockResolvedValue(true);
});

async function request(body: object = {}, key = true) {
  const { req, res } = createMocks({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: "Bearer cocalc_api_key_test" } : {}),
    },
    body,
  });
  const { default: handler } = await import("./get");
  await handler(req, res);
  return res;
}

test("keys use the owner-routed bounded service and preserve legacy fields", async () => {
  const res = await request({ limit: 500, offset: 4, search: "Sage" });
  expect(mockSummaries).toHaveBeenCalledWith({
    account_id: account,
    limit: 500,
    offset: 4,
    search: "Sage",
  });
  expect(res._getJSONData()).toEqual([
    { project_id: project, title: "SageMath", description: "Worksheets" },
  ]);
  expect(res.getHeader("X-CoCalc-Next-Offset")).toBe("499");
  expect(mockLegacy).not.toHaveBeenCalled();
  expect(mockAdmin).not.toHaveBeenCalled();
});

test("defaults and final-page continuation remain explicit", async () => {
  mockSummaries.mockResolvedValue({ projects: [], next_offset: null });
  const res = await request({ limit: null });
  expect(mockSummaries).toHaveBeenCalledWith({
    account_id: account,
    limit: 50,
    offset: 0,
    search: undefined,
  });
  expect(res._getJSONData()).toEqual([]);
  expect(res.getHeader("X-CoCalc-Next-Offset")).toBeUndefined();
});

test.each(["limit must be between 1 and 500", "account home unavailable"])(
  "does not fall back to a local legacy reader after %s",
  async (error) => {
    mockSummaries.mockRejectedValue(new Error(error));
    const res = await request();
    expect(res._getJSONData()).toEqual({ error });
    expect(mockLegacy).not.toHaveBeenCalled();
  },
);

test("an administrator's key cannot nominate another account", async () => {
  const res = await request({ account_id: project });
  expect(res._getJSONData()).toEqual({
    error: "API keys may only list projects for their own account",
  });
  expect(mockSummaries).not.toHaveBeenCalled();
  expect(mockLegacy).not.toHaveBeenCalled();
  expect(mockAdmin).not.toHaveBeenCalled();
});

test("listing requires its own capability", async () => {
  mockPrincipal.mockResolvedValue({
    account_id: account,
    capabilities: ["account:read"],
    allowed_project_ids: [],
  });
  const res = await request();
  expect(res._getJSONData()).toEqual({
    error: "API key lacks required capability 'project:list'",
  });
  expect(mockSummaries).not.toHaveBeenCalled();
  expect(mockLegacy).not.toHaveBeenCalled();
});

test("browser session listing retains the legacy path", async () => {
  const res = await request({}, false);
  expect(res._getJSONData()).toEqual([]);
  expect(mockPrincipal).not.toHaveBeenCalled();
  expect(mockSummaries).not.toHaveBeenCalled();
  expect(mockLegacy).toHaveBeenCalledWith({
    account_id: account,
    limit: 50,
    offset: undefined,
    search: undefined,
  });
});
