import { WorktreeStatus } from "./worktree-status";
import type { WorktreeNotice } from "./worktree-status";

export function GitReviewTitle({
  subject,
  worktreeNotice,
}: {
  subject?: string;
  worktreeNotice?: WorktreeNotice;
}) {
  const title = subject?.trim().split("\n")[0];
  return (
    <span className="git-review-title">
      <span>Git review</span>
      {title && (
        <strong className="git-review-title-subject" title={title}>
          {title}
        </strong>
      )}
      <WorktreeStatus notice={worktreeNotice} />
    </span>
  );
}
