/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let mockReport: any = null;
jest.mock("./runtime-host", () => ({
  runtimeUidModeReport: () => mockReport,
}));

import {
  checkDaemonState,
  configuredRuntimeUidMode,
  openHostDir,
  runtimeUidModeHeartbeat,
  type OpenDir,
} from "./runtime-hardening";

import { chmod, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = new Date("2026-11-06T08:00:00.000Z");

function dir(initial: { uid: number; mode: number; isDirectory?: boolean }) {
  const state = { ...initial, isDirectory: initial.isDirectory ?? true };
  const handle: OpenDir & { chmods: number[]; closed: boolean } = {
    chmods: [],
    closed: false,
    stat: async () => ({ ...state, mode: 0o040000 | state.mode }),
    chmod: async (mode: number) => {
      handle.chmods.push(mode);
      state.mode = mode;
    },
    close: async () => {
      handle.closed = true;
    },
  };
  return handle;
}

describe("checkDaemonState", () => {
  it("accepts a 0700 directory of the runtime user without touching it", async () => {
    const handle = dir({ uid: 2000, mode: 0o700 });
    await expect(
      checkDaemonState({
        path: "/x",
        runtimeUid: 2000,
        openDir: async () => handle,
        now: NOW,
      }),
    ).resolves.toEqual({ ok: true, checked_at: NOW.toISOString() });
    expect(handle.chmods).toEqual([]);
    expect(handle.closed).toBe(true);
  });

  it("reports a relaxed mode and restores it on the opened directory itself", async () => {
    const handle = dir({ uid: 2000, mode: 0o711 });
    const result = await checkDaemonState({
      path: "/x",
      runtimeUid: 2000,
      openDir: async () => handle,
      now: NOW,
    });
    expect(result).toEqual({
      ok: false,
      checked_at: NOW.toISOString(),
      problem: "mode 0711",
      restored: true,
    });
    expect(handle.chmods).toEqual([0o700]);
    expect(handle.closed).toBe(true);
  });

  it("reports a failed restore as not restored", async () => {
    const handle = dir({ uid: 2000, mode: 0o755 });
    handle.chmod = async () => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    };
    const result = await checkDaemonState({
      path: "/x",
      runtimeUid: 2000,
      openDir: async () => handle,
      now: NOW,
    });
    expect(result).toMatchObject({
      ok: false,
      problem: "mode 0755",
      restored: false,
    });
  });

  it("reports not restored when the mode is unchanged after a chmod that succeeded", async () => {
    const handle = dir({ uid: 2000, mode: 0o711 });
    handle.chmod = async (mode: number) => {
      handle.chmods.push(mode); // resolves, but the mode stays 0711
    };
    const result = await checkDaemonState({
      path: "/x",
      runtimeUid: 2000,
      openDir: async () => handle,
      now: NOW,
    });
    expect(result).toMatchObject({
      ok: false,
      problem: "mode 0711",
      restored: false,
    });
    expect(handle.chmods).toEqual([0o700]);
  });

  it("never changes a directory owned by someone else", async () => {
    const handle = dir({ uid: 0, mode: 0o777 });
    const result = await checkDaemonState({
      path: "/x",
      runtimeUid: 2000,
      openDir: async () => handle,
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, problem: "owner 0" });
    expect(result.restored).toBeUndefined();
    expect(handle.chmods).toEqual([]);
  });

  it("refuses symlinks and non-directories without following them", async () => {
    for (const code of ["ELOOP", "ENOTDIR"]) {
      const result = await checkDaemonState({
        path: "/x",
        runtimeUid: 2000,
        openDir: async () => {
          throw Object.assign(new Error(code), { code });
        },
        now: NOW,
      });
      expect(result).toMatchObject({
        ok: false,
        problem: "not a directory or a symlink",
      });
    }
    const notDir = dir({ uid: 2000, mode: 0o700, isDirectory: false });
    await expect(
      checkDaemonState({
        path: "/x",
        runtimeUid: 2000,
        openDir: async () => notDir,
        now: NOW,
      }),
    ).resolves.toMatchObject({
      ok: false,
      problem: "not a directory or a symlink",
    });
    expect(notDir.chmods).toEqual([]);
  });

  it("reports a missing or unreadable directory", async () => {
    await expect(
      checkDaemonState({
        path: "/x",
        runtimeUid: 2000,
        openDir: async () => undefined,
        now: NOW,
      }),
    ).resolves.toMatchObject({ ok: false, problem: "missing" });
    await expect(
      checkDaemonState({
        path: "/x",
        runtimeUid: 2000,
        openDir: async () => {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        },
        now: NOW,
      }),
    ).resolves.toMatchObject({ ok: false, problem: "unreadable (EACCES)" });
  });
});

describe("runtimeUidModeHeartbeat", () => {
  const saved = process.env.COCALC_PROJECT_RUNTIME_UID_MODE;
  afterEach(() => {
    mockReport = null;
    if (saved == null) delete process.env.COCALC_PROJECT_RUNTIME_UID_MODE;
    else process.env.COCALC_PROJECT_RUNTIME_UID_MODE = saved;
  });

  it("is undecided, never keep-id or separate, until the first start", () => {
    process.env.COCALC_PROJECT_RUNTIME_UID_MODE = "separate";
    expect(runtimeUidModeHeartbeat(NOW)).toEqual({
      configured: "separate",
      effective: "undecided",
      label: "undecided",
      reported_at: NOW.toISOString(),
    });
    delete process.env.COCALC_PROJECT_RUNTIME_UID_MODE;
    expect(configuredRuntimeUidMode()).toBe("keep-id");
  });

  it("carries the last decision, its reason and the report time", () => {
    mockReport = {
      configured: "separate",
      effective: "keep-id",
      reason: "map-missing-block",
      detail: "reboot pending",
      label: "keep-id (fallback: map-missing-block)",
    };
    expect(runtimeUidModeHeartbeat(NOW)).toEqual({
      configured: "separate",
      effective: "keep-id",
      reason: "map-missing-block",
      detail: "reboot pending",
      label: "keep-id (fallback: map-missing-block)",
      reported_at: NOW.toISOString(),
    });
  });
});

describe("checkDaemonState on real directories (openHostDir)", () => {
  let dir: string;
  const uid = process.getuid!();
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "daemon-state-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const check = (path: string) =>
    checkDaemonState({ path, runtimeUid: uid, openDir: openHostDir, now: NOW });
  const modeOf = async (path: string) => (await stat(path)).mode & 0o7777;

  it("never follows a symlink, and never changes the target's mode", async () => {
    const target = join(dir, "target");
    await mkdir(target);
    await chmod(target, 0o755);
    const link = join(dir, "state");
    await symlink(target, link);
    const result = await check(link);
    expect(result).toMatchObject({
      ok: false,
      problem: "not a directory or a symlink",
    });
    expect(result.restored).toBeUndefined();
    expect(await modeOf(target)).toBe(0o755);
  });

  it("(control) restores a real 0711 directory to 0700", async () => {
    const state = join(dir, "state");
    await mkdir(state);
    await chmod(state, 0o711);
    await expect(check(state)).resolves.toMatchObject({
      ok: false,
      problem: "mode 0711",
      restored: true,
    });
    expect(await modeOf(state)).toBe(0o700);
  });

  it("reports a missing path as missing, and a 0700 directory as ok", async () => {
    await expect(check(join(dir, "absent"))).resolves.toMatchObject({
      ok: false,
      problem: "missing",
    });
    const state = join(dir, "ok");
    await mkdir(state);
    await chmod(state, 0o700);
    await expect(check(state)).resolves.toEqual({
      ok: true,
      checked_at: NOW.toISOString(),
    });
  });
});
