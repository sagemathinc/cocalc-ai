import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const spawnMock = jest.fn();
const listQueuedAcpJobsMock = jest.fn();
const listRunningAcpJobsMock = jest.fn();

let tempDir: string;
let ensureAcpWorkerRunning: typeof import("../worker-manager").ensureAcpWorkerRunning;
let sweepStaleAcpWorkerHeartbeats: typeof import("../worker-manager").sweepStaleAcpWorkerHeartbeats;

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
  ({ ensureAcpWorkerRunning, sweepStaleAcpWorkerHeartbeats } =
    await import("../worker-manager"));
});

afterEach(async () => {
  jest.restoreAllMocks();
  await fs.promises.rm(tempDir, { recursive: true, force: true });
});

describe("ensureAcpWorkerRunning", () => {
  it("does not respawn a worker that has a fresh heartbeat", async () => {
    fs.writeFileSync(path.join(tempDir, "acp-worker.pid"), "123\n");
    fs.writeFileSync(
      path.join(tempDir, "acp-worker.heartbeat.json.123"),
      JSON.stringify({ pid: 123, updated_at: Date.now() }),
    );
    const killSpy = jest
      .spyOn(process, "kill")
      .mockImplementation((() => true) as any);

    await expect(ensureAcpWorkerRunning()).resolves.toBe(true);
    expect(killSpy).toHaveBeenCalledWith(123, 0);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(listQueuedAcpJobsMock).not.toHaveBeenCalled();
    expect(listRunningAcpJobsMock).not.toHaveBeenCalled();
  });

  it("accepts a fresh legacy heartbeat during a rolling upgrade", async () => {
    fs.writeFileSync(path.join(tempDir, "acp-worker.pid"), "123\n");
    fs.writeFileSync(
      path.join(tempDir, "acp-worker.heartbeat.json"),
      JSON.stringify({ pid: 123, updated_at: Date.now() }),
    );
    jest.spyOn(process, "kill").mockImplementation((() => true) as any);

    await expect(ensureAcpWorkerRunning()).resolves.toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(listQueuedAcpJobsMock).not.toHaveBeenCalled();
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
      fs.readFileSync(
        path.join(tempDir, "acp-worker.heartbeat.json.456"),
        "utf8",
      ),
    );
    expect(heartbeat.pid).toBe(456);
    expect(Number.isFinite(heartbeat.updated_at)).toBe(true);
    expect(spawnMock.mock.calls[0][2].env).toMatchObject({
      DEBUG_CONSOLE: "no",
      DEBUG_FILE: path.join(tempDir, "logs", "acp-worker.log"),
    });
  });
});

describe("sweepStaleAcpWorkerHeartbeats", () => {
  it("removes heartbeat files of dead or long-silent workers only", async () => {
    const alive = new Set([process.pid, 200, 300]);
    jest.spyOn(process, "kill").mockImplementation(((pid: number) => {
      if (alive.has(pid)) return true;
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    }) as any);
    const file = (name: string, ageMs = 0) => {
      const filename = path.join(tempDir, name);
      fs.writeFileSync(filename, "{}\n");
      const t = (Date.now() - ageMs) / 1000;
      fs.utimesSync(filename, t, t);
      return filename;
    };
    const own = file(`acp-worker.heartbeat.json.${process.pid}`, 2 * 3600_000);
    const live = file("acp-worker.heartbeat.json.200");
    const silent = file("acp-worker.heartbeat.json.300", 2 * 3600_000);
    const dead = file("acp-worker.heartbeat.json.100");
    const deadTmp = file("acp-worker.heartbeat.json.200.100.tmp");
    const liveTmp = file("acp-worker.heartbeat.json.400.200.tmp");
    const other = file("acp-worker.heartbeat.json.100.bak", 2 * 3600_000);
    const legacy = file("acp-worker.heartbeat.json", 2 * 3600_000);

    await expect(sweepStaleAcpWorkerHeartbeats({ dir: tempDir })).resolves.toBe(
      3,
    );
    for (const kept of [own, live, liveTmp, other, legacy]) {
      expect(fs.existsSync(kept)).toBe(true);
    }
    for (const removed of [silent, dead, deadTmp]) {
      expect(fs.existsSync(removed)).toBe(false);
    }
  });
});
