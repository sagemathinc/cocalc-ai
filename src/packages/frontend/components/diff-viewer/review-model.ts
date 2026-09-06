/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Renderer-neutral identities. Locators and display labels are not review keys.
export interface RepositoryContext {
  projectId: string;
  commonDirectory: string;
  locator: string;
  objectFormat: "sha1" | "sha256";
}

export interface WorktreeContext {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked?: string;
  prunable?: string;
}

export type ReviewTarget =
  | {
      kind: "commit";
      repository: RepositoryContext;
      commit: string;
      parent: string | null;
      parentIndex: number;
      label?: string;
    }
  | {
      kind: "comparison";
      repository: RepositoryContext;
      mode: "trees" | "merge-base";
      base: string;
      head: string;
      requestedBase: string;
      baseLabel?: string;
      headLabel?: string;
    }
  | {
      kind: "working";
      repository: RepositoryContext;
      worktree: string;
      mode: "index" | "worktree" | "combined";
      generation: string;
      head: string | null;
    };

export type ImmutableReviewTarget = Exclude<ReviewTarget, { kind: "working" }>;
export type DiffSide = "old" | "new";

export interface GitSource {
  kind: "git";
  repository: RepositoryContext;
  commit: string;
  path: string;
  blob?: string;
}

export type HistoricalSource =
  | GitSource
  | {
      kind: "patchflow" | "snapshot" | "backup";
      projectId: string;
      path: string;
      version: string;
    };

export interface HistoricalLocation {
  source: HistoricalSource;
  line?: number;
  column?: number;
}

export interface DiffLocation {
  targetId: string;
  fileId: string;
  side: DiffSide;
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface DiffRow {
  kind: "context" | "addition" | "deletion";
  text: string;
  oldLine?: number;
  newLine?: number;
  oldNoFinalNewline?: boolean;
  newNoFinalNewline?: boolean;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  header: string;
  rows: DiffRow[];
}

export interface DiffFile {
  id: string;
  oldPath?: string;
  newPath?: string;
  oldSource?: HistoricalSource;
  newSource?: HistoricalSource;
  change: "add" | "delete" | "modify" | "rename" | "copy" | "type" | "unmerged";
  content: "text" | "binary" | "submodule" | "symlink" | "metadata" | "unknown";
  oldMode: string;
  newMode: string;
  oldObject: string;
  newObject: string;
  completeness: "complete" | "patch" | "truncated";
  hunks: DiffHunk[];
}

export interface DiffCapabilities {
  historicalContent: boolean;
  additionalContext: boolean;
  workingCopy: boolean;
  comments: boolean;
  mutations: boolean;
  unavailableReasons: Partial<
    Record<
      | "historicalContent"
      | "additionalContext"
      | "workingCopy"
      | "comments"
      | "mutations",
      string
    >
  >;
}

export interface DiffScrollAnchor {
  location: DiffLocation;
  offset: number;
}

export interface DiffViewAdapter {
  navigateToFile(fileId: string): void;
  navigateToLocation(location: DiffLocation): void;
  captureScrollAnchor(): DiffScrollAnchor | undefined;
  restoreScrollAnchor(anchor: DiffScrollAnchor): void;
  setSelection(location: DiffLocation | undefined): void;
  setSearchMatches(matches: DiffLocation[], active?: DiffLocation): void;
}

export function repositoryKey(repository: RepositoryContext): string {
  return JSON.stringify([repository.projectId, repository.commonDirectory]);
}

// This is a new target namespace, not a replacement for account-scoped V2 keys.
export function reviewTargetKey(target: ReviewTarget): string {
  const scope = ["git-review-target-v1", repositoryKey(target.repository)];
  switch (target.kind) {
    case "commit":
      return JSON.stringify([
        ...scope,
        target.kind,
        target.commit,
        target.parent,
        target.parentIndex,
      ]);
    case "comparison":
      return JSON.stringify([
        ...scope,
        target.kind,
        target.mode,
        target.requestedBase,
        target.base,
        target.head,
      ]);
    case "working":
      return JSON.stringify([
        ...scope,
        target.kind,
        target.worktree,
        target.mode,
        target.head,
        target.generation,
      ]);
  }
}

export function diffFileKey(oldPath?: string, newPath?: string): string {
  return JSON.stringify([oldPath ?? null, newPath ?? null]);
}

// Async callers issue once per target transition, including close. Failures must
// check the same generation as successes before updating view state.
export class ReviewRequestGeneration {
  private value = 0;

  next(): number {
    return ++this.value;
  }

  isCurrent(value: number): boolean {
    return value === this.value;
  }
}
