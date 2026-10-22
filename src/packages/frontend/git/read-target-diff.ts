import type { ImmutableReviewTarget } from "@cocalc/frontend/components/diff-viewer/review-model";
import {
  MAX_GIT_SHOW_LINES,
  parseGitShowOutput,
} from "@cocalc/frontend/chat/git-commit/git-output";
import type { GitReadService } from "./read-service";
import { GitReadError } from "./read-service";

/** Immutable diff bytes and source identities from exactly the same pinned trees. */
export async function readTargetDiff(
  reader: Pick<GitReadService, "changedFiles" | "patch" | "commitSummary">,
  target: ImmutableReviewTarget,
  context: number,
) {
  const metadata = await reader.changedFiles(target);
  const fullPatch = await reader.patch(target, context, Infinity);
  const summary =
    target.kind === "commit"
      ? await reader.commitSummary(target.repository, target.commit)
      : `    ${target.mode === "merge-base" ? "Branch contribution" : "Two-tree comparison"}\n    ${target.base} -> ${target.head}\n`;
  // Files are shown whole while they fit; the rest keep only their header
  // and say how large they are, so a big comparison never shows nothing.
  const { patch, omitted } = budgetPatch(
    fullPatch,
    MAX_GIT_SHOW_LINES - summary.split("\n").length - 16,
  );
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
      ...(omitted[index] ? { omittedLines: omitted[index] } : {}),
    };
  });
  return parsed;
}

/**
 * Keep each file's patch whole while the running total fits `budget` lines;
 * a file that does not fit keeps only its header (through `+++`), which still
 * parses as that one file with no hunks. `omitted[i]` is file i's patch
 * length when its body was left out.
 */
export function budgetPatch(
  patch: string,
  budget: number,
): { patch: string; omitted: number[] } {
  const lines = patch.split("\n");
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (line.startsWith("diff --git ")) starts.push(index);
  });
  if (lines.length <= budget || starts.length === 0)
    return { patch, omitted: [] };
  const out = lines.slice(0, starts[0]);
  const omitted: number[] = [];
  let used = out.length;
  starts.forEach((start, i) => {
    const section = lines.slice(start, starts[i + 1] ?? lines.length);
    if (used + section.length <= budget) {
      out.push(...section);
      used += section.length;
      return;
    }
    const body = section.findIndex(
      (line, j) =>
        j > 0 &&
        (line.startsWith("@@") ||
          line.startsWith("Binary files ") ||
          line === "GIT binary patch"),
    );
    const header = body < 0 ? section : section.slice(0, body);
    out.push(...header);
    used += header.length;
    omitted[i] = section.length;
  });
  return { patch: out.join("\n"), omitted };
}
