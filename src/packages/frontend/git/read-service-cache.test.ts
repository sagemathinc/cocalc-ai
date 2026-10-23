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
// Git processes other than the checks made before reading from a cache:
// that the clone isn't shallow (parents, history) and the changed files'
// attributes (patches).
const reads = () =>
  calls.filter(
    (args) =>
      !args.includes("--is-shallow-repository") && !args.includes("check-attr"),
  );

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
  // Not one git read.
  expect(reads()).toEqual([]);
  // Another context is another read.
  await second.patch(again, 10);
  expect(reads()).toHaveLength(1);
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
  expect(reads()).toHaveLength(1);
  const head = git(dir, ["rev-parse", "HEAD"]).trim();
  calls.length = 0;
  await Promise.all([
    reader.commitSummary(repository, head),
    reader.commitSummary(repository, head),
  ]);
  expect(reads()).toHaveLength(1);
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

test("diff settings that can change don't decide cached diffs", async () => {
  const repo = mkdtempSync(join(tmpdir(), "git-cache-config-"));
  try {
    git(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "a.txt"), "a\n");
    writeFileSync(join(repo, "b.txt"), "b\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "first"]);
    writeFileSync(join(repo, "a.txt"), "a\nmore\n");
    writeFileSync(join(repo, "b.txt"), "b\nmore\n");
    git(repo, ["commit", "-q", "-am", "second"]);
    writeFileSync(join(repo, "order"), "b.txt\na.txt\n");
    git(repo, ["config", "diff.orderFile", join(repo, "order")]);
    git(repo, ["config", "diff.noprefix", "true"]);
    git(repo, ["config", "color.ui", "always"]);
    const reader = new GitReadService(execute);
    const { repository } = await reader.discover("p5", repo);
    const target = await reader.pinCommit(
      repository,
      git(repo, ["rev-parse", "HEAD"]).trim(),
    );
    const files = await reader.changedFiles(target);
    expect(files.map((file) => file.newPath)).toEqual(["a.txt", "b.txt"]);
    const patch = await reader.patch(target);
    expect(
      patch.split("\n").filter((line) => line.startsWith("diff --git")),
    ).toEqual(["diff --git a/a.txt b/a.txt", "diff --git a/b.txt b/b.txt"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a clone made shallow later is not answered from the cache", async () => {
  const clone = mkdtempSync(join(tmpdir(), "git-cache-shorten-"));
  try {
    git(clone, ["clone", "-q", `file://${dir}`, "."]);
    const head = git(clone, ["rev-parse", "HEAD"]).trim();
    const parent = git(clone, ["rev-parse", "HEAD^"]).trim();
    const persistent = new MemoryGitCache(50_000_000);
    const reader = new GitReadService(
      execute,
      Date.now,
      16_000_000,
      persistent,
    );
    const { repository } = await reader.discover("p6", clone);
    expect((await reader.pinCommit(repository, head)).parent).toBe(parent);
    expect(await reader.history(repository, head)).toHaveLength(2);

    git(clone, ["fetch", "-q", "--depth=1", "origin", "main"]);
    // The same tab, and a reload sharing the browser's cache.
    const reloaded = new GitReadService(
      execute,
      Date.now,
      16_000_000,
      persistent,
    );
    for (const r of [reader, reloaded]) {
      expect((await r.pinCommit(repository, head)).parent).toBeNull();
      expect(await r.history(repository, head)).toHaveLength(1);
    }
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
});

test("patches show full ids on index lines, whatever core.abbrev is", async () => {
  git(dir, ["config", "core.abbrev", "5"]);
  try {
    const reader = new GitReadService(execute);
    const { repository } = await reader.discover("p7", dir);
    const target = await reader.pinCommit(
      repository,
      git(dir, ["rev-parse", "HEAD"]).trim(),
    );
    expect(await reader.patch(target)).toMatch(
      /^index [0-9a-f]{40}\.\.[0-9a-f]{40}/m,
    );
  } finally {
    git(dir, ["config", "--unset", "core.abbrev"]);
  }
});

test("history is read as UTF-8, whatever the log encoding is set to", async () => {
  const repo = mkdtempSync(join(tmpdir(), "git-cache-encoding-"));
  try {
    git(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "café"]);
    git(repo, ["config", "i18n.logOutputEncoding", "ISO-8859-1"]);
    const reader = new GitReadService(execute);
    const { repository } = await reader.discover("p8", repo);
    const history = await reader.history(
      repository,
      git(repo, ["rev-parse", "HEAD"]).trim(),
    );
    expect(history[0].subject).toBe("café");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a commit's summary names commits in full and no branches", async () => {
  const head = git(dir, ["rev-parse", "HEAD"]).trim();
  for (const [key, value] of [
    ["core.abbrev", "5"],
    ["log.abbrevCommit", "true"],
    ["log.decorate", "full"],
  ])
    git(dir, ["config", key, value]);
  try {
    const reader = new GitReadService(execute);
    const { repository } = await reader.discover("p9", dir);
    const summary = await reader.commitSummary(repository, head);
    expect(summary.split("\n")[0]).toBe(`commit ${head}`);
  } finally {
    for (const key of ["core.abbrev", "log.abbrevCommit", "log.decorate"])
      git(dir, ["config", "--unset", key]);
  }
});

test("a patch follows the attributes of its files, which can change", async () => {
  const persistent = new MemoryGitCache(50_000_000);
  const first = new GitReadService(execute, Date.now, 16_000_000, persistent);
  const { repository } = await first.discover("p10", dir);
  const target = await first.pinCommit(
    repository,
    git(dir, ["rev-parse", "HEAD"]).trim(),
  );
  expect(await first.patch(target)).toContain("+two");
  writeFileSync(join(dir, ".gitattributes"), "a.txt -diff\n");
  try {
    const reloaded = new GitReadService(
      execute,
      Date.now,
      16_000_000,
      persistent,
    );
    for (const reader of [first, reloaded])
      expect(await reader.patch(target)).toContain("Binary files");
  } finally {
    rmSync(join(dir, ".gitattributes"));
  }
  expect(await first.patch(target)).toContain("+two");
});

test("paths too long for one command, or a failed check, leave the patch uncached but read", async () => {
  const repo = mkdtempSync(join(tmpdir(), "git-cache-long-"));
  try {
    git(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "keep"), "\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "first"]);
    // 300 names of 240 bytes: over the limit on the command line.
    for (let i = 0; i < 300; i++)
      writeFileSync(
        join(repo, `${String(i).padStart(3, "0")}${"x".repeat(237)}`),
        "x\n",
      );
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "many"]);
    const head = git(repo, ["rev-parse", "HEAD"]).trim();
    const reader = new GitReadService(execute);
    const { repository } = await reader.discover("p11", repo);
    const target = await reader.pinCommit(repository, head);
    calls.length = 0;
    expect(await reader.patch(target)).toContain("+x");
    expect(calls.some((args) => args.includes("check-attr"))).toBe(false);
    calls.length = 0;
    await reader.patch(target);
    // Not from a cache.
    expect(calls.some((args) => args.includes("--patch"))).toBe(true);

    const failing: GitReadExecutor = async (options) =>
      options.args!.includes("check-attr")
        ? { stdout: "", stderr: "no", exit_code: 1 }
        : execute(options);
    const other = new GitReadService(failing);
    const first = await other.pinCommit(
      repository,
      git(repo, ["rev-parse", "HEAD^"]).trim(),
    );
    expect(await other.patch(first)).toContain("+");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a branch named like a SHA-256 id, in a SHA-1 repository, is read every time", async () => {
  const name = "a".repeat(64);
  git(dir, ["branch", name, "HEAD^"]);
  try {
    const persistent = new MemoryGitCache(50_000_000);
    const reader = new GitReadService(
      execute,
      Date.now,
      16_000_000,
      persistent,
    );
    const { repository } = await reader.discover("p12", dir);
    expect(await reader.resolveCommit(repository, name)).toBe(
      git(dir, ["rev-parse", "HEAD^"]).trim(),
    );
    git(dir, ["branch", "-f", name, "HEAD"]);
    expect(await reader.resolveCommit(repository, name)).toBe(
      git(dir, ["rev-parse", "HEAD"]).trim(),
    );
  } finally {
    git(dir, ["branch", "-D", name]);
  }
});

test("grafts, which can be edited, don't change parents or history", async () => {
  const repo = mkdtempSync(join(tmpdir(), "git-cache-grafts-"));
  try {
    git(repo, ["init", "-q", "-b", "main"]);
    for (const message of ["one", "two", "three"])
      git(repo, ["commit", "-q", "--allow-empty", "-m", message]);
    const [head, parent, root] = git(repo, ["rev-list", "HEAD"])
      .trim()
      .split("\n");
    writeFileSync(join(repo, ".git", "info", "grafts"), `${head} ${root}\n`);
    const reader = new GitReadService(execute);
    const { repository } = await reader.discover("p13", repo);
    expect((await reader.pinCommit(repository, head)).parent).toBe(parent);
    expect(await reader.history(repository, head)).toHaveLength(3);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("core.bigFileThreshold doesn't make a cached patch binary", async () => {
  git(dir, ["config", "core.bigFileThreshold", "1"]);
  try {
    const reader = new GitReadService(execute);
    const { repository } = await reader.discover("p14", dir);
    const target = await reader.pinCommit(
      repository,
      git(dir, ["rev-parse", "HEAD"]).trim(),
    );
    expect(await reader.patch(target)).toContain("+two");
  } finally {
    git(dir, ["config", "--unset", "core.bigFileThreshold"]);
  }
});
