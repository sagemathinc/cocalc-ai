const mockQuery = jest.fn();
const mockRemote = jest.fn();
const mockRemoteHostUrl = jest.fn();
const mockUsage = jest.fn();
const mockAccountUsage = jest.fn();
const mockHomeBay = jest.fn();
const mockUsageAccount = jest.fn();
const mockQuota = jest.fn();
const mockHostConnection = jest.fn(() => ({
  getApiRelayTarget: mockRemote,
  getApiRelayHostUrl: mockRemoteHostUrl,
  updateApiRelayUsage: mockUsage,
  updateApiRelayAccountUsage: mockAccountUsage,
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: (...args) => mockHomeBay(...args),
}));
jest.mock("@cocalc/server/membership/project-usage", () => ({
  getProjectUsageAccountId: (...args) => mockUsageAccount(...args),
}));
jest.mock("@cocalc/server/membership/api-relay-quota", () => ({
  validateRelayUsage: jest.fn(),
  updateApiRelayQuota: (...args) => mockQuota(...args),
}));
const mockResolveHostBay = jest.fn();
const mockResolveProjectBay = jest.fn();
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: mockQuery }),
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({ dns: "example.test" }),
}));
jest.mock("@cocalc/backend/base-path", () => ({
  __esModule: true,
  default: "/site",
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-a",
}));
jest.mock("@cocalc/server/bay-public-origin", () => ({
  getSitePublicOrigin: async () => "https://example.test",
  getBayPublicOrigin: async (bay) => `https://${bay}.example.test`,
  getClusterBayPublicOrigins: async () => ({
    "bay-b": "https://home-bay.example.test",
  }),
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveHostBay: (...args) => mockResolveHostBay(...args),
  resolveProjectBay: (...args) => mockResolveProjectBay(...args),
}));
jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  getInterBayBridge: () => ({ hostConnection: mockHostConnection }),
}));

import {
  resolveLocalProjectApiRelayTarget,
  resolveLocalApiRelayHostUrl,
  resolveProjectApiRelayTarget,
  resolveProjectApiRelayHub,
  updateProjectApiRelayUsage,
  updateLocalProjectApiRelayUsage,
  updateLocalApiRelayAccountUsage,
} from "./project-api-relay";

const target = {
  target_host_id: "11111111-1111-4111-8111-111111111111",
  target_project_id: "22222222-2222-4222-8222-222222222222",
};
const sourceHost = "33333333-3333-4333-8333-333333333333";
beforeEach(() => {
  jest.clearAllMocks();
  mockResolveHostBay.mockResolvedValue({ bay_id: "bay-a" });
  mockResolveProjectBay.mockResolvedValue({ bay_id: "bay-a" });
  mockHomeBay.mockResolvedValue({ home_bay_id: "bay-a" });
  mockUsageAccount.mockResolvedValue(sourceHost);
  mockQuery.mockResolvedValue({
    rows: [{ public_url: "https://host.example.test" }],
  });
});

const usage = {
  host_id: sourceHost,
  project_id: target.target_project_id,
  session_id: target.target_host_id,
  sequence: 0,
  sent: 0,
  received: 0,
  transport: "http" as const,
  target: "hub",
};

it("routes source attribution to the project owner before the account home bay", async () => {
  mockResolveProjectBay.mockResolvedValue({ bay_id: "bay-b" });
  await updateProjectApiRelayUsage(usage);
  expect(mockUsage).toHaveBeenCalledWith(usage);
  expect(mockQuery).not.toHaveBeenCalled();
  mockHomeBay.mockResolvedValue({ home_bay_id: "bay-c" });
  await updateLocalProjectApiRelayUsage({
    ...usage,
    account_id: "spoofed",
  } as any);
  expect(mockAccountUsage).toHaveBeenCalledWith({
    ...usage,
    account_id: sourceHost,
  });
  expect(mockHostConnection).toHaveBeenCalledWith("bay-c");
  expect(mockQuota).not.toHaveBeenCalled();
});

it("fails closed for moved sources, missing attribution and stale home-bay routes", async () => {
  await expect(
    updateProjectApiRelayUsage({ ...usage, host_id: undefined }),
  ).rejects.toThrow("authentication required");
  mockQuery.mockResolvedValue({ rows: [] });
  await expect(updateLocalProjectApiRelayUsage(usage)).rejects.toThrow(
    "not on this host",
  );
  mockQuery.mockResolvedValue({ rows: [{}] });
  mockUsageAccount.mockResolvedValue(undefined);
  await expect(updateLocalProjectApiRelayUsage(usage)).rejects.toThrow(
    "no usage account",
  );
  mockHomeBay.mockResolvedValue({ home_bay_id: "bay-b" });
  await expect(
    updateLocalApiRelayAccountUsage({ ...usage, account_id: sourceHost }),
  ).rejects.toThrow("not homed");
  expect(mockQuota).not.toHaveBeenCalled();
});

it.each(["https://example.test/site", "https://home-bay.example.test/site"])(
  "admits configured site/bay API base %s",
  async (url) => {
    await expect(
      resolveProjectApiRelayHub({ host_id: sourceHost, url }),
    ).resolves.toEqual({ url });
    expect(mockQuery).not.toHaveBeenCalled();
  },
);

it.each([
  "https://evil-example.test/site",
  "https://unknown-bay.example.test/site",
  "https://home-bay.example.test/arbitrary-path",
  "http://home-bay.example.test/site",
  "https://home-bay.example.test:8443/site",
  "https://example.test/site?target=evil",
  "https://user:secret@example.test/site",
  "file:///etc/passwd",
])("rejects unconfigured API base %s", async (url) => {
  await expect(
    resolveProjectApiRelayHub({ host_id: sourceHost, url }),
  ).rejects.toThrow();
});

it("does not provide relay hub lookup to account/project credentials", async () => {
  await expect(
    resolveProjectApiRelayHub({ url: "https://example.test/site" }),
  ).rejects.toThrow("authentication required");
});

it("returns the canonical site for routers without site environment configuration", async () => {
  await expect(
    resolveProjectApiRelayHub({ host_id: sourceHost }),
  ).resolves.toEqual({ url: "https://example.test/site" });
});

it("resolves only an assigned, nondeleted project and host in the authoritative bay", async () => {
  await expect(
    resolveProjectApiRelayTarget({ host_id: sourceHost, ...target }),
  ).resolves.toEqual({
    host_id: target.target_host_id,
    project_id: target.target_project_id,
    url: "https://host.example.test/",
  });
  const [sql, params] = mockQuery.mock.calls[0];
  expect(sql).toContain("host_id = $2");
  expect(sql).toContain("deleted IS NOT TRUE");
  expect(sql).toContain("COALESCE(owning_bay_id, $3) = $3");
  expect(params).toEqual([
    target.target_project_id,
    target.target_host_id,
    "bay-a",
  ]);
  expect(mockQuery.mock.calls[1][0]).toContain("COALESCE(h.bay_id, $2) = $2");
});

it("routes cross-bay metadata lookup without consulting the local project database", async () => {
  mockResolveProjectBay.mockResolvedValue({ bay_id: "bay-b" });
  mockRemote.mockResolvedValue({ url: "https://remote.example.test" });
  await expect(
    resolveProjectApiRelayTarget({ host_id: sourceHost, ...target }),
  ).resolves.toEqual({ url: "https://remote.example.test" });
  expect(mockHostConnection).toHaveBeenCalledWith("bay-b");
  expect(mockRemote).toHaveBeenCalledWith(target);
  expect(mockQuery).not.toHaveBeenCalled();
});

it("does not fall back to a local URL when owning-bay lookup fails", async () => {
  mockResolveProjectBay.mockResolvedValue({ bay_id: "bay-b" });
  mockRemote.mockRejectedValue(Error("bay unavailable"));
  await expect(
    resolveProjectApiRelayTarget({ host_id: sourceHost, ...target }),
  ).rejects.toThrow("bay unavailable");
  expect(mockQuery).not.toHaveBeenCalled();
});

it("checks project placement before consulting a different host-owning bay", async () => {
  mockResolveHostBay.mockResolvedValue({ bay_id: "bay-c" });
  mockRemoteHostUrl.mockResolvedValue({ url: "https://host-c.test" });
  await expect(resolveLocalProjectApiRelayTarget(target)).resolves.toEqual({
    url: "https://host-c.test",
  });
  expect(mockQuery).toHaveBeenCalledTimes(1);
  expect(mockHostConnection).toHaveBeenCalledWith("bay-c");
  expect(mockRemoteHostUrl).toHaveBeenCalledWith(target);
});

it("does not look up host endpoints after a stale project assignment", async () => {
  mockQuery.mockResolvedValue({ rows: [] });
  await expect(resolveLocalProjectApiRelayTarget(target)).rejects.toThrow(
    "not on this host",
  );
  expect(mockResolveHostBay).not.toHaveBeenCalled();
  expect(mockRemoteHostUrl).not.toHaveBeenCalled();
});

it("requires authoritative local host metadata for the endpoint lookup", async () => {
  mockQuery.mockResolvedValue({ rows: [] });
  await expect(resolveLocalApiRelayHostUrl(target)).rejects.toThrow(
    "not owned by this bay",
  );
});

it("rejects nonexistent or moved projects and invalid target identifiers", async () => {
  mockQuery.mockResolvedValue({ rows: [] });
  await expect(
    resolveProjectApiRelayTarget({ host_id: sourceHost, ...target }),
  ).rejects.toThrow("not on this host");
  await expect(resolveProjectApiRelayTarget({ ...target })).rejects.toThrow(
    "authentication required",
  );
  await expect(
    resolveLocalProjectApiRelayTarget({
      ...target,
      target_host_id: "https://caller-chosen.test",
    }),
  ).rejects.toThrow("invalid API relay target");
});

it("retains the existing owning-hub tunnel for local/on-prem hosts", async () => {
  mockQuery.mockResolvedValue({
    rows: [
      {
        public_url: "http://127.0.0.1:9000",
        metadata: {
          local: true,
          self_host: { http_tunnel_port: 12345 },
        },
      },
    ],
  });
  await expect(
    resolveLocalProjectApiRelayTarget(target),
  ).resolves.toMatchObject({
    url: `https://bay-a.example.test/site/${target.target_project_id}`,
  });
});

it.each([
  "https://user:password@host.test",
  "file:///tmp/example",
  "https://host.test/?target=evil",
])("rejects malformed configured endpoint %s", async (url) => {
  mockQuery.mockResolvedValue({ rows: [{ public_url: url }] });
  await expect(resolveLocalProjectApiRelayTarget(target)).rejects.toThrow(
    "invalid API relay target URL",
  );
});
