/** @jest-environment node */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readTargetDiff } from "./read-target-diff";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitReadService, GIT_READ_LIMIT } from "./read-service";
import type { GitReadExecutor } from "./read-service";
import { loadGitHistoricalFile } from "./historical-file";
import { resolveHistorySelection } from "./history-selection";
import { locateCommitWorktree } from "./commit-worktree";
import { validateAgentWorktree } from "./agent-worktree";
import {
  parseHistory,
  parseRawDiff,
  parseRefs,
  parseWorktrees,
} from "./read-parsers";
import {
  repositoryKey,
  reviewTargetKey,
  ReviewRequestGeneration,
} from "../components/diff-viewer/review-model";
import type { RepositoryContext } from "../components/diff-viewer/review-model";

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Review fixture",
      GIT_AUTHOR_EMAIL: "review@example.test",
      GIT_COMMITTER_NAME: "Review fixture",
      GIT_COMMITTER_EMAIL: "review@example.test",
    },
  });

const execute: GitReadExecutor = async (options) => {
  expect(options.bash).toBe(false);
  expect(options.command).toBe("git");
  const result = spawnSync("git", options.args!, {
    cwd: options.path,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    maxBuffer: GIT_READ_LIMIT + 1000,
  });
  if (result.error) throw result.error;
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exit_code: result.status ?? -1,
  };
};

describe("read-only Git fixtures", () => {
  let dir: string,
    main: string,
    feature: string,
    detached: string,
    stale: string;
  let root: string, featureTip: string, mainTip: string, mergeTip: string;
  let service: GitReadService, repository: RepositoryContext;
  const names = [
    "space name.ts",
    "tab\tname.ts",
    "newline\nname.ts",
    "日本語.ts",
    "-dash.ts",
    ":(glob)*.ts",
  ];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "cocalc-git-review-"));
    main = join(dir, "main");
    feature = join(dir, "feature worktree");
    detached = join(dir, "detached");
    stale = join(dir, "removed");
    mkdirSync(main);
    git(main, ["init", "-b", "main"]);
    writeFileSync(join(main, "unchanged.md"), "# historical rich document\n");
    for (const name of names)
      writeFileSync(join(main, name), `original ${name}\n`);
    git(main, ["add", "--all"]);
    git(main, ["commit", "-m", "root"]);
    root = git(main, ["rev-parse", "HEAD"]).trim();
    git(main, ["worktree", "add", "-b", "feature", feature]);
    writeFileSync(
      join(feature, "feature.txt"),
      "feature without final newline",
    );
    git(feature, ["mv", "--", "space name.ts", "renamed name.ts"]);
    git(feature, ["rm", "--", "-dash.ts"]);
    symlinkSync("/never-follow-this", join(feature, "link"));
    writeFileSync(join(feature, "binary"), Buffer.from([0, 1, 2]));
    git(feature, ["add", "--all"]);
    git(feature, ["commit", "-m", "feature"]);
    featureTip = git(feature, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(main, "main.txt"), "main\n");
    git(main, ["add", "--all"]);
    git(main, ["commit", "-m", "main divergence"]);
    mainTip = git(main, ["rev-parse", "HEAD"]).trim();
    git(main, ["worktree", "add", "--detach", detached, root]);
    git(main, ["worktree", "add", "--detach", stale, root]);
    rmSync(stale, { recursive: true });
    git(main, ["merge", "--no-ff", "feature", "-m", "merge feature"]);
    mergeTip = git(main, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(main, "dirty.txt"), "staged\n");
    git(main, ["add", "--", "dirty.txt"]);
    writeFileSync(join(main, "dirty.txt"), "unstaged\n");
    writeFileSync(join(feature, "untracked.txt"), "do not touch\n");
    service = new GitReadService(execute);
    repository = (await service.discover("project", main)).repository;
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("agent worktree validation rejects moved HEADs, mismatched branches, missing paths and unrelated commits without writes", async () => {
    const before = git(feature, ["status", "--porcelain=v1"]);
    expect(
      await validateAgentWorktree(
        service,
        repository,
        feature,
        featureTip,
        root,
        "refs/heads/feature",
      ),
    ).toMatchObject({
      workingDirectory: feature,
      expectedHead: featureTip,
      reviewedCommit: root,
    });
    await expect(
      validateAgentWorktree(
        service,
        repository,
        feature,
        root,
        root,
        "refs/heads/feature",
      ),
    ).rejects.toThrow("HEAD changed");
    await expect(
      validateAgentWorktree(
        service,
        repository,
        feature,
        featureTip,
        root,
        "refs/heads/other",
      ),
    ).rejects.toThrow("branch changed");
    await expect(
      validateAgentWorktree(service, repository, stale, root, root),
    ).rejects.toThrow("no longer available");
    await expect(
      validateAgentWorktree(
        service,
        repository,
        feature,
        featureTip,
        mainTip,
        "refs/heads/feature",
      ),
    ).rejects.toThrow("not contained");
    expect(git(feature, ["status", "--porcelain=v1"])).toBe(before);
    expect(git(feature, ["rev-parse", "HEAD"]).trim()).toBe(featureTip);
  });

  test("bare commit lookup prefers current containment, chooses only unique worktrees, and leaves checkouts untouched", async () => {
    const state = () =>
      [main, feature, detached].map((path) => ({
        head: git(path, ["rev-parse", "HEAD"]),
        status: git(path, ["status", "--porcelain=v1"]),
      }));
    const before = state();
    const index = readFileSync(join(main, ".git/index"));
    const current = await locateCommitWorktree(
      service,
      await service.discover("project", main),
      featureTip.slice(0, 10),
    );
    expect(current).toEqual({ kind: "current", commit: featureTip });
    const origin = await service.discover("project", detached);
    const ambiguous = await locateCommitWorktree(service, origin, featureTip);
    expect(ambiguous).toMatchObject({
      kind: "ambiguous",
      commit: featureTip,
      paths: expect.arrayContaining([main, feature]),
    });
    const unique = await locateCommitWorktree(service, origin, mainTip);
    expect(unique).toMatchObject({
      kind: "unique",
      commit: mainTip,
      selection: { worktree: main, ref: "refs/heads/main", firstParent: false },
      tip: mergeTip,
    });
    const tree = git(main, ["rev-parse", `${root}^{tree}`]).trim();
    const orphan = git(main, [
      "commit-tree",
      tree,
      "-m",
      "unreferenced historical commit",
    ]).trim();
    expect(await locateCommitWorktree(service, origin, orphan)).toEqual({
      kind: "historical",
      commit: orphan,
      paths: [],
    });
    expect(state()).toEqual(before);
    expect(readFileSync(join(main, ".git/index"))).toEqual(index);
  });

  test("does not select a checkout whose HEAD changed during locator validation", async () => {
    const origin = await service.discover("project", detached);
    const discover = service.discover.bind(service);
    const spy = jest
      .spyOn(service, "discover")
      .mockImplementation(async (project, path) => {
        const found = await discover(project, path);
        return path === main
          ? {
              ...found,
              worktrees: found.worktrees.map((tree) =>
                tree.path === main ? { ...tree, head: root } : tree,
              ),
            }
          : found;
      });
    try {
      await expect(
        locateCommitWorktree(service, origin, mainTip),
      ).rejects.toThrow("changed during lookup");
    } finally {
      spy.mockRestore();
    }
  });

  test("historical opening pins unchanged/off-branch files and deleted/renamed sources without a checkout", async () => {
    const index = readFileSync(join(main, ".git/index"));
    const status = git(main, ["status", "--porcelain=v1"]);
    const request = {
      projectId: "project",
      cwd: detached,
      commit: featureTip.slice(0, 10),
    };
    const unchanged = await loadGitHistoricalFile(service, {
      ...request,
      path: "unchanged.md",
    });
    expect(unchanged.contents).toBe("# historical rich document\n");
    expect(unchanged.source.commit).toBe(featureTip);
    const deleted = await loadGitHistoricalFile(service, {
      ...request,
      path: "-dash.ts",
    });
    expect(deleted.source.commit).toBe(root);
    expect(deleted.contents).toBe("original -dash.ts\n");
    const renamed = await loadGitHistoricalFile(service, {
      ...request,
      path: "renamed name.ts",
    });
    expect(renamed.source.path).toBe("renamed name.ts");
    expect(renamed.source.commit).toBe(featureTip);
    // An exact old-side descriptor does not redirect to the new name/revision.
    const old = await loadGitHistoricalFile(service, {
      source: {
        kind: "git",
        repository,
        commit: root,
        path: "space name.ts",
      },
    });
    expect(old.source.path).toBe("space name.ts");
    await expect(
      loadGitHistoricalFile(service, {
        source: { ...old.source, blob: "0".repeat(40) },
      }),
    ).rejects.toMatchObject({ kind: "incomplete" });
    await expect(
      loadGitHistoricalFile(service, { ...request, path: "missing.ts" }),
    ).rejects.toMatchObject({ kind: "missing" });
    expect(readFileSync(join(main, ".git/index"))).toEqual(index);
    expect(git(main, ["status", "--porcelain=v1"])).toBe(status);
    expect(git(detached, ["rev-parse", "HEAD"]).trim()).toBe(root);
  });

  test("history selection pins refs without changing either working copy", async () => {
    const origin = await service.discover("p", main);
    const before = [main, feature].map((path) => [
      git(path, ["rev-parse", "HEAD"]),
      git(path, ["status", "--porcelain=v1"]),
    ]);
    const selected = await resolveHistorySelection(service, origin, {
      worktree: feature,
      ref: "refs/heads/main",
      firstParent: true,
    });
    expect(selected.discovery.repository.locator).toBe(feature);
    expect(selected.tip).toBe(git(main, ["rev-parse", "HEAD"]).trim());
    expect(
      [main, feature].map((path) => [
        git(path, ["rev-parse", "HEAD"]),
        git(path, ["status", "--porcelain=v1"]),
      ]),
    ).toEqual(before);
    await expect(
      resolveHistorySelection(service, origin, {
        worktree: stale,
        ref: "HEAD",
        firstParent: true,
      }),
    ).rejects.toThrow(/no longer available/);
    await expect(
      resolveHistorySelection(service, origin, {
        worktree: dir,
        ref: "HEAD",
        firstParent: true,
      }),
    ).rejects.toThrow(/no longer available/);
    expect(
      (
        await resolveHistorySelection(service, origin, {
          worktree: detached,
          ref: "HEAD",
          firstParent: false,
        })
      ).tip,
    ).toBe(root);
  });

  test("shared identity, distinct worktrees, detached and removed metadata", async () => {
    const first = await service.discover("project", main);
    const second = await service.discover("project", feature);
    expect(repositoryKey(first.repository)).toBe(
      repositoryKey(second.repository),
    );
    expect(first.repository.locator).not.toBe(second.repository.locator);
    expect(first.worktrees.find((w) => w.path === detached)?.detached).toBe(
      true,
    );
    expect(
      first.worktrees.find((w) => w.path === stale)?.prunable,
    ).toBeDefined();
    expect(
      first.refs.find((r) => r.name === "refs/heads/feature")?.object,
    ).toBe(featureTip);
  });

  test("resolves off-branch commits and refuses invalid or option-like refs", async () => {
    const repo = (await service.discover("project", detached)).repository;
    expect(await service.resolveCommit(repo, featureTip.slice(0, 9))).toBe(
      featureTip,
    );
    await expect(service.resolveCommit(repo, "--help")).rejects.toMatchObject({
      kind: "git",
    });
    await expect(service.resolveCommit(repo, "a\0b")).rejects.toMatchObject({
      kind: "invalid",
    });
  });

  test("ambiguous branch/tag shorthand must not silently select either object", async () => {
    git(main, ["branch", "ambiguous-name", mainTip]);
    git(main, ["tag", "ambiguous-name", featureTip]);
    await expect(
      service.resolveCommit(repository, "ambiguous-name"),
    ).rejects.toMatchObject({ kind: "ambiguous" });
    expect(
      await service.resolveCommit(repository, "refs/heads/ambiguous-name"),
    ).toBe(mainTip);
    expect(
      await service.resolveCommit(repository, "refs/tags/ambiguous-name"),
    ).toBe(featureTip);
  });

  test("history pins the chosen tip, includes merges and supports parent traversal and pages", async () => {
    const firstParent = await service.history(repository, mergeTip, {
      firstParent: true,
    });
    expect(firstParent.map((x) => x.commit)).toEqual([mergeTip, mainTip, root]);
    expect(firstParent[0].parents).toEqual([mainTip, featureTip]);
    const all = await service.history(repository, mergeTip);
    expect(all.map((x) => x.commit)).toContain(featureTip);
    expect(
      (
        await service.history(repository, mergeTip, {
          skip: 1,
          count: 1,
          firstParent: true,
        })
      )[0].commit,
    ).toBe(mainTip);
  });

  test("hiding merges filters before pagination without changing traversal or the tip", async () => {
    const hidden = await service.history(repository, mergeTip, {
      showMerges: false,
      firstParent: true,
    });
    expect(hidden.map((entry) => entry.commit)).toEqual([mainTip, root]);
    expect(
      (
        await service.history(repository, mergeTip, {
          showMerges: false,
          firstParent: true,
          skip: 1,
          count: 1,
        })
      ).map((entry) => entry.commit),
    ).toEqual([root]);
    const all = await service.history(repository, mergeTip, {
      showMerges: false,
    });
    expect(all.map((entry) => entry.commit)).toContain(featureTip);
    expect(all.map((entry) => entry.commit)).toEqual(
      git(main, ["log", "--no-merges", "--format=%H", mergeTip, "--"])
        .trim()
        .split("\n"),
    );
    expect(
      (
        await service.history(repository, mergeTip, {
          showMerges: false,
          skip: 1,
          count: 1,
        })
      ).map((entry) => entry.commit),
    ).toEqual(all.slice(1, 2).map((entry) => entry.commit));
    expect(all.every((entry) => entry.parents.length < 2)).toBe(true);
    expect((await service.history(repository, mergeTip))[0].commit).toBe(
      mergeTip,
    );
  });

  test("root and each merge parent have explicit nonempty comparisons", async () => {
    const initial = await service.pinCommit(repository, root);
    expect(initial.parent).toBeNull();
    expect((await service.changedFiles(initial)).map((f) => f.newPath)).toEqual(
      expect.arrayContaining(names),
    );
    const merge = await service.pinCommit(repository, mergeTip);
    expect(merge.parent).toBe(mainTip);
    const second = await service.pinCommit(repository, mergeTip, 1);
    expect(second.parent).toBe(featureTip);
    expect(reviewTargetKey(merge)).not.toBe(reviewTargetKey(second));
    expect(await service.patch(second)).toContain("main.txt");
    await expect(
      service.pinCommit(repository, mergeTip, 2),
    ).rejects.toMatchObject({ kind: "invalid" });
  });

  test("drawer target diffs retain literal paths and explicit source revisions", async () => {
    const initial = await service.pinCommit(repository, root);
    const parsed = await readTargetDiff(service, initial, 3);
    expect(parsed.summary.commit).toBe(root);
    expect(parsed.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(names),
    );
    for (const file of parsed.files) {
      expect(file.oldSource).toBeUndefined();
      expect(file.newSource?.commit).toBe(root);
      expect(file.newSource?.path).toBe(file.path);
    }
    const second = await service.pinCommit(repository, mergeTip, 1);
    const diff = await readTargetDiff(service, second, 3);
    expect(diff.files.some((file) => file.path === "main.txt")).toBe(true);
    const range = await service.compare(repository, root, root, "trees");
    expect((await readTargetDiff(service, range, 3)).files).toEqual([]);
  });

  test("merge-base and trees are distinct; refs moving cannot change a pinned review", async () => {
    const range = await service.compare(
      repository,
      mainTip,
      featureTip,
      "merge-base",
    );
    expect(range.base).toBe(root);
    const trees = await service.compare(
      repository,
      mainTip,
      featureTip,
      "trees",
    );
    expect(trees.base).toBe(mainTip);
    expect(reviewTargetKey(trees)).not.toBe(reviewTargetKey(range));
    git(main, ["branch", "movable", featureTip]);
    const pinned = await service.compare(repository, root, "movable", "trees");
    const before = await service.patch(pinned);
    git(main, ["branch", "-f", "movable", mainTip]);
    expect(await service.patch(pinned)).toBe(before);
    const merged = await service.compare(
      repository,
      mergeTip,
      featureTip,
      "merge-base",
    );
    expect(await service.patch(merged)).toBe("");
  });

  test("literal odd paths, deleted and renamed sources, binary and symlink metadata", async () => {
    const target = await service.pinCommit(repository, featureTip);
    const files = await service.changedFiles(target);
    const renamed = files.find((f) => f.change === "rename")!;
    expect(renamed.oldPath).toBe("space name.ts");
    expect(renamed.newPath).toBe("renamed name.ts");
    expect(
      files.find((f) => f.oldPath === "-dash.ts")?.newSource,
    ).toBeUndefined();
    expect(files.find((f) => f.newPath === "link")?.content).toBe("symlink");
    for (const name of names)
      expect((await service.readFile(repository, root, name)).contents).toBe(
        `original ${name}\n`,
      );
    expect(
      (await service.readFile(repository, featureTip, "unchanged.md")).contents,
    ).toBe("# historical rich document\n");
    expect(
      (await service.readFile(repository, featureTip, "feature.txt")).contents,
    ).toBe("feature without final newline");
    await expect(
      service.readFile(repository, featureTip, "-dash.ts"),
    ).rejects.toMatchObject({ kind: "missing" });
    await expect(
      service.readFile(repository, featureTip, "link"),
    ).rejects.toMatchObject({ kind: "unsupported" });
    await expect(
      service.readFile(repository, featureTip, "binary"),
    ).rejects.toMatchObject({ kind: "unsupported" });
    await expect(
      service.readFile(repository, root, "../escape"),
    ).rejects.toMatchObject({ kind: "invalid" });
  });

  test("all reads preserve checkout, index bytes, staged and dirty files", async () => {
    const snapshot = () => [
      git(main, ["status", "--porcelain=v1", "-z"]),
      git(feature, ["status", "--porcelain=v1", "-z"]),
      readFileSync(join(main, ".git/index")).toString("base64"),
      git(feature, ["rev-parse", "HEAD"]),
      git(main, ["rev-parse", "HEAD"]),
      readFileSync(join(main, "dirty.txt"), "utf8"),
      readFileSync(join(feature, "untracked.txt"), "utf8"),
    ];
    const before = snapshot();
    const discovery = await service.discover("project", main);
    const matches = await service.containingWorktrees(
      repository,
      featureTip,
      discovery.worktrees,
    );
    expect(matches.map((x) => x.path)).toEqual(
      expect.arrayContaining([main, feature]),
    );
    expect(matches.map((x) => x.path)).not.toContain(stale);
    await service.patch(await service.pinCommit(repository, featureTip));
    await service.readFile(repository, root, "unchanged.md");
    expect(snapshot()).toEqual(before);
  });

  test("discovery is coalesced and refresh invalidates mutable data", async () => {
    let now = 0;
    const spy = jest.fn(execute);
    const reader = new GitReadService(spy, () => now);
    const one = reader.discover("project", main);
    expect(reader.discover("project", main)).toBe(one);
    await one;
    const count = spy.mock.calls.length;
    await reader.discover("project", main);
    expect(spy).toHaveBeenCalledTimes(count);
    now = 30_001;
    await reader.discover("project", main);
    expect(spy).toHaveBeenCalledTimes(count * 2);
    reader.invalidateDiscovery("project");
    await reader.discover("project", main);
    expect(spy).toHaveBeenCalledTimes(count * 3);
  });

  test("immutable blobs are cached and evicted by bytes", async () => {
    const spy = jest.fn(execute);
    const reader = new GitReadService(spy, Date.now, 45);
    await reader.readFile(repository, root, "unchanged.md");
    await reader.readFile(repository, root, "unchanged.md");
    const reads = () =>
      spy.mock.calls.filter(([o]) => o.args?.includes("blob")).length;
    expect(reads()).toBe(1);
    await reader.readFile(repository, featureTip, "feature.txt");
    await reader.readFile(repository, root, "unchanged.md");
    expect(reads()).toBe(3);
  });
});

test("SHA-256 repositories are supported without truncating object IDs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-git-sha256-"));
  try {
    git(dir, ["init", "--object-format=sha256", "-b", "main"]);
    writeFileSync(join(dir, "a"), "hello\n");
    git(dir, ["add", "a"]);
    git(dir, ["commit", "-m", "root"]);
    const reader = new GitReadService(execute);
    const { repository } = await reader.discover("project", dir);
    expect(repository.objectFormat).toBe("sha256");
    const target = await reader.pinCommit(repository, "HEAD");
    expect(target.commit).toHaveLength(64);
    expect((await reader.changedFiles(target))[0].newObject).toHaveLength(64);
    expect(
      (await reader.readFile(repository, target.commit, "a")).contents,
    ).toBe("hello\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("truncation and transport failures cannot be mistaken for empty successful reads", async () => {
  const oversized = new GitReadService(async () => ({
    exit_code: 0,
    stdout: "x".repeat(GIT_READ_LIMIT) + " (truncated)",
  }));
  await expect(oversized.discover("p", "/r")).rejects.toMatchObject({
    kind: "incomplete",
  });
  const failed = new GitReadService(async () => {
    throw Error("offline");
  });
  await expect(failed.discover("p", "/r")).rejects.toMatchObject({
    kind: "transport",
  });
  expect(() => parseWorktrees("worktree /r\0")).toThrow();
  expect(() => parseRefs("refs/heads/a\0")).toThrow();
  expect(() => parseHistory("abc")).toThrow();
  expect(() => parseRawDiff(":100644")).toThrow();
});

test("generation rejects late successes and errors on target switch or close", () => {
  const requests = new ReviewRequestGeneration();
  const first = requests.next();
  expect(requests.isCurrent(first)).toBe(true);
  requests.next();
  expect(requests.isCurrent(first)).toBe(false);
});

test("concurrent callers share a four-command execution bound", async () => {
  let active = 0;
  let peak = 0;
  const reader = new GitReadService(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return { stdout: "a".repeat(40) + "\n", exit_code: 0 };
  });
  const repository: RepositoryContext = {
    projectId: "p",
    commonDirectory: "/r/.git",
    locator: "/r",
    objectFormat: "sha1",
  };
  await Promise.all(
    Array.from({ length: 12 }, () => reader.resolveCommit(repository, "HEAD")),
  );
  expect(peak).toBe(4);
  expect(active).toBe(0);
});
