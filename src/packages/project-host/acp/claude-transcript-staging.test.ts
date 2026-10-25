/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { execFileSync } from "node:child_process";
import {
  chmod,
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
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultTranscriptStagings,
  maxTranscriptStagings,
  stageClaudeTranscripts,
} from "./claude-transcript-staging";
import { copyRegularFileBeneath } from "../beneath-copy";
import { isManagedClaudeTranscriptStaging } from "./claude-subscription-paths";

const projectId = "00000000-0000-4000-8000-0000000000aa";
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
  const staging = await stageClaudeTranscripts({
    projectId,
    projectHome,
    parts,
  });
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
  const staging = await stageClaudeTranscripts({
    projectId,
    projectHome,
    parts,
  });
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
  const staging = await stageClaudeTranscripts({
    projectId,
    projectHome,
    parts,
  });
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
  const staging = await stageClaudeTranscripts({
    projectId,
    projectHome,
    parts,
  });
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
    stageClaudeTranscripts({ projectId, projectHome, parts }),
  ).rejects.toThrow();
});

test("sync and close after close are no-ops", async () => {
  const staging = await stageClaudeTranscripts({
    projectId,
    projectHome,
    parts,
  });
  await staging.close();
  await staging.sync();
  await staging.close();
});

test("a file swapped for a symlink or FIFO before the copy is never copied or followed", async () => {
  const dest = await mkdtemp(join(tmpdir(), "claude-staging-dest-"));
  try {
    const workspace = join(transcripts, "-workspace");
    // What a stat-then-copy would race on: by the time of the copy, the name
    // is a symlink (to a host file) or a FIFO (which would block a reader).
    await symlink("/etc/passwd", join(workspace, "link.jsonl"));
    execFileSync("mkfifo", [join(workspace, "fifo.jsonl")]);
    for (const name of ["link.jsonl", "fifo.jsonl"]) {
      await expect(
        copyRegularFileBeneath({
          src: {
            root: projectHome,
            path: [...parts, "-workspace", name].join("/"),
          },
          dest: { root: dest, path: name },
          maxBytes: 1024,
        }),
      ).resolves.toEqual({ kind: "not-regular" });
    }
    expect(await readdir(dest)).toEqual([]);
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});

test("staging refuses a transcript tree larger than its byte bound", async () => {
  await writeFile(
    join(transcripts, "-workspace", "big.jsonl"),
    "x".repeat(4096),
  );
  await expect(
    stageClaudeTranscripts({ projectId, projectHome, parts, maxBytes: 1024 }),
  ).rejects.toThrow(/EFBIG|larger than/);
});

test("growth past the byte bound fails the sync, and close drops the staged copy", async () => {
  const staging = await stageClaudeTranscripts({
    projectId,
    projectHome,
    parts,
    maxBytes: 1024,
  });
  await writeFile(
    join(staging.directory, "-workspace", "big.jsonl"),
    "x".repeat(4096),
  );
  await expect(staging.sync()).rejects.toThrow(/EFBIG|larger than|exceed/);
  await staging.close();
  await expect(lstat(staging.directory)).rejects.toThrow();
});

test("close keeps the staged copy when the copy back may succeed later", async () => {
  const staging = await stageClaudeTranscripts({
    projectId,
    projectHome,
    parts,
  });
  await writeFile(join(staging.directory, "-workspace", "late.jsonl"), "late");
  // A failure that may pass (here: permission), not an unsafe path.
  await chmod(join(transcripts, "-workspace"), 0o500);
  try {
    await expect(staging.close()).rejects.toThrow();
    expect(
      await readFile(
        join(staging.directory, "-workspace", "late.jsonl"),
        "utf8",
      ),
    ).toBe("late");
  } finally {
    await chmod(join(transcripts, "-workspace"), 0o700);
  }
  // A retry saves it and only then removes the staged copy.
  await staging.close();
  expect(
    await readFile(join(transcripts, "-workspace", "late.jsonl"), "utf8"),
  ).toBe("late");
  await expect(lstat(staging.directory)).rejects.toThrow();
});

test("the default caps follow the host's CPUs and memory and the project's memory limit", () => {
  const GiB = 1024 ** 3;
  // A 16 CPU, 64 GiB host: memory bounds it, at 0.5 GiB per controller.
  expect(
    defaultTranscriptStagings({ cpus: 16, memoryBytes: 64 * GiB }),
  ).toEqual({ host: 128, project: 128 });
  // A host with little memory per CPU is bounded by its CPUs.
  expect(
    defaultTranscriptStagings({ cpus: 2, memoryBytes: 256 * GiB }),
  ).toEqual({ host: 64, project: 64 });
  // The project's memory limit bounds its own conversations.
  expect(
    defaultTranscriptStagings({
      cpus: 16,
      memoryBytes: 64 * GiB,
      projectMemoryBytes: 8 * GiB,
    }),
  ).toEqual({ host: 128, project: 16 });
  // A small project still gets two, but never more than the host.
  expect(
    defaultTranscriptStagings({
      cpus: 16,
      memoryBytes: 64 * GiB,
      projectMemoryBytes: GiB / 2,
    }),
  ).toEqual({ host: 128, project: 2 });
  expect(
    defaultTranscriptStagings({
      cpus: 1,
      memoryBytes: GiB / 4,
      projectMemoryBytes: 8 * GiB,
    }),
  ).toEqual({ host: 1, project: 1 });
});

test("the caps read the pool's and the project's cgroup memory limits, and the environment overrides them", async () => {
  const saved = {
    host: process.env.COCALC_CLAUDE_TRANSCRIPT_MAX_STAGINGS,
    project: process.env.COCALC_CLAUDE_TRANSCRIPT_MAX_PROJECT_STAGINGS,
  };
  delete process.env.COCALC_CLAUDE_TRANSCRIPT_MAX_STAGINGS;
  delete process.env.COCALC_CLAUDE_TRANSCRIPT_MAX_PROJECT_STAGINGS;
  const pool = await mkdtemp(join(tmpdir(), "claude-staging-pool-"));
  try {
    const cgroup = join(pool, `project-${projectId}`);
    await mkdir(cgroup);
    await writeFile(join(cgroup, "memory.max"), `${3 * 1024 ** 3}\n`);
    // The pool's own limit bounds the host's (here below any real host's RAM).
    await writeFile(join(pool, "memory.max"), `${4 * 1024 ** 3}\n`);
    expect(await maxTranscriptStagings(projectId, pool)).toEqual({
      host: Math.min(8, 32 * availableParallelism()),
      project: Math.min(6, 8, 32 * availableParallelism()),
    });
    await writeFile(join(pool, "memory.max"), "max\n");
    const limits = await maxTranscriptStagings(projectId, pool);
    expect(limits.project).toBe(Math.min(6, limits.host));
    // By default the pool is the one the project runner uses.
    const savedPool = process.env.COCALC_PROJECT_POOL_CGROUP;
    process.env.COCALC_PROJECT_POOL_CGROUP = pool;
    try {
      expect(await maxTranscriptStagings(projectId)).toEqual(limits);
    } finally {
      if (savedPool == null) delete process.env.COCALC_PROJECT_POOL_CGROUP;
      else process.env.COCALC_PROJECT_POOL_CGROUP = savedPool;
    }
    // No limit, or no cgroup: only the host bounds the project.
    await writeFile(join(cgroup, "memory.max"), "max\n");
    expect(await maxTranscriptStagings(projectId, pool)).toEqual({
      host: limits.host,
      project: limits.host,
    });
    expect(await maxTranscriptStagings(projectId, join(pool, "none"))).toEqual({
      host: limits.host,
      project: limits.host,
    });
    process.env.COCALC_CLAUDE_TRANSCRIPT_MAX_STAGINGS = "500";
    process.env.COCALC_CLAUDE_TRANSCRIPT_MAX_PROJECT_STAGINGS = "8";
    expect(await maxTranscriptStagings(projectId, pool)).toEqual({
      host: 500,
      project: 8,
    });
  } finally {
    await rm(pool, { recursive: true, force: true });
    for (const [name, value] of [
      ["COCALC_CLAUDE_TRANSCRIPT_MAX_STAGINGS", saved.host],
      ["COCALC_CLAUDE_TRANSCRIPT_MAX_PROJECT_STAGINGS", saved.project],
    ] as const) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("staging refuses more controllers than allowed for a project or the host", async () => {
  const first = await stageClaudeTranscripts({
    projectId,
    projectHome,
    parts,
    limits: { host: 100, project: 1 },
  });
  try {
    await expect(
      stageClaudeTranscripts({
        projectId,
        projectHome,
        parts,
        limits: { host: 100, project: 1 },
      }),
    ).rejects.toThrow(/Too many Claude controllers/);
    // The refused staging directory is removed again.
    const left = (await readdir(tmpdir())).filter((name) =>
      name.startsWith(`cocalc-claude-transcripts-${projectId}-`),
    );
    expect(left).toEqual([first.directory.split("/").pop()]);
  } finally {
    await first.close();
  }
});

test("a file that grows while staged counts at its staged size", async () => {
  // Three 400-byte files fit in 1300 bytes only if each counts as 400.
  for (const name of ["a", "b", "c"])
    await writeFile(
      join(transcripts, "-workspace", `${name}.jsonl`),
      "x".repeat(400),
    );
  await rm(join(transcripts, "-workspace", "s.jsonl"));
  const staging = await stageClaudeTranscripts({
    projectId,
    projectHome,
    parts,
    maxBytes: 1300,
  });
  try {
    // Growth in the staged copy is counted at its real size on the next sync.
    await writeFile(
      join(staging.directory, "-workspace", "a.jsonl"),
      "x".repeat(600),
    );
    await expect(staging.sync()).rejects.toThrow(/EFBIG|exceed|larger than/);
  } finally {
    await staging.close();
  }
});

test("each copy back renews the staging directory's time, which the reaper ages by", async () => {
  const staging = await stageClaudeTranscripts({
    projectId,
    projectHome,
    parts,
  });
  const old = new Date(Date.now() - 24 * 3600_000);
  await utimes(staging.directory, old, old);
  await writeFile(join(staging.directory, "-workspace", "late.jsonl"), "late");
  // A failure that may pass: the copy is kept, and kept from now.
  await chmod(join(transcripts, "-workspace"), 0o500);
  try {
    await expect(staging.close()).rejects.toThrow();
    expect(Date.now() - (await stat(staging.directory)).mtimeMs).toBeLessThan(
      60_000,
    );
  } finally {
    await chmod(join(transcripts, "-workspace"), 0o700);
  }
  await staging.close();
});
