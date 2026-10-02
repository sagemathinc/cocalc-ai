import { repairScheduledCollectionExpiry } from "./admin-db";

const mockIsAdmin = jest.fn();
const mockFreshAuth = jest.fn();
const mockOwnership = jest.fn();
const mockLocal = jest.fn();
const mockRemote = jest.fn();
const mockAudit = jest.fn();

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args) => mockIsAdmin(...args),
}));
jest.mock("./dangerous-session-auth", () => ({
  requireDangerousSessionAuth: (...args) => mockFreshAuth(...args),
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: (...args) => mockOwnership(...args),
}));
jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  getInterBayBridge: () => ({
    projectLro: () => ({ repairScheduledCollectionExpiry: mockRemote }),
  }),
}));
jest.mock("@cocalc/server/lro/scheduled-collection-expiry-repair", () => ({
  normalizeExpiryRepairRequest: jest.fn(),
  repairScheduledCollectionExpiryLocal: (...args) => mockLocal(...args),
}));
jest.mock("@cocalc/database/postgres/central-log", () => ({
  __esModule: true,
  default: (...args) => mockAudit(...args),
}));
jest.mock("@cocalc/server/project-host/client", () => ({}));
jest.mock("@cocalc/server/projects/maintenance-status", () => ({}));
jest.mock("@cocalc/server/projects/restore-drill-attestation", () => ({}));
jest.mock("@cocalc/server/lro/lro-db", () => ({}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));

const actor = "11111111-1111-4111-8111-111111111111";
const request = {
  account_id: actor,
  session_hash: "synthetic-session",
  browser_id: "synthetic-browser",
  project_id: "22222222-2222-4222-8222-222222222222",
  op_id: "33333333-3333-4333-8333-333333333333",
  expected_updated_at: "2026-01-01T00:00:00Z",
  expected_expires_at: "2026-01-08T00:00:00Z",
  expected_run_at: "2026-01-20T00:00:00Z",
  idempotency_key: "synthetic-request",
  reason: "synthetic test",
};
beforeEach(() => {
  jest.clearAllMocks();
  mockIsAdmin.mockResolvedValue(true);
  mockFreshAuth.mockResolvedValue(undefined);
  mockOwnership.mockResolvedValue({ bay_id: "bay-0" });
  mockLocal.mockResolvedValue({
    audit_id: "audit",
    committed: false,
    replayed: false,
  });
  mockRemote.mockResolvedValue({
    audit_id: "remote-audit",
    committed: false,
    replayed: false,
  });
});

test.each([false, true])(
  "fresh auth is required for preview/commit=%s before ownership or DB access",
  async (commit) => {
    mockFreshAuth.mockRejectedValue(new Error("fresh auth required"));
    await expect(
      repairScheduledCollectionExpiry({ ...request, commit }),
    ).rejects.toThrow("fresh auth required");
    expect(mockOwnership).not.toHaveBeenCalled();
    expect(mockLocal).not.toHaveBeenCalled();
    expect(mockRemote).not.toHaveBeenCalled();
  },
);

test("non-admin is rejected before fresh auth or routing", async () => {
  mockIsAdmin.mockResolvedValue(false);
  await expect(repairScheduledCollectionExpiry(request)).rejects.toThrow(
    "admin privileges required",
  );
  expect(mockFreshAuth).not.toHaveBeenCalled();
  expect(mockOwnership).not.toHaveBeenCalled();
});

test("local ownership uses authenticated actor, not caller-supplied actor", async () => {
  await repairScheduledCollectionExpiry({
    ...request,
    actor_id: "spoofed",
  } as any);
  expect(mockFreshAuth).toHaveBeenCalledWith({
    account_id: actor,
    session_hash: request.session_hash,
    browser_id: request.browser_id,
    require_second_factor: "if_enabled",
  });
  expect(mockLocal).toHaveBeenCalledWith(
    expect.objectContaining({ actor_id: actor }),
  );
  expect(mockLocal.mock.calls[0][0]).not.toHaveProperty("session_hash");
  expect(mockAudit).toHaveBeenCalledWith(
    expect.objectContaining({ event: "admin_db_operator" }),
  );
});

test("remote project routes to its authoritative bay without a local write", async () => {
  mockOwnership.mockResolvedValue({ bay_id: "bay-1" });
  await repairScheduledCollectionExpiry(request);
  expect(mockLocal).not.toHaveBeenCalled();
  expect(mockRemote).toHaveBeenCalledWith(
    expect.objectContaining({
      actor_id: actor,
      project_id: request.project_id,
    }),
  );
});

test("unknown ownership fails closed", async () => {
  mockOwnership.mockResolvedValue(null);
  await expect(repairScheduledCollectionExpiry(request)).rejects.toThrow(
    "ownership could not be resolved",
  );
  expect(mockLocal).not.toHaveBeenCalled();
  expect(mockRemote).not.toHaveBeenCalled();
});
