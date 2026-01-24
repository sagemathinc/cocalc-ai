import { Path } from "slate";
import type { SlateEditor } from "./types";

/**
 * Gap cursor support: represent a caret between block nodes without
 * inserting placeholder paragraphs. This is inspired by ProseMirror's
 * gap cursor plugin, which solves "cursor stuck between blocks".
 */
export type GapCursor = {
  path: Path;
  side: "before" | "after";
};

export function getGapCursor(editor: SlateEditor): GapCursor | null {
  return (editor as any).gapCursor ?? null;
}

export function setGapCursor(
  editor: SlateEditor,
  gapCursor: GapCursor | null,
): void {
  (editor as any).gapCursor = gapCursor;
}

export function clearGapCursor(editor: SlateEditor): void {
  setGapCursor(editor, null);
}

export function gapCursorMatches(
  editor: SlateEditor,
  path: Path,
  side: GapCursor["side"],
): boolean {
  const gap = getGapCursor(editor);
  if (!gap) return false;
  if (gap.side !== side) return false;
  return Path.equals(gap.path, path);
}
