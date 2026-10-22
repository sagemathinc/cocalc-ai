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
 * Keep each file's patch whole while it fits `budget` lines with room left
 * for the header (through `+++`) of every later file; a file that does not
 * fit keeps only its header, which still parses as that one file with no
 * hunks. `omitted[i]` is file i's patch length when its body was left out.
 * Refuses when the headers alone do not fit: too many files to list.
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
  const sections = starts.map((start, i) =>
    lines.slice(start, starts[i + 1] ?? lines.length),
  );
  const headers = sections.map((section) => {
    const body = section.findIndex(
      (line, j) =>
        j > 0 &&
        (line.startsWith("@@") ||
          line.startsWith("Binary files ") ||
          line === "GIT binary patch"),
    );
    return body < 0 ? section : section.slice(0, body);
  });
  const out = lines.slice(0, starts[0]);
  // Header lines of the files after the current one: always kept.
  let reserved = headers.reduce((n, header) => n + header.length, 0);
  if (out.length + reserved > budget)
    throw new GitReadError(
      "unsupported",
      `This comparison changes ${sections.length} files, too many to list at once. Narrow the comparison.`,
    );
  const omitted: number[] = [];
  sections.forEach((section, i) => {
    reserved -= headers[i].length;
    if (out.length + section.length + reserved <= budget) {
      out.push(...section);
      return;
    }
    out.push(...headers[i]);
    omitted[i] = section.length;
  });
  return { patch: out.join("\n"), omitted };
}
