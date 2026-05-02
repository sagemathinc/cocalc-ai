import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const spawnMock = jest.fn();
const listQueuedAcpJobsMock = jest.fn();
const listRunningAcpJobsMock = jest.fn();

let tempDir: string;
let ensureAcpWorkerRunning: typeof import("../worker-manager").ensureAcpWorkerRunning;

jest.mock("node:child_process", () => ({
  spawn: (...args: any[]) => spawnMock(...args),
}));

jest.mock("@cocalc/backend/data", () => ({
  conatPassword: "test-password",
  conatServer: "http://localhost:7000",
  data: tempDir,
}));

jest.mock("../../sqlite/acp-jobs", () => ({
  listQueuedAcpJobs: (...args: any[]) => listQueuedAcpJobsMock(...args),
  listRunningAcpJobs: (...args: any[]) => listRunningAcpJobsMock(...args),
}));

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

beforeEach(async () => {
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "acp-worker-"));
  spawnMock.mockReset();
  listQueuedAcpJobsMock.mockReset();
  listRunningAcpJobsMock.mockReset();
  listQueuedAcpJobsMock.mockReturnValue([{ op_id: "job-1" }]);
  listRunningAcpJobsMock.mockReturnValue([]);
  spawnMock.mockReturnValue({
    pid: 456,
    unref: jest.fn(),
  });
  jest.resetModules();
  ({ ensureAcpWorkerRunning } = await import("../worker-manager"));
});

afterEach(async () => {
  jest.restoreAllMocks();
  await fs.promises.rm(tempDir, { recursive: true, force: true });
});

describe("ensureAcpWorkerRunning", () => {
  it("does not respawn a worker that has a fresh heartbeat", async () => {
    fs.writeFileSync(path.join(tempDir, "acp-worker.pid"), "123\n");
    fs.writeFileSync(
      path.join(tempDir, "acp-worker.heartbeat.json"),
      JSON.stringify({ pid: 123, updated_at: Date.now() }),
    );
    const killSpy = jest
      .spyOn(process, "kill")
      .mockImplementation((() => true) as any);

    await expect(ensureAcpWorkerRunning()).resolves.toBe(true);
    expect(killSpy).toHaveBeenCalledWith(123, 0);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("respawns when the pid file points at a live pid with a stale heartbeat", async () => {
    fs.writeFileSync(path.join(tempDir, "acp-worker.pid"), "123\n");
    fs.writeFileSync(
      path.join(tempDir, "acp-worker.heartbeat.json"),
      JSON.stringify({ pid: 123, updated_at: Date.now() - 60_000 }),
    );
    jest.spyOn(process, "kill").mockImplementation((() => true) as any);

    await expect(ensureAcpWorkerRunning()).resolves.toBe(true);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(tempDir, "acp-worker.pid"), "utf8")).toBe(
      "456\n",
    );
    const heartbeat = JSON.parse(
      fs.readFileSync(path.join(tempDir, "acp-worker.heartbeat.json"), "utf8"),
    );
    expect(heartbeat.pid).toBe(456);
    expect(Number.isFinite(heartbeat.updated_at)).toBe(true);
  });
});
