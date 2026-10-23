/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ExecuteCodeOptions } from "@cocalc/util/types/execute-code";
import type {
  ImmutableReviewTarget,
  RepositoryContext,
  WorktreeContext,
} from "../components/diff-viewer/review-model";
import { repositoryKey } from "../components/diff-viewer/review-model";
import {
  isFullObjectId,
  parseHistory,
  parseRawDiff,
  parseRefs,
  parseWorktrees,
} from "./read-parsers";
import type { GitRef } from "./read-parsers";
import { MemoryGitCache, type ImmutableGitCache } from "./immutable-cache";

export const GIT_READ_LIMIT = 4_000_000;
const DISCOVERY_TTL = 30_000;
const MAX_PATCH_LINES = 20_000;
const MISSING_OBJECT =
  /Needed a single revision|unknown revision|bad object|not a valid object|bad revision/i;

type Failure =
  | "transport"
  | "git"
  | "incomplete"
  | "missing"
  | "unsupported"
  | "ambiguous"
  | "invalid";

export class GitReadError extends Error {
  constructor(
    public readonly kind: Failure,
    message: string,
  ) {
    super(message);
    this.name = "GitReadError";
  }
}

export type GitReadExecutor = (
  options: ExecuteCodeOptions & { project_id: string },
) => Promise<{
  stdout?: string;
  stderr?: string;
  exit_code?: number;
}>;

export interface RepositoryDiscovery {
  repository: RepositoryContext;
  worktrees: WorktreeContext[];
  refs: GitRef[];
}

function requireValue(value: string): void {
  if (!value || value.includes("\0"))
    throw new GitReadError("invalid", "Empty or NUL-containing Git argument");
}

function requireObject(value: string): void {
  if (!isFullObjectId(value))
    throw new GitReadError("invalid", "Expected a full Git object ID");
}

function requirePath(path: string): void {
  requireValue(path);
  if (
    path.startsWith("/") ||
    path.split("/").some((part) => part === ".." || part === "." || !part)
  ) {
    throw new GitReadError(
      "invalid",
      "Expected a repository-relative literal file path",
    );
  }
}

function outputLine(output: string): string {
  if (!output.endsWith("\n"))
    throw new GitReadError("incomplete", "Incomplete Git response");
  // Paths can end in whitespace, including a newline: remove only Git's terminator.
  return output.slice(0, -1);
}

// Bump when cached output would be read differently (new flags, parsing).
const IMMUTABLE_CACHE_VERSION = 1;

// The object ids that fully name a comparison.
function targetObjects(target: ImmutableReviewTarget): string[] {
  return target.kind === "commit"
    ? [target.commit, ...(target.parent ? [target.parent] : [])]
    : [target.base, target.head];
}

/** Read-only facade over the existing authorized project-host exec route. */
export class GitReadService {
  private active = 0;
  private waiters: Array<() => void> = [];
  private discoveries = new Map<
    string,
    { expires: number; promise: Promise<RepositoryDiscovery> }
  >();
  private blobs = new Map<string, { contents: string; bytes: number }>();
  private blobBytes = 0;
  private blobRequests = new Map<string, Promise<string>>();

  private readonly recent: MemoryGitCache;
  private immutableRequests = new Map<string, Promise<string>>();
  private shallowChecks = new Map<
    string,
    { expires: number; promise: Promise<boolean> }
  >();

  constructor(
    private readonly exec: GitReadExecutor,
    private readonly now: () => number = Date.now,
    private readonly cacheBytes = 16_000_000,
    /** Output that never changes, kept across reloads (IndexedDB). */
    private readonly persistent?: ImmutableGitCache,
  ) {
    this.recent = new MemoryGitCache(cacheBytes);
  }

  /**
   * A read named only by full object ids: its output never changes, so it
   * is answered from the caches when it can (this tab's, then this
   * browser's) and stored after it runs. Anything else runs every time.
   *
   * `walksHistory`: the output depends on the commits' parents (history,
   * ranges, parents). In a shallow clone a boundary commit looks parentless
   * until it is deepened, so such a read is stored only if the clone is not
   * shallow just before it runs and just after.
   */
  private async runImmutable(
    repository: RepositoryContext,
    args: string[],
    objectIds: string[],
    { walksHistory = false }: { walksHistory?: boolean } = {},
  ): Promise<string> {
    if (!objectIds.length || !objectIds.every(isFullObjectId))
      return this.run(repository.projectId, repository.locator, args);
    const key = JSON.stringify([
      IMMUTABLE_CACHE_VERSION,
      repositoryKey(repository),
      args,
    ]);
    const recent = await this.recent.get(key);
    if (recent !== undefined) return recent;
    const pending = this.immutableRequests.get(key);
    if (pending) return pending;
    const promise = (async () => {
      // Only complete results are stored, so a stored one is still right.
      const stored = await this.persistent?.get(key);
      if (stored !== undefined) {
        await this.recent.set(key, stored);
        return stored;
      }
      if (walksHistory && (await this.isShallow(repository)))
        return this.run(repository.projectId, repository.locator, args);
      const output = await this.run(
        repository.projectId,
        repository.locator,
        args,
      );
      // It may have been read while the clone was shallow.
      if (walksHistory && (await this.isShallow(repository, true)))
        return output;
      await this.recent.set(key, output);
      void this.persistent?.set(key, output);
      return output;
    })().finally(() => this.immutableRequests.delete(key));
    this.immutableRequests.set(key, promise);
    return promise;
  }

  private isShallow(
    repository: RepositoryContext,
    fresh = false,
  ): Promise<boolean> {
    const key = repositoryKey(repository);
    const cached = this.shallowChecks.get(key);
    if (!fresh && cached && cached.expires > this.now()) return cached.promise;
    const entry = {
      expires: this.now() + DISCOVERY_TTL,
      promise: this.run(repository.projectId, repository.locator, [
        "rev-parse",
        "--is-shallow-repository",
      ]).then((output) => outputLine(output) !== "false"),
    };
    this.shallowChecks.delete(key);
    this.shallowChecks.set(key, entry);
    if (this.shallowChecks.size > 64)
      this.shallowChecks.delete(this.shallowChecks.keys().next().value!);
    void entry.promise.catch(() => {
      if (this.shallowChecks.get(key) === entry) this.shallowChecks.delete(key);
    });
    return entry.promise;
  }

  private async run(
    projectId: string,
    cwd: string,
    args: string[],
    allowed = [0],
  ): Promise<string> {
    requireValue(projectId);
    requireValue(cwd);
    for (const arg of args)
      if (arg.includes("\0"))
        throw new GitReadError("invalid", "NUL-containing Git argument");
    if (this.active >= 4)
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    else this.active++;
    try {
      const response = await this.exec({
        project_id: projectId,
        path: cwd,
        command: "git",
        args: [
          "--no-pager",
          "--no-optional-locks",
          "--no-replace-objects",
          "--literal-pathspecs",
          "-c",
          "core.quotePath=false",
          "-c",
          "core.warnAmbiguousRefs=true",
          ...args,
        ],
        bash: false,
        err_on_exit: false,
        timeout: 60,
        max_output: GIT_READ_LIMIT,
        env: { LC_ALL: "C" },
      });
      const stdout = response.stdout ?? "";
      const stderr = response.stderr ?? "";
      // Exec limits characters and appends a diagnostic. A byte check also
      // bounds UTF-8 data retained in our caches and immutable source viewers.
      if (
        [stdout, stderr].some(
          (s) =>
            s.length >= GIT_READ_LIMIT ||
            new TextEncoder().encode(s).length >= GIT_READ_LIMIT,
        )
      ) {
        throw new GitReadError(
          "incomplete",
          "Git output exceeds the review limit; narrow the target",
        );
      }
      if (/ambiguous/i.test(stderr))
        throw new GitReadError("ambiguous", stderr);
      if (!allowed.includes(response.exit_code ?? -1))
        throw new GitReadError("git", stderr || "Git read failed");
      return stdout;
    } catch (err) {
      if (err instanceof GitReadError) throw err;
      throw new GitReadError(
        "transport",
        `Unable to read project Git data: ${err}`,
      );
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }

  invalidateDiscovery(projectId: string): void {
    for (const key of this.discoveries.keys()) {
      if (JSON.parse(key)[0] === projectId) this.discoveries.delete(key);
    }
  }

  discover(projectId: string, cwd: string): Promise<RepositoryDiscovery> {
    const key = JSON.stringify([projectId, cwd]);
    const cached = this.discoveries.get(key);
    if (cached && cached.expires > this.now()) return cached.promise;
    const entry = {
      expires: this.now() + DISCOVERY_TTL,
      promise: this.loadDiscovery(projectId, cwd),
    };
    this.discoveries.delete(key);
    this.discoveries.set(key, entry);
    // Bound idle metadata even when users browse many unrelated repositories.
    if (this.discoveries.size > 64)
      this.discoveries.delete(this.discoveries.keys().next().value!);
    void entry.promise.catch(() => {
      if (this.discoveries.get(key) === entry) this.discoveries.delete(key);
    });
    return entry.promise;
  }

  private async loadDiscovery(
    projectId: string,
    cwd: string,
  ): Promise<RepositoryDiscovery> {
    const bare =
      outputLine(
        await this.run(projectId, cwd, ["rev-parse", "--is-bare-repository"]),
      ) === "true";
    const locator = outputLine(
      await this.run(projectId, cwd, [
        "rev-parse",
        "--path-format=absolute",
        bare ? "--absolute-git-dir" : "--show-toplevel",
      ]),
    );
    const commonDirectory = outputLine(
      await this.run(projectId, locator, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
    );
    const objectFormat = outputLine(
      await this.run(projectId, locator, ["rev-parse", "--show-object-format"]),
    );
    if (objectFormat !== "sha1" && objectFormat !== "sha256")
      throw new GitReadError(
        "unsupported",
        `Unsupported Git object format: ${objectFormat}`,
      );
    const worktrees = parseWorktrees(
      await this.run(projectId, locator, [
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ]),
    );
    const refs = parseRefs(
      await this.run(projectId, locator, [
        "for-each-ref",
        "--format=%(refname)%00%(objectname)%00%(symref)%00",
        "refs/heads/",
        "refs/remotes/",
        "refs/tags/",
      ]),
    );
    return {
      repository: { projectId, commonDirectory, locator, objectFormat },
      worktrees,
      refs,
    };
  }

  async resolveCommit(
    repository: RepositoryContext,
    ref: string,
  ): Promise<string> {
    requireValue(ref);
    let output: string;
    try {
      output = await this.runImmutable(
        repository,
        ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
        // A full id names one object for good; a branch or short id does not.
        [ref],
      );
    } catch (err) {
      // Git's words for an object this clone doesn't have, e.g. a commit
      // made on GitHub that was never fetched here.
      if (
        err instanceof GitReadError &&
        err.kind === "git" &&
        // Only an object id names a commit that could be fetched.
        /^[0-9a-f]{4,64}$/i.test(ref) &&
        MISSING_OBJECT.test(err.message)
      )
        throw new GitReadError(
          "missing",
          `Commit ${ref} isn't in this clone (${repository.locator}). Fetch it from origin, or open it from a clone that has it.`,
        );
      throw err;
    }
    const commit = outputLine(output);
    requireObject(commit);
    return commit;
  }

  async pinCommit(
    repository: RepositoryContext,
    ref: string,
    parentIndex = 0,
  ): Promise<Extract<ImmutableReviewTarget, { kind: "commit" }>> {
    const commit = await this.resolveCommit(repository, ref);
    const [, ...parents] = outputLine(
      await this.runImmutable(
        repository,
        ["rev-list", "--parents", "-n1", commit, "--"],
        [commit],
        { walksHistory: true },
      ),
    ).split(" ");
    if (
      !Number.isInteger(parentIndex) ||
      parentIndex < 0 ||
      (parents.length ? parentIndex >= parents.length : parentIndex !== 0)
    ) {
      throw new GitReadError("invalid", "Selected merge parent does not exist");
    }
    return {
      kind: "commit",
      repository,
      commit,
      parent: parents[parentIndex] ?? null,
      parentIndex,
      label: ref,
    };
  }

  async commitSummary(
    repository: RepositoryContext,
    commit: string,
  ): Promise<string> {
    requireObject(commit);
    return this.runImmutable(
      repository,
      [
        "show",
        "--no-patch",
        "--no-color",
        "--format=fuller",
        // Output that would otherwise follow files and settings that change
        // (.mailmap, notes, log.date, log.showSignature, the log encoding).
        "--no-use-mailmap",
        "--no-notes",
        "--no-show-signature",
        "--date=default",
        "--encoding=UTF-8",
        commit,
        "--",
      ],
      [commit],
      // A merge's parents are in its header.
      { walksHistory: true },
    );
  }

  async compare(
    repository: RepositoryContext,
    baseRef: string,
    headRef: string,
    mode: "trees" | "merge-base",
  ): Promise<Extract<ImmutableReviewTarget, { kind: "comparison" }>> {
    const requestedBase = await this.resolveCommit(repository, baseRef);
    const head = await this.resolveCommit(repository, headRef);
    let base = requestedBase;
    if (mode === "merge-base") {
      const result = await this.run(
        repository.projectId,
        repository.locator,
        ["merge-base", "--all", base, head],
        [0, 1],
      );
      const bases = result.trim().split("\n").filter(Boolean);
      if (bases.length !== 1)
        throw new GitReadError(
          "ambiguous",
          "No unique merge base; select an explicit two-tree comparison",
        );
      base = bases[0];
      requireObject(base);
    }
    return {
      kind: "comparison",
      repository,
      mode,
      base,
      head,
      requestedBase,
      baseLabel: baseRef,
      headLabel: headRef,
    };
  }

  async history(
    repository: RepositoryContext,
    commit: string,
    {
      skip = 0,
      count = 100,
      firstParent = false,
      showMerges = true,
    }: {
      skip?: number;
      count?: number;
      firstParent?: boolean;
      showMerges?: boolean;
    } = {},
  ) {
    requireObject(commit);
    if (
      !Number.isSafeInteger(skip) ||
      skip < 0 ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 500
    )
      throw new GitReadError("invalid", "Invalid history page");
    return parseHistory(
      await this.runImmutable(
        repository,
        [
          "log",
          "-z",
          "--format=%H%x00%P%x00%ct%x00%s",
          `--skip=${skip}`,
          `-n${count}`,
          ...(firstParent ? ["--first-parent"] : []),
          ...(showMerges ? [] : ["--no-merges"]),
          commit,
          "--",
        ],
        [commit],
        { walksHistory: true },
      ),
    );
  }

  // Commits a comparison introduces (reachable from head, not from base),
  // newest first; undefined when there are more than `limit`.
  async rangeCommits(
    target: Extract<ImmutableReviewTarget, { kind: "comparison" }>,
    limit = 500,
  ): Promise<string[] | undefined> {
    requireObject(target.base);
    requireObject(target.head);
    const commits = (
      await this.runImmutable(
        target.repository,
        [
          "rev-list",
          `--max-count=${limit + 1}`,
          target.head,
          `^${target.base}`,
          "--",
        ],
        [target.head, target.base],
        { walksHistory: true },
      )
    )
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return commits.length > limit ? undefined : commits;
  }

  private comparisonArgs(
    target: ImmutableReviewTarget,
    flags: string[],
  ): string[] {
    if (target.kind === "commit") {
      requireObject(target.commit);
      if (target.parent === null)
        return [
          "diff-tree",
          "--root",
          "--no-commit-id",
          "-r",
          ...flags,
          target.commit,
          "--",
        ];
      requireObject(target.parent);
      return ["diff", ...flags, target.parent, target.commit, "--"];
    }
    requireObject(target.base);
    requireObject(target.head);
    return ["diff", ...flags, target.base, target.head, "--"];
  }

  async changedFiles(target: ImmutableReviewTarget) {
    const { repository } = target;
    const files = parseRawDiff(
      await this.runImmutable(
        repository,
        this.comparisonArgs(target, [
          "--raw",
          "-z",
          "--no-abbrev",
          "--no-ext-diff",
          "--no-textconv",
          "--find-renames",
        ]),
        targetObjects(target),
      ),
    );
    const oldCommit = target.kind === "commit" ? target.parent : target.base;
    const newCommit = target.kind === "commit" ? target.commit : target.head;
    return files.map((file) => ({
      ...file,
      oldSource:
        file.oldPath != null && oldCommit != null
          ? {
              kind: "git" as const,
              repository,
              commit: oldCommit,
              path: file.oldPath,
              blob: file.oldObject,
            }
          : undefined,
      newSource:
        file.newPath != null
          ? {
              kind: "git" as const,
              repository,
              commit: newCommit,
              path: file.newPath,
              blob: file.newObject,
            }
          : undefined,
    }));
  }

  /**
   * The comparison's patch. Over `maxLines` it is refused; a reader that
   * budgets per file (readTargetDiff) passes Infinity and is bounded by the
   * output limit instead.
   */
  async patch(
    target: ImmutableReviewTarget,
    context = 3,
    maxLines = MAX_PATCH_LINES,
  ): Promise<string> {
    if (!Number.isInteger(context) || context < 0 || context > 1000)
      throw new GitReadError("invalid", "Invalid diff context");
    const { repository } = target;
    const patch = await this.runImmutable(
      repository,
      this.comparisonArgs(target, [
        "--patch",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        `-U${context}`,
      ]),
      targetObjects(target),
    );
    if (patch.split("\n").length > maxLines)
      throw new GitReadError(
        "incomplete",
        `Diff exceeds ${maxLines.toLocaleString("en-US")} lines; narrow the comparison`,
      );
    return patch;
  }

  async readFile(
    repository: RepositoryContext,
    commit: string,
    path: string,
  ): Promise<{ contents: string; blob: string; mode: string }> {
    requireObject(commit);
    requirePath(path);
    const output = await this.run(repository.projectId, repository.locator, [
      "ls-tree",
      "-z",
      "--full-tree",
      commit,
      "--",
      path,
    ]);
    if (!output)
      throw new GitReadError(
        "missing",
        `File is absent at revision ${commit}: ${path}`,
      );
    const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]+)\t([^\0]*)\0$/.exec(
      output,
    );
    if (!match || match[4] !== path)
      throw new GitReadError("incomplete", "Unexpected Git tree entry");
    const [, mode, type, blob] = match;
    if (type !== "blob")
      throw new GitReadError(
        "unsupported",
        "Trees and submodules are not text files",
      );
    if (mode === "120000")
      throw new GitReadError(
        "unsupported",
        "Historical symlink; not following its target",
      );
    const contents = await this.readBlob(repository, blob);
    return { contents, blob, mode };
  }

  private readBlob(
    repository: RepositoryContext,
    blob: string,
  ): Promise<string> {
    requireObject(blob);
    const key = JSON.stringify([repositoryKey(repository), blob]);
    const cached = this.blobs.get(key);
    if (cached) {
      this.blobs.delete(key);
      this.blobs.set(key, cached);
      return Promise.resolve(cached.contents);
    }
    const pending = this.blobRequests.get(key);
    if (pending) return pending;
    const promise = this.loadBlob(repository, blob)
      .then((contents) => {
        const bytes = new TextEncoder().encode(contents).length;
        if (bytes <= this.cacheBytes) {
          while (this.blobs.size && this.blobBytes + bytes > this.cacheBytes) {
            const oldest = this.blobs.keys().next().value!;
            this.blobBytes -= this.blobs.get(oldest)!.bytes;
            this.blobs.delete(oldest);
          }
          this.blobs.set(key, { contents, bytes });
          this.blobBytes += bytes;
        }
        return contents;
      })
      .finally(() => this.blobRequests.delete(key));
    this.blobRequests.set(key, promise);
    return promise;
  }

  private async loadBlob(
    repository: RepositoryContext,
    blob: string,
  ): Promise<string> {
    const size = outputLine(
      await this.runImmutable(repository, ["cat-file", "-s", blob], [blob]),
    );
    if (!/^\d+$/.test(size) || Number(size) >= GIT_READ_LIMIT)
      throw new GitReadError(
        "incomplete",
        "Historical file exceeds the review limit",
      );
    const contents = await this.runImmutable(
      repository,
      ["cat-file", "blob", blob],
      [blob],
    );
    // Exec is a UTF-8 text transport. Reject binary/invalid UTF-8 rather than
    // silently treating transcoded bytes as the exact historical document.
    if (
      contents.includes("\0") ||
      contents.includes("\ufffd") ||
      new TextEncoder().encode(contents).length !== Number(size)
    )
      throw new GitReadError(
        "unsupported",
        "Historical file is not supported UTF-8 text",
      );
    return contents;
  }

  async containingWorktrees(
    repository: RepositoryContext,
    commit: string,
    worktrees: WorktreeContext[],
  ): Promise<WorktreeContext[]> {
    requireObject(commit);
    const result: WorktreeContext[] = [];
    for (const worktree of worktrees) {
      if (
        !worktree.head ||
        !isFullObjectId(worktree.head) ||
        worktree.bare ||
        worktree.prunable != null
      )
        continue;
      // Compare object ancestry in the known repository, not by opening every
      // worktree. Revalidate the selected path separately before any write.
      const common = await this.run(
        repository.projectId,
        repository.locator,
        ["merge-base", commit, worktree.head],
        [0, 1],
      );
      if (common.trim() === commit) result.push(worktree);
    }
    return result;
  }
}
