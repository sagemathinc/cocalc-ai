/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import {
  purgeCredentialShellSnapshots,
  SHELL_ENVIRONMENT_EXCLUDE_CONFIG,
  SHELL_SNAPSHOT_LIMITS,
} from "./shell-snapshots";

const TOKEN = "synthetic-proxy-token-0123456789abcdefghijklmnop";

describe("Codex shell snapshots never keep a credential", () => {
  let root: string;
  let home: string;
  let snapshots: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codex-snapshots-"));
    home = join(root, "home");
    snapshots = join(home, ".codex", "shell_snapshots");
    await mkdir(snapshots, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("passes Codex the exclusion for the credential variable", () => {
    expect(SHELL_ENVIRONMENT_EXCLUDE_CONFIG).toBe(
      'shell_environment_policy.exclude=["OPENAI_API_KEY","HTTPS_PROXY","https_proxy"]',
    );
  });

  it("removes only snapshots that hold a credential variable", async () => {
    await writeFile(
      join(snapshots, "leaked.sh"),
      `export PATH=/usr/bin\nexport OPENAI_API_KEY='${TOKEN}'\n`,
    );
    await writeFile(join(snapshots, "clean.sh"), "export PATH=/usr/bin\n");
    await writeFile(join(home, ".codex", "config.toml"), "model = 'x'\n");
    await mkdir(join(snapshots, "nested"));
    await writeFile(
      join(snapshots, "nested", "inner.sh"),
      `export OPENAI_API_KEY='${TOKEN}'\n`,
    );

    expect(await purgeCredentialShellSnapshots(home)).toBe(1);
    expect((await readdir(snapshots)).sort()).toEqual(["clean.sh", "nested"]);
    // Other Codex state is untouched.
    expect(await readFile(join(home, ".codex", "config.toml"), "utf8")).toBe(
      "model = 'x'\n",
    );
  });

  it("removes snapshots holding the restricted egress proxy credential, not a project's own proxy", async () => {
    await writeFile(
      join(snapshots, "proxy.sh"),
      `export https_proxy='http://cocalc-codex:${TOKEN}@host.containers.internal:43128'\n`,
    );
    await writeFile(
      join(snapshots, "own-proxy.sh"),
      "export HTTPS_PROXY='http://proxy.example.com:3128'\n",
    );
    expect(await purgeCredentialShellSnapshots(home)).toBe(1);
    expect(await readdir(snapshots)).toEqual(["own-proxy.sh"]);
  });

  it("keeps the number of open descriptors bounded over a large directory", async () => {
    for (let i = 0; i < 2000; i++) {
      await writeFile(join(snapshots, `s${i}.sh`), "export A=1\n");
    }
    const before = readdirSync("/proc/self/fd").length;
    await purgeCredentialShellSnapshots(home);
    expect(readdirSync("/proc/self/fd").length - before).toBeLessThan(20);
  });

  it("skips a directory with more entries than the limit, without reading it all", async () => {
    for (let i = 0; i < 30; i++) {
      await writeFile(
        join(snapshots, `leak${i}.sh`),
        `export OPENAI_API_KEY='${TOKEN}'\n`,
      );
    }
    const limits = { ...SHELL_SNAPSHOT_LIMITS, maxEntries: 30 };
    expect(await purgeCredentialShellSnapshots(home, limits)).toBe(30);
    for (let i = 0; i < 31; i++) {
      await writeFile(
        join(snapshots, `junk${i}.sh`),
        `export OPENAI_API_KEY='${TOKEN}'\n`,
      );
    }
    expect(await purgeCredentialShellSnapshots(home, limits)).toBe(0);
    expect((await readdir(snapshots)).length).toBe(31);
  });

  it("stops reading after the total byte limit", async () => {
    for (let i = 0; i < 5; i++) {
      await writeFile(
        join(snapshots, `big${i}.sh`),
        `export OPENAI_API_KEY='${TOKEN}'\n${"#".repeat(1000)}\n`,
      );
    }
    const limits = { ...SHELL_SNAPSHOT_LIMITS, maxTotalBytes: 2500 };
    // The third file pushes the total past the limit; nothing after it is read.
    expect(await purgeCredentialShellSnapshots(home, limits)).toBe(3);
  });

  it("never follows a symlinked snapshot to a file outside the project", async () => {
    const outside = join(root, "outside.sh");
    await writeFile(outside, `export OPENAI_API_KEY='${TOKEN}'\n`);
    await symlink(outside, join(snapshots, "link.sh"));

    expect(await purgeCredentialShellSnapshots(home)).toBe(0);
    expect(await readFile(outside, "utf8")).toContain(TOKEN);
  });

  it("refuses a shell_snapshots directory that is a symlink", async () => {
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);
    await writeFile(
      join(elsewhere, "victim.sh"),
      `export OPENAI_API_KEY='${TOKEN}'\n`,
    );
    await rm(snapshots, { recursive: true });
    await symlink(elsewhere, snapshots);

    expect(await purgeCredentialShellSnapshots(home)).toBe(0);
    expect(await readdir(elsewhere)).toEqual(["victim.sh"]);
  });

  it("does nothing when there are no snapshots", async () => {
    await rm(join(home, ".codex"), { recursive: true });
    expect(await purgeCredentialShellSnapshots(home)).toBe(0);
  });
});
