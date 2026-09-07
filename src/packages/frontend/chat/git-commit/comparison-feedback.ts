import type { ImmutableReviewTarget } from "@cocalc/frontend/components/diff-viewer/review-model";
import type { TargetReviewBody } from "../git-target-review-store";

export function comparisonFeedbackPrompt(
  target: ImmutableReviewTarget,
  body: TargetReviewBody,
): string {
  const comments = Object.values(body.comments).filter(
    (comment) => comment.status === "draft",
  );
  return [
    "Address this saved Git comparison review. Use the pinned revisions below, not the current branch's inferred diff. Do not change branches or commit changes unless separately requested.",
    "Review target:",
    JSON.stringify(target, null, 2),
    "Review note:",
    body.note,
    "Inline review comments (old/new refer to this comparison's sides):",
    JSON.stringify(comments, null, 2),
  ].join("\n\n");
}

export type RequestComparisonAgentTurn = (
  prompt: string,
  options?: { title?: string; workingDirectory?: string },
) => void | Promise<void>;
