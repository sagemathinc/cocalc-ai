import { Path, Transforms } from "slate";
import type { SlateEditor } from "./types";
import { emptyParagraph } from "./padding";
import { pointAtPath } from "./slate-util";

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
  (editor as any).gapCursorSetAt = gapCursor ? Date.now() : null;
  (editor as any).gapCursor = gapCursor;
  const bump = (editor as any).bumpGapCursor;
  if (typeof bump === "function") {
    bump();
  }
}

export function clearGapCursor(editor: SlateEditor): void {
  setGapCursor(editor, null);
}

export function insertParagraphAtGap(
  editor: SlateEditor,
  gapCursor: GapCursor,
): void {
  const index = gapCursor.side === "before" ? gapCursor.path[0] : gapCursor.path[0] + 1;
  const path: Path = [Math.max(0, index)];
  Transforms.insertNodes(editor, emptyParagraph(), { at: path });
  const focus = pointAtPath(editor, path, undefined, "start");
  Transforms.setSelection(editor, { anchor: focus, focus });
  clearGapCursor(editor);
}
