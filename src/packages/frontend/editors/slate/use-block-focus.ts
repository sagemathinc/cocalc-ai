/*
 * This hook handles focusing a specific block editor and mapping the current
 * Slate selection back to a markdown position. It centralizes focus behavior
 * and selection-to-markdown translation so other hooks can reuse it cleanly.
 */

import { useCallback } from "react";
import { Transforms } from "slate";
import { type VirtuosoHandle } from "react-virtuoso";
import { ReactEditor } from "./slate-react";
import type { SlateEditor } from "./types";
import { blockSelectionPoint } from "./block-selection-utils";
import { indexToPosition, nearestMarkdownIndexForSlatePoint } from "./sync";
import { globalIndexForBlockOffset, joinBlocks } from "./block-markdown-utils";

interface UseBlockFocusOptions {
  blocksRef: React.MutableRefObject<string[]>;
  editorMapRef: React.MutableRefObject<Map<number, SlateEditor>>;
  pendingFocusRef: React.MutableRefObject<{
    index: number;
    position: "start" | "end";
  } | null>;
  virtuosoRef: React.MutableRefObject<VirtuosoHandle | null>;
  focusedIndex: number | null;
  setFocusedIndex: (index: number | null) => void;
}

export function useBlockFocus({
  blocksRef,
  editorMapRef,
  pendingFocusRef,
  virtuosoRef,
  focusedIndex,
  setFocusedIndex,
}: UseBlockFocusOptions) {
  const focusBlock = useCallback(
    (targetIndex: number, position: "start" | "end") => {
      if (targetIndex < 0 || targetIndex >= blocksRef.current.length) {
        return;
      }
      const editor = editorMapRef.current.get(targetIndex);
      if (!editor) {
        pendingFocusRef.current = { index: targetIndex, position };
        virtuosoRef.current?.scrollToIndex({ index: targetIndex, align: "center" });
        return;
      }
      const point = blockSelectionPoint(editor, position);
      ReactEditor.focus(editor);
      Transforms.setSelection(editor, { anchor: point, focus: point });
      setFocusedIndex(targetIndex);
    },
    [blocksRef, editorMapRef, pendingFocusRef, setFocusedIndex, virtuosoRef],
  );

  const getMarkdownPositionForSelection = useCallback(() => {
    let index = focusedIndex;
    if (index == null || !editorMapRef.current.get(index)?.selection) {
      let fallbackIndex: number | null = null;
      for (const [idx, editor] of editorMapRef.current.entries()) {
        if (!editor?.selection) continue;
        if (ReactEditor.isFocused(editor)) {
          index = idx;
          fallbackIndex = null;
          break;
        }
        if (fallbackIndex == null) {
          fallbackIndex = idx;
        }
      }
      if (index == null && fallbackIndex != null) {
        index = fallbackIndex;
      }
    }
    if (index == null) return null;
    const editor = editorMapRef.current.get(index);
    if (!editor || !editor.selection) return null;
    const { index: localIndex } = nearestMarkdownIndexForSlatePoint(
      editor,
      editor.selection.focus,
    );
    if (localIndex < 0) return null;
    const blocks = blocksRef.current;
    const globalIndex = globalIndexForBlockOffset(blocks, index, localIndex);
    const fullMarkdown = joinBlocks(blocks);
    return (
      indexToPosition({ index: globalIndex, markdown: fullMarkdown }) ?? null
    );
  }, [blocksRef, editorMapRef, focusedIndex]);

  return { focusBlock, getMarkdownPositionForSelection };
}
