import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { closeDatabase } from "@cocalc/lite/hub/sqlite/database";
import { reconcileOnce, resetReconcileStateForTests } from "./reconcile";
import { getMountPoint } from "./file-server";
import { setProjectStateReporter } from "./project-state-reporter";
import { getProject, upsertProject } from "./sqlite/projects";

const mockSpawn = jest.fn();

jest.mock("node:child_process", () => {
  const actual = jest.requireActual("node:child_process");
  return {
    __esModule: true,
    ...actual,
    spawn: (...args: any[]) => mockSpawn(...args),
  };
});

jest.mock("@cocalc/backend/logger", () => {
  const factory = () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  });
  return {
    __esModule: true,
    default: factory,
    getLogger: factory,
  };
});

jest.mock("@cocalc/backend/podman/env", () => ({
  podmanEnv: jest.fn(() => ({})),
}));

jest.mock("@cocalc/file-server/btrfs/subvolume-snapshots", () => ({
  getGeneration: jest.fn(),
}));

jest.mock("./last-edited", () => ({
  markProjectLastChangedRunning: jest.fn(),
  resetProjectLastChangedRunning: jest.fn(),
  shouldCheckProjectLastChangedRunning: jest.fn(() => false),
}));

jest.mock("./file-server", () => ({
  getMountPoint: jest.fn(() => "/mnt/cocalc"),
}));

function mockPodmanPs(stdoutText = "", stderrText = "", exitCode = 0) {
  mockSpawn.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (stdoutText) child.stdout.write(stdoutText);
      if (stderrText) child.stderr.write(stderrText);
      child.stdout.end();
      child.stderr.end();
      child.emit("exit", exitCode);
    });
    return child;
  });
}

function mockPodmanPsAndConmon(
  podmanStdoutText = "",
  conmonStdoutText = "",
  podmanExitCode = 0,
  conmonExitCode = 0,
) {
  mockSpawn.mockImplementation((command: string) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (command === "podman") {
        if (podmanStdoutText) child.stdout.write(podmanStdoutText);
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", podmanExitCode);
        return;
      }
      if (command === "ps") {
        if (conmonStdoutText) child.stdout.write(conmonStdoutText);
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", conmonExitCode);
        return;
      }
      child.stdout.end();
      child.stderr.end();
      child.emit("exit", 0);
    });
    return child;
  });
}

function mockPodmanPsError(message = "spawn podman ENOENT") {
  mockSpawn.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      child.emit("error", new Error(message));
    });
    return child;
  });
}

describe("reconcileOnce", () => {
  const prevFilename = process.env.COCALC_LITE_SQLITE_FILENAME;
  const project_id = "9ddaa0ac-262a-4b57-b829-e6c531324c01";
  let mountPoint: string;

  function writeProjectHeartbeat(ageMs = 0) {
    const dir = join(
      mountPoint,
      `project-${project_id}`,
      ".cache",
      "cocalc",
      "project",
    );
    mkdirSync(dir, { recursive: true });
    const filename = join(dir, "project.pid");
    writeFileSync(filename, "2");
    const mtime = new Date(Date.now() - ageMs);
    utimesSync(filename, mtime, mtime);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.COCALC_LITE_SQLITE_FILENAME = ":memory:";
    delete process.env.COCALC_PROJECT_HOST_RECONCILE_MISSING_CYCLES;
    delete process.env.COCALC_PROJECT_HOST_RECONCILE_STALE_HEARTBEAT_MS;
    delete process.env.COCALC_PROJECT_HOST_RECONCILE_STALE_HEARTBEAT_CYCLES;
    delete process.env.COCALC_PROJECT_CGROUP_RECONCILE_INTERVAL_MS;
    delete process.env.COCALC_PROJECT_CGROUP_RECONCILE_CONCURRENCY;
    delete process.env.COCALC_PROJECT_CGROUP_RECONCILE_MAX_PER_TICK;
    delete process.env.COCALC_PROJECT_NETWORK_RECONCILE_INTERVAL_MS;
    mountPoint = mkdtempSync(join(tmpdir(), "cocalc-reconcile-"));
    (getMountPoint as jest.Mock).mockReturnValue(mountPoint);
    closeDatabase();
    resetReconcileStateForTests();
    mockPodmanPs();
    setProjectStateReporter(jest.fn(async () => undefined));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(mountPoint, { recursive: true, force: true });
    if (prevFilename == null) {
      delete process.env.COCALC_LITE_SQLITE_FILENAME;
    } else {
      process.env.COCALC_LITE_SQLITE_FILENAME = prevFilename;
    }
  });

  it("clears stale starting projects when the container is gone", async () => {
    upsertProject({
      project_id,
      state: "starting",
      http_port: 12345,
      ssh_port: 23456,
    });

    await reconcileOnce();

    expect(getProject(project_id)).toMatchObject({
      project_id,
      state: "starting",
      http_port: 12345,
      ssh_port: 23456,
    });

    await reconcileOnce();

    expect(getProject(project_id)).toMatchObject({
      project_id,
      state: "opened",
      runtime_exit_reason: "container_missing",
      http_port: null,
      ssh_port: null,
    });
  });

  it("reconciles running project cgroups in place and rate limits checks", async () => {
    upsertProject({
      project_id,
      state: "running",
      run_quota: { memory_limit: 2000 },
    });
    mockPodmanPs(`project-${project_id}|running|\n`);
    const reconcileProjectCgroup = jest.fn(async () => ({
      status: "repaired",
    }));

    await reconcileOnce({
      reconcileProjectCgroup,
      forceProjectCgroupRepair: true,
    });
    await reconcileOnce({ reconcileProjectCgroup });

    expect(reconcileProjectCgroup).toHaveBeenCalledTimes(1);
    expect(reconcileProjectCgroup).toHaveBeenCalledWith({
      project_id,
      run_quota: { memory_limit: 2000 },
      force: true,
    });
    expect(getProject(project_id)?.state).toBe("running");
  });

  it("rate limits failed cgroup repairs instead of queuing every tick", async () => {
    upsertProject({ project_id, state: "running" });
    mockPodmanPs(`project-${project_id}|running|\n`);
    const reconcileProjectCgroup = jest.fn(async () => {
      throw new Error("helper timed out");
    });

    await reconcileOnce({ reconcileProjectCgroup });
    await reconcileOnce({ reconcileProjectCgroup });

    expect(reconcileProjectCgroup).toHaveBeenCalledTimes(1);
  });

  it("serializes cgroup repairs by default", async () => {
    const secondProjectId = "815a6760-358e-46bc-a4fe-c43d1ed5c729";
    upsertProject({ project_id, state: "running" });
    upsertProject({ project_id: secondProjectId, state: "running" });
    mockPodmanPs(
      `project-${project_id}|running|\nproject-${secondProjectId}|running|\n`,
    );
    let active = 0;
    let maxActive = 0;
    const reconcileProjectCgroup = jest.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { status: "repaired" };
    });

    await reconcileOnce({ reconcileProjectCgroup });

    expect(reconcileProjectCgroup).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });

  it("spreads cgroup repairs across reconcile ticks", async () => {
    const secondProjectId = "815a6760-358e-46bc-a4fe-c43d1ed5c729";
    upsertProject({ project_id, state: "running" });
    upsertProject({ project_id: secondProjectId, state: "running" });
    mockPodmanPs(
      `project-${project_id}|running|\nproject-${secondProjectId}|running|\n`,
    );
    process.env.COCALC_PROJECT_CGROUP_RECONCILE_MAX_PER_TICK = "1";
    const reconcileProjectCgroup = jest.fn(async () => ({
      status: "repaired",
    }));

    await reconcileOnce({
      reconcileProjectCgroup,
      forceProjectCgroupRepair: true,
    });
    await reconcileOnce({ reconcileProjectCgroup });

    expect(reconcileProjectCgroup).toHaveBeenCalledTimes(2);
    expect(
      new Set(
        reconcileProjectCgroup.mock.calls.map(
          ([options]) => options.project_id,
        ),
      ),
    ).toEqual(new Set([project_id, secondProjectId]));
  });

  it("reconciles host network containment once and rate limits failures", async () => {
    mockPodmanPs();
    const reconcileProjectNetworkLimits = jest.fn(async () => {
      throw new Error("nft timed out");
    });

    await reconcileOnce({ reconcileProjectNetworkLimits });
    await reconcileOnce({ reconcileProjectNetworkLimits });

    expect(reconcileProjectNetworkLimits).toHaveBeenCalledTimes(1);
  });

  it("clears stale running projects when the container is gone", async () => {
    upsertProject({
      project_id,
      state: "running",
      http_port: 12345,
      ssh_port: 23456,
    });

    await reconcileOnce();

    expect(getProject(project_id)).toMatchObject({
      project_id,
      state: "running",
      http_port: 12345,
      ssh_port: 23456,
    });

    await reconcileOnce();

    expect(getProject(project_id)).toMatchObject({
      project_id,
      state: "opened",
      runtime_exit_reason: "container_missing",
      http_port: null,
      ssh_port: null,
    });
  });

  it("does not downgrade running projects when the podman probe fails", async () => {
    upsertProject({
      project_id,
      state: "running",
      http_port: 12345,
      ssh_port: 23456,
    });
    mockPodmanPsError();

    await reconcileOnce();

    expect(getProject(project_id)).toMatchObject({
      project_id,
      state: "running",
      http_port: 12345,
      ssh_port: 23456,
    });
  });

  it("resets the missing-container streak once the project is seen running again", async () => {
    upsertProject({
      project_id,
      state: "running",
      http_port: 12345,
      ssh_port: 23456,
    });

    await reconcileOnce();
    expect(getProject(project_id)).toMatchObject({
      project_id,
      state: "running",
    });

    mockPodmanPs(
      `project-${project_id}|running|127.0.0.1:32803->22/tcp, 127.0.0.1:33167->8080/tcp\n`,
    );
    await reconcileOnce();

    mockPodmanPs();
    await reconcileOnce();

    expect(getProject(project_id)).toMatchObject({
      project_id,
      state: "running",
      http_port: 33167,
      ssh_port: 32803,
    });
  });

  it("preserves host ports for running project containers", async () => {
    upsertProject({
      project_id,
      state: "opened",
      http_port: null,
      ssh_port: null,
    });
    mockPodmanPs(
      `project-${project_id}|running|127.0.0.1:32803->22/tcp, 127.0.0.1:33167->8080/tcp\n`,
    );

    await reconcileOnce();

    expect(getProject(project_id)).toMatchObject({
      project_id,
      state: "running",
      http_port: 33167,
      ssh_port: 32803,
    });
  });

  it("recovers a running container whose project daemon heartbeat is stale", async () => {
    process.env.COCALC_PROJECT_HOST_RECONCILE_STALE_HEARTBEAT_CYCLES = "2";
    upsertProject({
      project_id,
      state: "running",
      http_port: 12345,
      ssh_port: 23456,
    });
    writeProjectHeartbeat(5 * 60_000);
    mockPodmanPs(
      `project-${project_id}|running|127.0.0.1:32803->22/tcp, 127.0.0.1:33167->8080/tcp\n`,
    );
    const recoverStaleRuntime = jest.fn(async () => "opened");

    await reconcileOnce({ recoverStaleRuntime });
    expect(recoverStaleRuntime).not.toHaveBeenCalled();

    await reconcileOnce({ recoverStaleRuntime });

    expect(recoverStaleRuntime).toHaveBeenCalledWith(project_id);
    expect(getProject(project_id)).toMatchObject({
      project_id,
      state: "opened",
      runtime_exit_reason: "container_missing",
      http_port: null,
      ssh_port: null,
    });
  });

  it("does not report runtime loss until forced cleanup reaches opened", async () => {
    process.env.COCALC_PROJECT_HOST_RECONCILE_STALE_HEARTBEAT_CYCLES = "1";
    upsertProject({
      project_id,
      state: "running",
      http_port: 12345,
      ssh_port: 23456,
    });
    writeProjectHeartbeat(5 * 60_000);
    mockPodmanPs(
      `project-${project_id}|running|127.0.0.1:32803->22/tcp, 127.0.0.1:33167->8080/tcp\n`,
    );
    const recoverStaleRuntime = jest.fn(async () => "running");

    await reconcileOnce({ recoverStaleRuntime });

    expect(recoverStaleRuntime).toHaveBeenCalledWith(project_id);
    expect(getProject(project_id)).toMatchObject({
      project_id,
      state: "running",
      http_port: 33167,
      ssh_port: 32803,
    });
  });

  it("clears a stale-heartbeat streak when the daemon reports again", async () => {
    process.env.COCALC_PROJECT_HOST_RECONCILE_STALE_HEARTBEAT_CYCLES = "2";
    upsertProject({ project_id, state: "running" });
    writeProjectHeartbeat(5 * 60_000);
    mockPodmanPs(`project-${project_id}|running|\n`);
    const recoverStaleRuntime = jest.fn(async () => "opened");

    await reconcileOnce({ recoverStaleRuntime });
    writeProjectHeartbeat();
    await reconcileOnce({ recoverStaleRuntime });
    writeProjectHeartbeat(5 * 60_000);
    await reconcileOnce({ recoverStaleRuntime });

    expect(recoverStaleRuntime).not.toHaveBeenCalled();
    expect(getProject(project_id)).toMatchObject({
      project_id,
      state: "running",
    });
  });

  it("keeps a project running when podman misses it but a live conmon process still exists", async () => {
    upsertProject({
      project_id,
      state: "running",
      http_port: 12345,
      ssh_port: 23456,
    });
    mockPodmanPsAndConmon(
      "",
      [
        `100 1 /usr/bin/conmon --api-version 1 -n project-${project_id} --full-attach`,
        "101 100 /run/podman-init -- /opt/cocalc/bin/node /opt/cocalc/project-bundle/bundle/index.js --init .local/share/cocalc/startup.sh",
      ].join("\n"),
    );

    await reconcileOnce();
    await reconcileOnce();

    expect(getProject(project_id)).toMatchObject({
      project_id,
      state: "running",
      http_port: 12345,
      ssh_port: 23456,
    });
  });
});
