/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { grantOwnerAccessToExtractedTree } from "./owner-access";

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function mode(path: string): number {
  return lstatSync(path).mode & 0o7777;
}

function run(cmd: string, args: string[]) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
}

describe("grantOwnerAccessToExtractedTree", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cocalc-archive-owner-access-"));
  });

  afterEach(() => {
    run("chmod", ["-R", "u+rwX", tmp]);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("makes an archive with restrictive modes copyable by rsync", async () => {
    // Build an archive like the one in support ticket 21026: a directory
    // without owner search permission and a file without owner read
    // permission. --mode lets an unprivileged user record those modes.
    const src = join(tmp, "src");
    mkdirSync(join(src, "course", "perms", "nosearch"), { recursive: true });
    writeFileSync(join(src, "course", "perms", "nosearch", "file"), "inside\n");
    writeFileSync(join(src, "course", "perms", "noread"), "secret\n");
    writeFileSync(join(src, "course", "perms", "readonly"), "ro\n");
    chmodSync(join(src, "course", "perms", "readonly"), 0o444);
    writeFileSync(join(src, "ok.txt"), "ok\n");
    const archive = join(tmp, "project.tar");
    expect(
      run("tar", [
        "-cf",
        archive,
        "-C",
        src,
        "--exclude=./course/perms/nosearch",
        "--exclude=./course/perms/noread",
        ".",
      ]).status,
    ).toBe(0);
    expect(
      run("tar", [
        "-rf",
        archive,
        "-C",
        src,
        "--mode=a-rwx",
        "./course/perms/noread",
      ]).status,
    ).toBe(0);
    expect(
      run("tar", [
        "-rf",
        archive,
        "-C",
        src,
        "--mode=u=rw,go=",
        "./course/perms/nosearch",
      ]).status,
    ).toBe(0);

    const staging = join(tmp, "staging");
    const home = join(tmp, "home");
    mkdirSync(staging);
    mkdirSync(home);
    // Same mode-relevant flags as extractProjectArchiveTar.
    expect(
      run("tar", [
        "--delay-directory-restore",
        "--no-same-owner",
        "--no-overwrite-dir",
        "-xf",
        archive,
        "-C",
        staging,
      ]).status,
    ).toBe(0);
    expect(mode(join(staging, "course", "perms", "nosearch"))).toBe(0o600);
    expect(mode(join(staging, "course", "perms", "noread"))).toBe(0);

    if (!isRoot) {
      // The production failure: the apply rsync exits 23.
      expect(
        run("rsync", ["-aHS", "--delete", `${staging}/`, `${home}/`]).status,
      ).toBe(23);
    }

    const result = await grantOwnerAccessToExtractedTree({ root: staging });
    expect(result.adjusted_count).toBe(2);
    expect(result.adjusted_paths.sort()).toEqual([
      "course/perms/noread",
      "course/perms/nosearch",
    ]);
    expect(mode(join(staging, "course", "perms", "nosearch"))).toBe(0o700);
    // Only the owner read bit is added; other modes are preserved.
    expect(mode(join(staging, "course", "perms", "noread"))).toBe(0o400);
    expect(mode(join(staging, "course", "perms", "readonly"))).toBe(0o444);

    const copied = run("rsync", [
      "-aHS",
      "--delete",
      `${staging}/`,
      `${home}/`,
    ]);
    expect(copied).toEqual({ status: 0, stderr: "" });
    expect(
      readFileSync(join(home, "course", "perms", "nosearch", "file"), "utf8"),
    ).toBe("inside\n");
    expect(readFileSync(join(home, "course", "perms", "noread"), "utf8")).toBe(
      "secret\n",
    );
    expect(readFileSync(join(home, "ok.txt"), "utf8")).toBe("ok\n");
  });

  it("does not follow symlinks or touch excluded managed roots", async () => {
    const root = join(tmp, "staging");
    const outside = join(tmp, "outside");
    mkdirSync(join(root, ".snapshots", "locked"), { recursive: true });
    mkdirSync(join(root, "work"), { recursive: true });
    writeFileSync(outside, "outside\n");
    chmodSync(outside, 0o000);
    symlinkSync(outside, join(root, "work", "link"));
    chmodSync(join(root, ".snapshots", "locked"), 0o000);

    const result = await grantOwnerAccessToExtractedTree({
      root,
      exclude: [".snapshots"],
    });

    expect(result.adjusted_count).toBe(0);
    expect(mode(outside)).toBe(0);
    expect(mode(join(root, ".snapshots", "locked"))).toBe(0);
  });
});
