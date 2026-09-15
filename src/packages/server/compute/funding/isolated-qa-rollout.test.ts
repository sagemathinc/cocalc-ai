import { verifyIsolatedQaFundingWriter } from "./isolated-qa-rollout";
import {
  initFundingRolloutVerifiers,
  stopFundingRolloutVerifiers,
} from "./rollout-startup";
import { getLocalFundingRolloutCapabilities } from "./rollout";

const mockQuery = jest.fn();
const mockStat = jest.fn();
const mockRealpath = jest.fn();
const mockConfig = jest.fn();
const mockReadFile = jest.fn();
let mockProtocol = 1;
let mockMulti = false;
let mockHost = "/qa/pg-f8e1c8e3/socket";
jest.mock("node:fs/promises", () => ({
  readFile: (...args) => mockReadFile(...args),
  realpath: (...args) => mockRealpath(...args),
  stat: (...args) => mockStat(...args),
}));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: mockQuery, options: { host: mockHost } }),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "home",
  getConfiguredClusterBayCatalog: () => [{ bay_id: "home" }],
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  isMultiBayCluster: () => mockMulti,
}));
jest.mock("../config", () => ({
  getComputeVmConfig: (...args) => mockConfig(...args),
}));
jest.mock("../worker", () => ({
  get SPONSORED_RESOURCE_WRITER_PROTOCOL_VERSION() {
    return mockProtocol;
  },
}));

const env = { ...process.env };
beforeEach(() => {
  jest.resetAllMocks();
  mockProtocol = 1;
  mockMulti = false;
  mockHost = "/qa/pg-f8e1c8e3/socket";
  Object.assign(process.env, {
    COCALC_FUNDING_ISOLATED_QA: "yes",
    COCALC_FUNDING_QA_DATABASE: "smc",
    COCALC_FUNDING_QA_WORKTREE: "/qa/worktree",
    COCALC_FUNDING_QA_PG_DATA_DIRECTORY: "/qa/pg-f8e1c8e3/data",
    COCALC_FUNDING_QA_PG_SOCKET: "/qa/pg-f8e1c8e3/socket",
    COCALC_FUNDING_QA_DEPLOYMENT_ID: "isolated-19200",
    COCALC_COMPUTE_DEPLOYMENT_ID: "isolated-19200",
  });
  mockConfig.mockResolvedValue({ environment: "development" });
  mockRealpath.mockImplementation(async (path) =>
    path.endsWith(".ts") || path.endsWith(".js")
      ? `/qa/worktree/compiled/${path.split("/").at(-1).replace(/\.ts$/, ".js")}`
      : path,
  );
  mockStat.mockResolvedValue({
    uid: process.getuid!(),
    mode: 0o755,
    mtimeMs: Date.now() - process.uptime() * 1000 - 1000,
  });
  mockReadFile.mockResolvedValue(Buffer.from("compiled writer protocol 1"));
  mockQuery.mockResolvedValue({
    rows: [
      {
        database: "smc",
        data_directory: "/qa/pg-f8e1c8e3/data",
        socket_directories: "/qa/pg-f8e1c8e3/socket",
        server_addr: null,
        postmaster_started_at: new Date("2026-09-12T00:00:00Z"),
      },
    ],
  });
});
afterEach(() => {
  stopFundingRolloutVerifiers();
  for (const key of Object.keys(process.env))
    if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
});

it("registers actual startup verifiers and accepts smc on its explicitly isolated Unix-socket cluster", async () => {
  initFundingRolloutVerifiers();
  initFundingRolloutVerifiers();
  const result = await getLocalFundingRolloutCapabilities();
  expect(result.checks["account-holds"]).toMatchObject({
    protocol_version: 1,
    enforced: true,
    evidence_id: expect.stringContaining(`isolated-qa:home:${process.pid}:`),
  });
  expect(result.checks["sponsored-resources"]).toMatchObject({
    protocol_version: 1,
    enforced: true,
  });
  expect(mockQuery).toHaveBeenCalledWith(
    expect.stringContaining("current_setting('data_directory')"),
  );
  expect(
    mockReadFile.mock.calls.every(([path]) => !path.startsWith("/proc/")),
  ).toBe(true);
});
it.each([
  "flag",
  "production",
  "multibay",
  "deployment",
  "protocol",
  "modified build",
  "wrong cluster",
  "wrong socket",
  "wrong owner",
])("rejects %s", async (fault) => {
  if (fault === "flag") delete process.env.COCALC_FUNDING_ISOLATED_QA;
  if (fault === "production")
    mockConfig.mockResolvedValue({ environment: "production" });
  if (fault === "multibay") mockMulti = true;
  if (fault === "deployment")
    process.env.COCALC_COMPUTE_DEPLOYMENT_ID = "original-hub";
  if (fault === "protocol") mockProtocol = 0;
  if (fault === "modified build")
    mockStat.mockResolvedValue({
      uid: process.getuid!(),
      mode: 0o755,
      mtimeMs: Date.now() + 1000,
    });
  if (fault === "wrong cluster")
    process.env.COCALC_FUNDING_QA_PG_DATA_DIRECTORY = "/qa/pg-058d6719/data";
  if (fault === "wrong socket") mockHost = "/qa/pg-058d6719/socket";
  if (fault === "wrong owner")
    mockStat.mockResolvedValue({
      uid: process.getuid!() + 1,
      mode: 0o755,
      mtimeMs: 0,
    });
  await expect(verifyIsolatedQaFundingWriter()).rejects.toThrow();
});
