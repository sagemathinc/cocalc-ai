/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, jest } from "@jest/globals";

import {
  __test__,
  cancelRootfsBuild,
  getRootfsBuildLog,
  getRootfsBuildStatus,
  startRootfsBuild,
} from "./rootfs-build-runner";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";

const spawnMock = jest.fn();
const getVolumeMock = jest.fn();
const podmanEnvMock = jest.fn(() => ({ XDG_RUNTIME_DIR: "/tmp/podman" }));

jest.mock("node:child_process", () => ({
  spawn: (...args: any[]) => spawnMock(...args),
}));

jest.mock("@cocalc/backend/logger", () => {
  const logger = () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  });
  return {
    __esModule: true,
    default: logger,
    getLogger: logger,
  };
});

jest.mock("@cocalc/backend/podman/env", () => ({
  podmanEnv: () => podmanEnvMock(),
}));

jest.mock("./file-server", () => ({
  getVolume: (...args: any[]) => getVolumeMock(...args),
}));

function mockSpawnedBuild({
  stdout = "",
  stderr = "",
  code = 0,
  signal = null,
  close = true,
}: {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  close?: boolean;
} = {}) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: jest.Mock;
  };
  child.pid = 12345;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = jest.fn();
  spawnMock.mockImplementation(() => {
    if (close) {
      process.nextTick(() => {
        if (stdout) child.stdout.write(stdout);
        if (stderr) child.stderr.write(stderr);
        child.stdout.end();
        child.stderr.end();
        setImmediate(() => child.emit("close", code, signal));
      });
    }
    return child;
  });
  return child;
}

async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
): Promise<T> {
  const started = Date.now();
  let last: T;
  while (Date.now() - started < 2000) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`condition not met; last=${JSON.stringify(last!)}`);
}

let tempDir: string | undefined;

afterEach(async () => {
  __test__.reset();
  spawnMock.mockReset();
  getVolumeMock.mockReset();
  podmanEnvMock.mockClear();
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

async function setupVolume() {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rootfs-build-runner-"));
  getVolumeMock.mockResolvedValue({ path: tempDir });
  return tempDir;
}

describe("rootfs build runner", () => {
  it("runs a project-host owned build and persists artifacts", async () => {
    const volumePath = await setupVolume();
    mockSpawnedBuild({
      stdout: "hello from build\n",
      stderr: "warning from build\n",
    });

    const started = await startRootfsBuild({
      project_id: PROJECT_ID,
      build_id: "test-build",
      script: "echo hello",
      recipe_ref: "cocalc/test",
      resolved_recipe_json: { id: "cocalc/test" },
      metadata_json: { title: "Test" },
    });

    expect(started.status).toBe("running");
    expect(spawnMock).toHaveBeenCalledWith(
      "podman",
      expect.arrayContaining([
        "exec",
        "-i",
        "-u",
        "2001:2001",
        "project-00000000-0000-4000-8000-000000000001",
      ]),
      expect.objectContaining({ detached: true }),
    );

    const finished = await waitFor(
      () =>
        getRootfsBuildStatus({
          project_id: PROJECT_ID,
          build_id: "test-build",
        }),
      (status) => status.status === "succeeded",
    );
    expect(finished.exit_code).toBe(0);

    const buildDir = path.join(
      volumePath,
      ".cocalc",
      "rootfs-builds",
      "test-build",
    );
    await expect(
      fs.readFile(path.join(buildDir, "run.sh"), "utf8"),
    ).resolves.toBe("echo hello\n");
    await expect(
      fs.readFile(path.join(buildDir, "resolved-recipe.json"), "utf8"),
    ).resolves.toContain("cocalc/test");
    const log = await waitFor(
      () =>
        getRootfsBuildLog({ project_id: PROJECT_ID, build_id: "test-build" }),
      (value) =>
        value.text.includes("hello from build") &&
        value.text.includes("warning from build"),
    );
    expect(log.found).toBe(true);
  });

  it("reports running disk state as unknown when the process is not tracked", async () => {
    await setupVolume();
    const paths = await __test__.buildPaths(PROJECT_ID, "stale-build");
    await fs.mkdir(paths.hostDir, { recursive: true });
    await fs.writeFile(
      paths.hostStatus,
      JSON.stringify({
        build_id: "stale-build",
        project_id: PROJECT_ID,
        status: "running",
        created_at: new Date().toISOString(),
        paths: paths.publicPaths,
      }),
      "utf8",
    );

    const status = await getRootfsBuildStatus({
      project_id: PROJECT_ID,
      build_id: "stale-build",
    });
    expect(status.status).toBe("unknown");
    expect(status.error).toContain("not tracked");
  });

  it("reads build logs incrementally by byte offset", async () => {
    const volumePath = await setupVolume();
    const paths = await __test__.buildPaths(PROJECT_ID, "paged-log");
    await fs.mkdir(paths.hostDir, { recursive: true });
    await fs.writeFile(
      path.join(
        volumePath,
        ".cocalc",
        "rootfs-builds",
        "paged-log",
        "build.log",
      ),
      "line one\nline two\nline three\n",
      "utf8",
    );

    const first = await getRootfsBuildLog({
      project_id: PROJECT_ID,
      build_id: "paged-log",
      byte_offset: 0,
      max_bytes: 9,
    });
    expect(first).toMatchObject({
      byte_offset: 0,
      next_byte_offset: 9,
      bytes: 9,
      eof: false,
      text: "line one\n",
    });

    const second = await getRootfsBuildLog({
      project_id: PROJECT_ID,
      build_id: "paged-log",
      byte_offset: first.next_byte_offset,
      max_bytes: 9,
    });
    expect(second).toMatchObject({
      byte_offset: 9,
      next_byte_offset: 18,
      bytes: 9,
      eof: false,
      text: "line two\n",
    });
  });

  it("cancels a running build by signaling the process group", async () => {
    await setupVolume();
    mockSpawnedBuild({ close: false });
    const killSpy = jest
      .spyOn(process, "kill")
      .mockImplementation(() => true as any);
    try {
      await startRootfsBuild({
        project_id: PROJECT_ID,
        build_id: "cancel-build",
        script: "sleep 100",
      });
      const canceled = await cancelRootfsBuild({
        project_id: PROJECT_ID,
        build_id: "cancel-build",
      });
      expect(canceled).toMatchObject({
        status: "canceling",
        signaled: true,
      });
      expect(killSpy).toHaveBeenCalledWith(-12345, "SIGTERM");
    } finally {
      killSpy.mockRestore();
    }
  });
});
