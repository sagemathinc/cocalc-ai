/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
// Editor registry logic for block mode lives here.
// It manages registering/unregistering per-block editors and applies any pending
// selection/focus once an editor mounts, while also tracking active editor signals.

import { useCallback, useEffect } from "react";
import { Descendant, Transforms } from "slate";
import { ReactEditor } from "./slate-react";
import type { SlateEditor } from "./types";
import type { PendingSelection } from "./block-row-editor";
import {
  blockSelectionPoint,
  pointFromOffsetInDoc,
} from "./block-selection-utils";
import {
  findSlatePointNearMarkdownPosition,
  indexToPosition,
  markdownPositionToSlatePoint,
} from "./sync";
import { normalizeBlockMarkdown } from "./block-markdown-utils";

type UseBlockEditorRegistryArgs = {
  editorMapRef: React.MutableRefObject<Map<number, SlateEditor>>;
  pendingSelectionRef: React.MutableRefObject<PendingSelection | null>;
  pendingFocusRef: React.MutableRefObject<{
    index: number;
    position: "start" | "end";
  } | null>;
  blocksRef: React.MutableRefObject<string[]>;
  focusBlock: (index: number, position: "start" | "end") => void;
  setFocusedIndex: React.Dispatch<React.SetStateAction<number | null>>;
  focusedIndex: number | null;
  setLastFocusedIndex: React.Dispatch<React.SetStateAction<number | null>>;
  setActiveEditorSignal: React.Dispatch<React.SetStateAction<number>>;
};

export function useBlockEditorRegistry({
  editorMapRef,
  pendingSelectionRef,
  pendingFocusRef,
  blocksRef,
  focusBlock,
  setFocusedIndex,
  focusedIndex,
  setLastFocusedIndex,
  setActiveEditorSignal,
}: UseBlockEditorRegistryArgs) {
  const registerEditor = useCallback(
    (index: number, editor: SlateEditor) => {
      editorMapRef.current.set(index, editor);
      const pendingSelection = pendingSelectionRef.current;
      if (pendingSelection?.index === index) {
        pendingSelectionRef.current = null;
        if (pendingSelection.mode === "markdown") {
          const blockMarkdown = normalizeBlockMarkdown(
            blocksRef.current[index] ?? "",
          );
          const pos =
            pendingSelection.pos ??
            indexToPosition({ index: 0, markdown: blockMarkdown });
          const point =
            (pos &&
              markdownPositionToSlatePoint({
                markdown: blockMarkdown,
                pos,
                editor,
              })) ??
            findSlatePointNearMarkdownPosition({
              markdown: blockMarkdown,
              pos,
              editor,
            }) ??
            blockSelectionPoint(editor, "start");
          if (point) {
            ReactEditor.focus(editor);
            Transforms.setSelection(editor, { anchor: point, focus: point });
            setFocusedIndex(index);
            return;
          }
        } else {
          const point = pointFromOffsetInDoc(
            editor.children as Descendant[],
            pendingSelection.offset,
          );
          ReactEditor.focus(editor);
          Transforms.setSelection(editor, { anchor: point, focus: point });
          setFocusedIndex(index);
          return;
        }
      }
      const pending = pendingFocusRef.current;
      if (pending?.index === index) {
        pendingFocusRef.current = null;
        focusBlock(index, pending.position);
      }
    },
    [
      blocksRef,
      editorMapRef,
      focusBlock,
      pendingFocusRef,
      pendingSelectionRef,
      setFocusedIndex,
    ],
  );

  const unregisterEditor = useCallback(
    (index: number, editor: SlateEditor) => {
      const current = editorMapRef.current.get(index);
      if (current === editor) {
        editorMapRef.current.delete(index);
      }
    },
    [editorMapRef],
  );

  useEffect(() => {
    if (focusedIndex != null) {
      setLastFocusedIndex(focusedIndex);
    }
    setActiveEditorSignal((prev) => prev + 1);
  }, [focusedIndex, setActiveEditorSignal, setLastFocusedIndex]);

  const handleActiveEditorChange = useCallback(
    (index: number) => {
      if (index !== focusedIndex) return;
      setActiveEditorSignal((prev) => prev + 1);
    },
    [focusedIndex, setActiveEditorSignal],
  );

  return {
    registerEditor,
    unregisterEditor,
    handleActiveEditorChange,
  };
}
