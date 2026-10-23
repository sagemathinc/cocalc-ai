/** @jest-environment node */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryGitCache } from "./immutable-cache";
import { GIT_READ_LIMIT, GitReadService } from "./read-service";
import type { GitReadExecutor } from "./read-service";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "f@example.test",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "f@example.test",
    },
  });

let dir: string;
const calls: string[][] = [];
const execute: GitReadExecutor = async (options) => {
  calls.push(options.args!);
  const result = spawnSync("git", options.args!, {
    cwd: options.path,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    maxBuffer: GIT_READ_LIMIT + 1000,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exit_code: result.status ?? -1,
  };
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "git-cache-"));
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "first"]);
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  git(dir, ["commit", "-q", "-am", "second"]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => (calls.length = 0));

test("a commit read once is read again from the browser's cache, also after a reload", async () => {
  const persistent = new MemoryGitCache(50_000_000);
  const first = new GitReadService(execute, Date.now, 16_000_000, persistent);
  const { repository } = await first.discover("p", dir);
  const target = await first.pinCommit(
    repository,
    git(dir, ["rev-parse", "HEAD"]).trim(),
  );
  const summary = await first.commitSummary(repository, target.commit);
  const files = await first.changedFiles(target);
  const patch = await first.patch(target, 3);
  expect(summary).toContain("second");
  expect(patch).toContain("+two");

  // A reload: a new reader, the same browser cache.
  const second = new GitReadService(execute, Date.now, 16_000_000, persistent);
  calls.length = 0;
  const again = await second.pinCommit(repository, target.commit);
  expect(await second.commitSummary(repository, target.commit)).toBe(summary);
  expect(await second.changedFiles(again)).toEqual(files);
  expect(await second.patch(again, 3)).toBe(patch);
  // Not one git process.
  expect(calls).toEqual([]);
  // Another context is another read.
  await second.patch(again, 10);
  expect(calls).toHaveLength(1);
});

test("names that can change are read every time", async () => {
  const persistent = new MemoryGitCache(50_000_000);
  const reader = new GitReadService(execute, Date.now, 16_000_000, persistent);
  const { repository } = await reader.discover("p2", dir);
  calls.length = 0;
  await reader.resolveCommit(repository, "main");
  await reader.resolveCommit(repository, "main");
  expect(calls.filter((args) => args.includes("main^{commit}"))).toHaveLength(
    2,
  );
});

test("failures are not cached, and the same read in flight runs once", async () => {
  const persistent = new MemoryGitCache(50_000_000);
  const reader = new GitReadService(execute, Date.now, 16_000_000, persistent);
  const { repository } = await reader.discover("p3", dir);
  const missing = "0".repeat(40);
  await expect(reader.commitSummary(repository, missing)).rejects.toThrow();
  calls.length = 0;
  await expect(reader.commitSummary(repository, missing)).rejects.toThrow();
  expect(calls).toHaveLength(1);
  const head = git(dir, ["rev-parse", "HEAD"]).trim();
  calls.length = 0;
  await Promise.all([
    reader.commitSummary(repository, head),
    reader.commitSummary(repository, head),
  ]);
  // (Besides checking the clone isn't shallow.)
  expect(calls.filter((args) => args.includes("show"))).toHaveLength(1);
});

test("a shallow clone's parents and history are not kept: deepening it shows the real ones", async () => {
  const clone = mkdtempSync(join(tmpdir(), "git-cache-shallow-"));
  try {
    git(clone, ["clone", "-q", "--depth=1", `file://${dir}`, "."]);
    const head = git(clone, ["rev-parse", "HEAD"]).trim();
    const persistent = new MemoryGitCache(50_000_000);
    const first = new GitReadService(execute, Date.now, 16_000_000, persistent);
    const { repository } = await first.discover("p", clone);
    // The boundary looks parentless.
    expect((await first.pinCommit(repository, head)).parent).toBeNull();
    expect(await first.history(repository, head)).toHaveLength(1);

    git(clone, ["fetch", "-q", "--unshallow"]);
    const parent = git(clone, ["rev-parse", "HEAD^"]).trim();
    // The same tab, and a reload sharing the browser's cache.
    const second = new GitReadService(
      execute,
      Date.now,
      16_000_000,
      persistent,
    );
    for (const reader of [first, second]) {
      expect((await reader.pinCommit(repository, head)).parent).toBe(parent);
      expect(await reader.history(repository, head)).toHaveLength(2);
    }
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
});

test("a commit's summary doesn't follow .mailmap or notes, which can change", async () => {
  const head = git(dir, ["rev-parse", "HEAD"]).trim();
  writeFileSync(
    join(dir, ".mailmap"),
    "Someone Else <else@example.test> Fixture <f@example.test>\n",
  );
  git(dir, ["notes", "add", "-m", "a note", head]);
  try {
    const reader = new GitReadService(execute);
    const { repository } = await reader.discover("p4", dir);
    const summary = await reader.commitSummary(repository, head);
    expect(summary).toContain("Author:     Fixture <f@example.test>");
    expect(summary).not.toContain("Someone Else");
    expect(summary).not.toContain("a note");
  } finally {
    rmSync(join(dir, ".mailmap"));
    git(dir, ["notes", "remove", head]);
  }
});
