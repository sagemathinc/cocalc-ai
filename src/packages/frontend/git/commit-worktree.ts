import type { GitReadService, RepositoryDiscovery } from "./read-service";
import { resolveHistorySelection } from "./history-selection";

/** Containment suggests a checkout, not the branch where a commit originated. */
export async function locateCommitWorktree(
  reader: GitReadService,
  origin: RepositoryDiscovery,
  ref: string,
) {
  const { projectId, locator, commonDirectory } = origin.repository;
  reader.invalidateDiscovery(projectId);
  const fresh = await reader.discover(projectId, locator);
  if (fresh.repository.commonDirectory !== commonDirectory)
    throw Error("Repository changed during commit lookup");
  const commit = await reader.resolveCommit(fresh.repository, ref);
  const matches = await reader.containingWorktrees(
    fresh.repository,
    commit,
    fresh.worktrees,
  );
  if (matches.some((tree) => tree.path === locator))
    return { kind: "current" as const, commit };
  if (matches.length !== 1)
    return {
      kind: matches.length ? ("ambiguous" as const) : ("historical" as const),
      commit,
      paths: matches.map((tree) => tree.path),
    };
  const tree = matches[0];
  const selection = { worktree: tree.path, ref: tree.head!, firstParent: true };
  const selected = await resolveHistorySelection(reader, fresh, selection);
  const currentTree = selected.discovery.worktrees.find(
    (entry) => entry.path === tree.path,
  );
  if (
    !currentTree ||
    currentTree.head !== tree.head ||
    currentTree.prunable != null
  )
    throw Error(
      "Matching worktree changed during lookup; choose it explicitly after refreshing",
    );
  return { kind: "unique" as const, commit, selection, tip: selected.tip };
}
