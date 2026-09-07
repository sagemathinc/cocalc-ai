import type { LineDiffResult } from "@cocalc/util/line-diff";
import type { DiffPreviewSource } from "@cocalc/frontend/components/diff-viewer/preview-types";

export function activityDiffSource(
  diff: LineDiffResult,
  path: string,
): DiffPreviewSource {
  const source = diff.source;
  if (source?.kind === "observed-documents") {
    if (
      typeof source.before !== "string" ||
      typeof source.after !== "string" ||
      source.before.length + source.after.length > 4 * 1024 * 1024
    )
      throw Error("Invalid or oversized recorded documents.");
    return {
      kind: "documents",
      path,
      label: `${path}: recorded read/write observations (not a Git revision)`,
      before: source.before,
      after: source.after,
    };
  }
  if (!source || typeof source.text !== "string")
    throw Error("This older activity entry has no lossless patch source.");
  if (source.text.length > 4 * 1024 * 1024)
    throw Error("Activity patch exceeds 4 MB.");
  const label = `${path}: recorded activity change (not a Git revision)`;
  if (source.kind === "add" || source.kind === "delete") {
    return {
      kind: "documents",
      path,
      label,
      before: source.kind === "delete" ? source.text : "",
      after: source.kind === "add" ? source.text : "",
    };
  }
  if (source.kind !== "unified") throw Error("Unsupported activity source.");
  const lines = source.text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const body: string[] = [];
  let remainingOld = 0,
    remainingNew = 0,
    hunks = 0;
  let inHunk = false;
  let canMarkNewline = false;
  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      if (remainingOld || remainingNew)
        throw Error("Incomplete activity hunk.");
      remainingOld = Number(header[2] ?? 1);
      remainingNew = Number(header[4] ?? 1);
      if (
        ![
          Number(header[1]),
          Number(header[3]),
          remainingOld,
          remainingNew,
        ].every(Number.isSafeInteger)
      )
        throw Error("Invalid activity coordinates.");
      if (
        (remainingOld > 0 && Number(header[1]) === 0) ||
        (remainingNew > 0 && Number(header[3]) === 0)
      )
        throw Error("Invalid activity coordinates.");
      inHunk = true;
      canMarkNewline = false;
      hunks++;
      body.push(line);
      continue;
    }
    if (!inHunk) continue;
    if (line === "\\ No newline at end of file") {
      if (!canMarkNewline) throw Error("Invalid activity newline marker.");
      canMarkNewline = false;
      body.push(line);
      continue;
    }
    if (line[0] === " " || line[0] === "-") remainingOld--;
    if (line[0] === " " || line[0] === "+") remainingNew--;
    if (
      ![" ", "+", "-"].includes(line[0]) ||
      remainingOld < 0 ||
      remainingNew < 0
    )
      throw Error("Unsupported or incomplete activity patch.");
    body.push(line);
    canMarkNewline = true;
  }
  if (!hunks || remainingOld || remainingNew)
    throw Error("Incomplete activity patch.");
  // Use the event's literal path; never interpret patch labels as file-opening
  // instructions. Quoting prevents newlines in a filename from adding headers.
  const oldPath = JSON.stringify(`a/${path}`),
    newPath = JSON.stringify(`b/${path}`);
  return {
    kind: "patch",
    label,
    patch: `diff --git ${oldPath} ${newPath}\n--- ${oldPath}\n+++ ${newPath}\n${body.join("\n")}\n`,
  };
}
