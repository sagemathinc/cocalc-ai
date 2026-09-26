const mockQuery = jest.fn();
const mockRemote = jest.fn();
const mockRemoteHostUrl = jest.fn();
const mockHostConnection = jest.fn(() => ({
  getApiRelayTarget: mockRemote,
  getApiRelayHostUrl: mockRemoteHostUrl,
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
  mockQuery.mockResolvedValue({
    rows: [{ public_url: "https://host.example.test" }],
  });
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
    url: `https://example.test/site/${target.target_project_id}`,
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
