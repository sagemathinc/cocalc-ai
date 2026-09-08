import type { ImmutableReviewTarget } from "@cocalc/frontend/components/diff-viewer/review-model";
import { parseGitShowOutput } from "@cocalc/frontend/chat/git-commit/git-output";
import type { GitReadService } from "./read-service";
import { GitReadError } from "./read-service";

/** Immutable diff bytes and source identities from exactly the same pinned trees. */
export async function readTargetDiff(
  reader: Pick<GitReadService, "changedFiles" | "patch" | "commitSummary">,
  target: ImmutableReviewTarget,
  context: number,
) {
  const metadata = await reader.changedFiles(target);
  const patch = await reader.patch(target, context);
  const summary =
    target.kind === "commit"
      ? await reader.commitSummary(target.repository, target.commit)
      : `    ${target.mode === "merge-base" ? "Branch contribution" : "Two-tree comparison"}\n    ${target.base} -> ${target.head}\n`;
  const parsed = parseGitShowOutput(
    `${summary}\n${patch}`,
    target.repository.locator,
  );
  if (parsed.linesTruncated || parsed.files.length !== metadata.length) {
    throw new GitReadError(
      "incomplete",
      "Diff metadata and patch contents do not agree; refusing a partial review",
    );
  }
  // Both commands compare the same immutable trees with identical ordering and
  // rename detection. Use NUL-delimited metadata, not human-facing quoted paths.
  parsed.files = parsed.files.map((file, index) => {
    const entry = metadata[index];
    return {
      ...file,
      path: entry.newPath ?? entry.oldPath!,
      oldSource: entry.oldSource,
      newSource: entry.newSource,
    };
  });
  return parsed;
}
