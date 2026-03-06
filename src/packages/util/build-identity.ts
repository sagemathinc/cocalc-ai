/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL -- see LICENSE.md for details
 */

export interface BuildIdentity {
  build_id: string;
  built_at: string;
  git_commit?: string;
  git_commit_short?: string;
  git_dirty: boolean;
  git_diff_hash?: string;
  package_version?: string;
  artifact_kind?: string;
}

export interface BuildIdentityInput {
  builtAt?: Date | string | number;
  gitCommit?: string | null;
  gitDirty?: boolean;
  gitDiffHash?: string | null;
  packageVersion?: string | null;
  artifactKind?: string | null;
}

export function compactBuildTimestamp(input?: Date | string | number): string {
  const date =
    input instanceof Date
      ? input
      : input == null
        ? new Date()
        : new Date(input);
  const iso = date.toISOString();
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function shortGitCommit(commit?: string | null, length = 12): string | undefined {
  const normalized = `${commit ?? ""}`.trim().toLowerCase();
  if (!normalized) return;
  return normalized.slice(0, Math.max(4, length));
}

export function normalizeHashFragment(value?: string | null, length = 8): string | undefined {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  if (!normalized) return;
  return normalized.replace(/[^a-z0-9]/g, "").slice(0, Math.max(4, length)) || undefined;
}

export function makeBuildId(opts: BuildIdentityInput = {}): string {
  const timestamp = compactBuildTimestamp(opts.builtAt);
  const commit = shortGitCommit(opts.gitCommit) ?? "nogit";
  const dirty = !!opts.gitDirty;
  const dirtyHash = dirty ? normalizeHashFragment(opts.gitDiffHash) : undefined;
  const parts = [timestamp, commit];
  if (dirty) {
    parts.push("dirty");
    if (dirtyHash) {
      parts.push(dirtyHash);
    }
  }
  return parts.join("-");
}

export function createBuildIdentity(opts: BuildIdentityInput = {}): BuildIdentity {
  const built_at =
    opts.builtAt instanceof Date
      ? opts.builtAt.toISOString()
      : opts.builtAt == null
        ? new Date().toISOString()
        : new Date(opts.builtAt).toISOString();
  const git_commit = `${opts.gitCommit ?? ""}`.trim() || undefined;
  const git_commit_short = shortGitCommit(git_commit);
  const git_diff_hash = normalizeHashFragment(opts.gitDiffHash);
  const package_version = `${opts.packageVersion ?? ""}`.trim() || undefined;
  const artifact_kind = `${opts.artifactKind ?? ""}`.trim() || undefined;
  return {
    build_id: makeBuildId(opts),
    built_at,
    git_commit,
    git_commit_short,
    git_dirty: !!opts.gitDirty,
    git_diff_hash,
    package_version,
    artifact_kind,
  };
}
