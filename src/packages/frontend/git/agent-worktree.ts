import type { RepositoryContext } from "@cocalc/frontend/components/diff-viewer/review-model";
import type { GitReadService } from "./read-service";

export async function dispatchWorktreeFeedback({
  validate,
  isCurrent,
  send,
  prompt,
  title,
}: {
  validate: () => Promise<Awaited<ReturnType<typeof validateAgentWorktree>>>;
  isCurrent: () => boolean;
  send: (
    prompt: string,
    options: { workingDirectory: string; title?: string },
  ) => void | Promise<void>;
  prompt: string;
  title?: string;
}) {
  const assertCurrent = () => {
    if (!isCurrent())
      throw Error(
        "Review context changed before submission. Send feedback again from the intended worktree.",
      );
  };
  assertCurrent();
  const context = await validate();
  assertCurrent();
  await send(
    prompt +
      "\n\nValidated review execution context:\n" +
      JSON.stringify(context, null, 2) +
      "\nBefore editing, verify this repository, working directory, branch, and HEAD still match. Stop on mismatch; do not checkout or switch branches.",
    { title, workingDirectory: context.workingDirectory },
  );
}

export async function validateAgentWorktree(
  reader: GitReadService,
  repository: RepositoryContext,
  worktree: string,
  expectedHead: string,
  reviewedCommit: string,
  expectedBranch?: string,
) {
  reader.invalidateDiscovery(repository.projectId);
  const origin = await reader.discover(
    repository.projectId,
    repository.locator,
  );
  if (origin.repository.commonDirectory !== repository.commonDirectory)
    throw Error("Review repository changed. Refresh before sending feedback.");
  const registered = origin.worktrees.find((tree) => tree.path === worktree);
  if (!registered || registered.bare || registered.prunable != null)
    throw Error("The selected worktree is no longer available for edits.");
  const selected = await reader.discover(repository.projectId, worktree);
  if (selected.repository.commonDirectory !== repository.commonDirectory)
    throw Error("Selected worktree now belongs to a different repository.");
  const current = selected.worktrees.find((tree) => tree.path === worktree);
  if (!current || current.branch !== expectedBranch)
    throw Error(
      "The selected worktree branch changed. Refresh before sending feedback.",
    );
  const head = await reader.resolveCommit(selected.repository, "HEAD");
  if (head !== expectedHead)
    throw Error(
      "The selected worktree HEAD changed or does not match the selected history. Refresh and select its checked-out history before sending feedback.",
    );
  const commit = await reader.resolveCommit(
    selected.repository,
    reviewedCommit,
  );
  const matches = await reader.containingWorktrees(
    selected.repository,
    commit,
    [{ ...registered, head }],
  );
  if (matches.length !== 1)
    throw Error(
      "The reviewed commit is not contained in this worktree's HEAD. Choose a matching working copy.",
    );
  reader.invalidateDiscovery(repository.projectId);
  const final = await reader.discover(repository.projectId, worktree);
  const finalTree = final.worktrees.find((tree) => tree.path === worktree);
  if (
    final.repository.commonDirectory !== repository.commonDirectory ||
    !finalTree ||
    finalTree.prunable != null ||
    finalTree.bare ||
    finalTree.head !== head ||
    finalTree.branch !== expectedBranch
  )
    throw Error(
      "The working copy changed during validation. Refresh before sending feedback.",
    );
  return {
    projectId: repository.projectId,
    commonDirectory: repository.commonDirectory,
    workingDirectory: worktree,
    expectedBranch,
    expectedHead: head,
    reviewedCommit: commit,
  };
}
