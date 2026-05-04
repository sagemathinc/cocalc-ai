import os from "node:os";
import path from "node:path";

const connectMock = jest.fn();
const inboxPrefixMock = jest.fn(() => "inbox-prefix");
const setConatPasswordMock = jest.fn();
const setConatClientMock = jest.fn();
const disposeAcpAgentsMock = jest.fn(async () => {});
const runDetachedAcpQueueWorkerMock = jest.fn(async () => {});
const setContainerExecMock = jest.fn();
const setPreferContainerExecutorMock = jest.fn();
const projectRunnerClientMock = jest.fn(() => ({ kind: "runner-client" }));
const initProjectRunnerFilesystemMock = jest.fn();
const sandboxExecMock = jest.fn();
const initCodexProjectRunnerMock = jest.fn();
const initCodexGeneratedImageBlobWriterMock = jest.fn();
const initCodexSiteKeyGovernorMock = jest.fn();
const configureProjectHostAcpContainerFileIOMock = jest.fn();
const wireHostsApiMock = jest.fn();
const wireSystemApiMock = jest.fn();
const wireProjectsApiMock = jest.fn();
const resolveProjectHostPreferredMasterConatServerMock = jest.fn(
  () => "http://master.example",
);
const getProjectHostMasterConatTokenMock = jest.fn(() => "master-token");
const setMasterConatClientMock = jest.fn();
const initSqliteMock = jest.fn();
const getLocalHostIdMock = jest.fn(
  () => "00000000-1000-4000-8000-000000000123",
);
const stopEventLoopStallMonitorMock = jest.fn();
const startEventLoopStallMonitorMock = jest.fn(
  () => stopEventLoopStallMonitorMock,
);

jest.mock("@cocalc/conat/core/client", () => ({
  connect: (...args: any[]) => connectMock(...args),
}));

jest.mock("@cocalc/conat/names", () => ({
  inboxPrefix: (...args: any[]) => inboxPrefixMock(...args),
}));

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  }),
}));

jest.mock("@cocalc/backend/data", () => ({
  setConatPassword: (...args: any[]) => setConatPasswordMock(...args),
}));

jest.mock("@cocalc/conat/client", () => ({
  setConatClient: (...args: any[]) => setConatClientMock(...args),
}));

jest.mock("@cocalc/lite/hub/acp", () => ({
  disposeAcpAgents: (...args: any[]) => disposeAcpAgentsMock(...args),
  runDetachedAcpQueueWorker: (...args: any[]) =>
    runDetachedAcpQueueWorkerMock(...args),
}));

jest.mock("@cocalc/lite/hub/acp/executor/container", () => ({
  setContainerExec: (...args: any[]) => setContainerExecMock(...args),
}));

jest.mock("@cocalc/lite/hub/acp/workspace-root", () => ({
  setPreferContainerExecutor: (...args: any[]) =>
    setPreferContainerExecutorMock(...args),
}));

jest.mock("@cocalc/conat/project/runner/run", () => ({
  client: (...args: any[]) => projectRunnerClientMock(...args),
}));

jest.mock("@cocalc/project-runner/run/filesystem", () => ({
  init: (...args: any[]) => initProjectRunnerFilesystemMock(...args),
}));

jest.mock("@cocalc/project-runner/run/sandbox-exec", () => ({
  sandboxExec: (...args: any[]) => sandboxExecMock(...args),
}));

jest.mock("./codex/codex-project", () => ({
  initCodexProjectRunner: (...args: any[]) =>
    initCodexProjectRunnerMock(...args),
}));

jest.mock("./codex/generated-image-blobs", () => ({
  initCodexGeneratedImageBlobWriter: (...args: any[]) =>
    initCodexGeneratedImageBlobWriterMock(...args),
}));

jest.mock("./codex/codex-site-metering", () => ({
  initCodexSiteKeyGovernor: (...args: any[]) =>
    initCodexSiteKeyGovernorMock(...args),
}));

jest.mock("./file-server", () => ({
  configureProjectHostAcpContainerFileIO: (...args: any[]) =>
    configureProjectHostAcpContainerFileIOMock(...args),
}));

jest.mock("./hub/hosts", () => ({
  wireHostsApi: (...args: any[]) => wireHostsApiMock(...args),
}));

jest.mock("./hub/system", () => ({
  wireSystemApi: (...args: any[]) => wireSystemApiMock(...args),
}));

jest.mock("./hub/projects", () => ({
  PROJECT_RUNNER_RPC_TIMEOUT_MS: 1234,
  wireProjectsApi: (...args: any[]) => wireProjectsApiMock(...args),
}));

jest.mock("./master-conat-server", () => ({
  resolveProjectHostPreferredMasterConatServer: (...args: any[]) =>
    resolveProjectHostPreferredMasterConatServerMock(...args),
}));

jest.mock("./master-conat-token", () => ({
  getProjectHostMasterConatToken: (...args: any[]) =>
    getProjectHostMasterConatTokenMock(...args),
}));

jest.mock("./master-status", () => ({
  setMasterConatClient: (...args: any[]) => setMasterConatClientMock(...args),
}));

jest.mock("./sqlite/init", () => ({
  initSqlite: (...args: any[]) => initSqliteMock(...args),
}));

jest.mock("./sqlite/hosts", () => ({
  getLocalHostId: (...args: any[]) => getLocalHostIdMock(...args),
}));

jest.mock("./event-loop-stalls", () => ({
  startEventLoopStallMonitor: (...args: any[]) =>
    startEventLoopStallMonitorMock(...args),
}));

describe("project-host ACP worker runtime wiring", () => {
  const env = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...env };
    process.env.COCALC_PROJECT_HOST_ACP_WORKER_CONAT_PASSWORD = "pw";
    process.env.CONAT_SERVER = "http://conat.example";
    process.env.PROJECT_HOST_ID = "00000000-1000-4000-8000-000000000123";
    process.env.PROJECT_RUNNER_NAME = "project-host";
    process.env.COCALC_PROJECT_HOST_ACP_WORKER_PID_FILE = path.join(
      os.tmpdir(),
      `acp-worker-${process.pid}-${Date.now()}.pid`,
    );
    connectMock.mockImplementation(() => ({
      close: jest.fn(),
    }));
  });

  afterEach(() => {
    process.env = env;
  });

  it("installs system wiring before running the detached ACP worker", async () => {
    const { main } = await import("./acp-worker");

    await main();

    expect(wireSystemApiMock).toHaveBeenCalledTimes(1);
    expect(wireHostsApiMock).toHaveBeenCalledTimes(1);
    expect(wireProjectsApiMock).toHaveBeenCalledTimes(1);
    expect(runDetachedAcpQueueWorkerMock).toHaveBeenCalledTimes(1);
  });
});
