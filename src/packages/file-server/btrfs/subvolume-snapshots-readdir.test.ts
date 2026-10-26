/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { SNAPSHOTS } from "@cocalc/util/consts/snapshots";

const readonlyShow = async (_opts?: any) => ({
  stdout: "Flags: readonly\n",
  stderr: "",
});
const btrfsMock = jest.fn(readonlyShow);

jest.mock("./util", () => ({
  btrfs: (opts: any) => btrfsMock(opts),
  sudo: async () => ({ stdout: "", stderr: "" }),
}));

type Stat = { dir: boolean; ino: number; dev: number; ctimeMs: number };
const stats = new Map<string, Stat | { code: string }>();

jest.mock("node:fs/promises", () => ({
  ...jest.requireActual("node:fs/promises"),
  lstat: async (path: string) => {
    const st = stats.get(path);
    if (st == null) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    }
    if ("code" in st) {
      throw Object.assign(new Error(st.code), { code: st.code });
    }
    return { ...st, isDirectory: () => st.dir };
  },
}));

import { SubvolumeSnapshots } from "./subvolume-snapshots";
import {
  clearBtrfsOperationCachesForTest,
  forgetSubvolumePaths,
} from "./operation-cache";
import { invalidateSubvolumeMetadata } from "./subvolume";

const HOME = "/mnt/test/project-1";
const names = [
  "2026-10-01T00:00:00.000Z",
  "2026-10-02T00:00:00.000Z",
  "plain-directory",
];
const pathOf = (name: string) => `${HOME}/${SNAPSHOTS}/${name}`;

function snapshotsOf(entries: string[]) {
  return new SubvolumeSnapshots({
    name: "project-1",
    path: HOME,
    filesystem: { opts: { mount: "/mnt/test" } },
    fs: {
      exists: async () => true,
      mkdir: async () => undefined,
      chmod: async () => undefined,
      readdir: async () => entries,
    },
  } as any);
}

const showCalls = () =>
  btrfsMock.mock.calls.filter(([opts]) => opts?.args?.[1] === "show").length;

describe("snapshot listing", () => {
  beforeEach(() => {
    // no help from the short `btrfs subvolume show` cache
    process.env.COCALC_BTRFS_SUBVOLUME_SHOW_CACHE_MS = "0";
    clearBtrfsOperationCachesForTest();
    btrfsMock.mockReset();
    btrfsMock.mockImplementation(readonlyShow);
    stats.clear();
    stats.set(pathOf(names[0]), { dir: true, ino: 256, dev: 71, ctimeMs: 1 });
    stats.set(pathOf(names[1]), { dir: true, ino: 256, dev: 72, ctimeMs: 2 });
    stats.set(pathOf(names[2]), { dir: true, ino: 300, dev: 60, ctimeMs: 3 });
  });

  afterAll(() => {
    delete process.env.COCALC_BTRFS_SUBVOLUME_SHOW_CACHE_MS;
  });

  it("asks btrfs about each snapshot once, not on every listing", async () => {
    const snapshots = snapshotsOf(names);
    expect(await snapshots.readdir()).toEqual(names.slice(0, 2));
    // (the plain directory is not a subvolume root: no btrfs call)
    expect(showCalls()).toBe(2);
    expect(await snapshots.readdir()).toEqual(names.slice(0, 2));
    expect(await snapshots.readdir()).toEqual(names.slice(0, 2));
    expect(showCalls()).toBe(2);
  });

  it("checks again after invalidation or a new identity", async () => {
    const snapshots = snapshotsOf(names);
    await snapshots.readdir();
    btrfsMock.mockClear();
    // e.g. made writable for a prune (setReadOnly invalidates)
    invalidateSubvolumeMetadata(pathOf(names[0]));
    // deleted and recreated under the same name
    stats.set(pathOf(names[1]), { dir: true, ino: 256, dev: 73, ctimeMs: 9 });
    await snapshots.readdir();
    expect(showCalls()).toBe(2);
    btrfsMock.mockClear();
    // a home swap or restore forgets everything under the home
    forgetSubvolumePaths(HOME);
    await snapshots.readdir();
    expect(showCalls()).toBe(2);
  });

  it("does not remember a writable subvolume", async () => {
    btrfsMock.mockImplementation(async () => ({
      stdout: "Flags: -\n",
      stderr: "",
    }));
    const snapshots = snapshotsOf(names.slice(0, 1));
    expect(await snapshots.readdir()).toEqual([]);
    expect(await snapshots.readdir()).toEqual([]);
    expect(showCalls()).toBe(2);
  });

  it("skips entries that are gone and falls back when stat fails", async () => {
    stats.delete(pathOf(names[0]));
    stats.set(pathOf(names[1]), { code: "EACCES" });
    const snapshots = snapshotsOf(names.slice(0, 2));
    expect(await snapshots.readdir()).toEqual([names[1]]);
    expect(await snapshots.readdir()).toEqual([names[1]]);
    // decided by btrfs each time, without the cache
    expect(showCalls()).toBe(2);
  });
});
