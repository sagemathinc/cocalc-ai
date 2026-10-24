/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageClaudeTranscripts } from "./claude-transcript-staging";
import { isManagedClaudeTranscriptStaging } from "./claude-subscription-paths";

const parts = [
  ".local",
  "share",
  "cocalc",
  "claude-sessions",
  "account",
  "cred",
];
let projectHome: string;
let elsewhere: string;
let transcripts: string;

beforeEach(async () => {
  projectHome = await mkdtemp(join(tmpdir(), "claude-staging-home-"));
  elsewhere = await mkdtemp(join(tmpdir(), "claude-staging-elsewhere-"));
  transcripts = join(projectHome, ...parts);
  await mkdir(join(transcripts, "-workspace"), { recursive: true });
  await writeFile(join(transcripts, "-workspace", "s.jsonl"), "saved\n");
});

afterEach(async () => {
  await rm(projectHome, { recursive: true, force: true });
  await rm(elsewhere, { recursive: true, force: true });
});

test("stages the project's transcripts in a host-owned directory, not the project's", async () => {
  const staging = await stageClaudeTranscripts({ projectHome, parts });
  try {
    expect(isManagedClaudeTranscriptStaging(staging.directory)).toBe(true);
    expect(staging.directory.startsWith(projectHome)).toBe(false);
    expect(
      await readFile(join(staging.directory, "-workspace", "s.jsonl"), "utf8"),
    ).toBe("saved\n");
  } finally {
    await staging.close();
  }
  await expect(lstat(staging.directory)).rejects.toThrow();
});

test("never copies a symlink the project planted, in either direction", async () => {
  await symlink("/etc/passwd", join(transcripts, "-workspace", "link.jsonl"));
  await symlink(elsewhere, join(transcripts, "linkdir"));
  const staging = await stageClaudeTranscripts({ projectHome, parts });
  try {
    expect((await readdir(staging.directory)).sort()).toEqual(["-workspace"]);
    expect(await readdir(join(staging.directory, "-workspace"))).toEqual([
      "s.jsonl",
    ]);
    // A symlink the controller writes is not copied back either.
    await symlink(elsewhere, join(staging.directory, "-workspace", "out"));
    await staging.sync();
    await expect(
      lstat(join(transcripts, "-workspace", "out")),
    ).rejects.toThrow();
  } finally {
    await staging.close();
  }
});

test("copies new and changed transcripts back after a turn, and not unchanged ones", async () => {
  const staging = await stageClaudeTranscripts({ projectHome, parts });
  try {
    const saved = join(transcripts, "-workspace", "s.jsonl");
    // A copy writes a new file and renames it into place: a new inode.
    const before = (await stat(saved)).ino;
    await writeFile(join(staging.directory, "-workspace", "new.jsonl"), "n\n");
    await mkdir(join(staging.directory, "-workspace", "sub"));
    await writeFile(
      join(staging.directory, "-workspace", "sub", "a.jsonl"),
      "a",
    );
    await staging.sync();
    expect(
      await readFile(join(transcripts, "-workspace", "new.jsonl"), "utf8"),
    ).toBe("n\n");
    expect(
      await readFile(join(transcripts, "-workspace", "sub", "a.jsonl"), "utf8"),
    ).toBe("a");
    expect((await stat(saved)).ino).toBe(before);

    // A later write to the same staged file is copied back on the next sync.
    const staged = join(staging.directory, "-workspace", "new.jsonl");
    await writeFile(staged, "n\nmore\n");
    const later = new Date(Date.now() + 5000);
    await utimes(staged, later, later);
    await staging.sync();
    expect(
      await readFile(join(transcripts, "-workspace", "new.jsonl"), "utf8"),
    ).toBe("n\nmore\n");
  } finally {
    await staging.close();
  }
});

test("copying back refuses a symlink the project swapped into its directory", async () => {
  const staging = await stageClaudeTranscripts({ projectHome, parts });
  await writeFile(join(staging.directory, "-workspace", "new.jsonl"), "n\n");
  // After staging, the project replaces an ancestor with a symlink elsewhere.
  const local = join(projectHome, ".local");
  await rename(local, join(projectHome, "moved"));
  await symlink(elsewhere, local);
  await expect(staging.sync()).rejects.toThrow();
  // Closing still removes the staged copy, and nothing landed elsewhere.
  await staging.close();
  await expect(lstat(staging.directory)).rejects.toThrow();
  expect(await readdir(elsewhere)).toEqual([]);
});

test("staging refuses a project whose transcript path goes through a symlink", async () => {
  await rm(join(projectHome, ".local"), { recursive: true });
  await mkdir(
    join(elsewhere, "share", "cocalc", "claude-sessions", "account", "cred"),
    {
      recursive: true,
    },
  );
  await writeFile(
    join(
      elsewhere,
      "share",
      "cocalc",
      "claude-sessions",
      "account",
      "cred",
      "x.jsonl",
    ),
    "not the project's",
  );
  await symlink(elsewhere, join(projectHome, ".local"));
  await expect(
    stageClaudeTranscripts({ projectHome, parts }),
  ).rejects.toThrow();
});

test("sync and close after close are no-ops", async () => {
  const staging = await stageClaudeTranscripts({ projectHome, parts });
  await staging.close();
  await staging.sync();
  await staging.close();
});
