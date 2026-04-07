import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { closeDatabase } from "@cocalc/lite/hub/sqlite/database";
import { reconcileOnce } from "./reconcile";
import { getProject, upsertProject } from "./sqlite/projects";

const mockSpawn = jest.fn();

jest.mock("node:child_process", () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}));

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

jest.mock("@cocalc/file-server/btrfs/subvolume-snapshots", () => ({
  getGeneration: jest.fn(),
}));

jest.mock("./last-edited", () => ({
  resetProjectLastEditedRunning: jest.fn(),
  shouldCheckProjectLastEditedRunning: jest.fn(() => false),
  touchProjectLastEditedRunning: jest.fn(),
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

describe("reconcileOnce", () => {
  const prevFilename = process.env.COCALC_LITE_SQLITE_FILENAME;
  const project_id = "9ddaa0ac-262a-4b57-b829-e6c531324c01";

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.COCALC_LITE_SQLITE_FILENAME = ":memory:";
    closeDatabase();
    mockPodmanPs();
  });

  afterEach(() => {
    closeDatabase();
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
      state: "opened",
      http_port: null,
      ssh_port: null,
    });
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
      state: "opened",
      http_port: null,
      ssh_port: null,
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
});
