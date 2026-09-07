import type { RepositoryDiscovery, GitReadService } from "./read-service";
import { GitReadError } from "./read-service";

export interface GitHistorySelection {
  worktree: string;
  ref: string;
  firstParent: boolean;
}

/** Validate a registered locator before replacing the visible history context. */
export async function resolveHistorySelection(
  reader: GitReadService,
  origin: RepositoryDiscovery,
  selection: GitHistorySelection,
) {
  const { projectId, commonDirectory } = origin.repository;
  reader.invalidateDiscovery(projectId);
  const fresh = await reader.discover(projectId, origin.repository.locator);
  const registered = fresh.worktrees.find(
    (tree) => tree.path === selection.worktree,
  );
  if (!registered || registered.prunable != null)
    throw new GitReadError(
      "missing",
      "The selected worktree is no longer available. Refresh worktrees.",
    );
  const selected = await reader.discover(projectId, selection.worktree);
  if (selected.repository.commonDirectory !== commonDirectory)
    throw new GitReadError(
      "invalid",
      "The selected path no longer belongs to this repository.",
    );
  const tip = await reader.resolveCommit(
    selected.repository,
    selection.ref || "HEAD",
  );
  return { discovery: selected, tip };
}
