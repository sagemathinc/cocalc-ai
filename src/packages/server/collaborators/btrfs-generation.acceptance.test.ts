/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { execFile } from "node:child_process";
import { mkdtemp, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const acceptance = process.env.COCALC_BTRFS_PROBE_ROOT
  ? describe
  : describe.skip;

acceptance("live btrfs generation proof spike", () => {
  test("records whether distinct durable writes share a generation", async () => {
    // Caller must choose a btrfs directory. Never snapshots, freezes, syncs the
    // whole filesystem, changes mount flags, or modifies preexisting files.
    const root = await mkdtemp(
      join(resolve(process.env.COCALC_BTRFS_PROBE_ROOT!), "people-proof-"),
    );
    try {
      const binary = join(root, "probe");
      await execute("cc", [
        "-Wall",
        "-Wextra",
        "-Werror",
        "-O2",
        join(__dirname, "acceptance/btrfs-generation-probe.c"),
        "-o",
        binary,
      ]);
      const sample = async () =>
        JSON.parse((await execute(binary, [root])).stdout);
      const observations: Array<{
        operation: string;
        generation: string;
        uuid: string;
      }> = [];
      const record = async (operation: string) =>
        observations.push({ operation, ...(await sample()) });
      await record("before");
      const file = await open(join(root, "fixture"), "wx");
      try {
        await file.write("first");
        await file.sync();
        await record("create-fsync");
        await file.write("second", 0);
        await file.sync();
        await record("overwrite-fsync");
        await file.truncate(0);
        await file.sync();
        await record("truncate-fsync");
      } finally {
        await file.close();
      }
      await rename(join(root, "fixture"), join(root, "renamed"));
      await record("rename");
      await rm(join(root, "renamed"));
      await record("unlink");
      expect(new Set(observations.map((x) => x.uuid)).size).toBe(1);
      for (const row of observations) expect(row.generation).toMatch(/^\d+$/);
      const repeated = observations
        .slice(1)
        .some((row, i) => row.generation === observations[i].generation);
      process.stdout.write(
        JSON.stringify({
          probe: "live-subvolume-generation",
          observations,
          equalGenerationAcrossChanges: repeated,
          conclusion: repeated
            ? "bare generation is not a no-change proof"
            : "inconclusive; equality safety is not established",
        }) + "\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
