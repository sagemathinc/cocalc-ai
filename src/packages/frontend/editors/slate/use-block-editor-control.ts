/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect } from "react";
import { Node, Transforms } from "slate";
import type { VirtuosoHandle } from "react-virtuoso";
import { ReactEditor } from "./slate-react";
import { blockSelectionPoint } from "./block-selection-utils";
import type { SlateEditor } from "./types";
import { Actions } from "./types";

export function useBlockEditorControl({
  actions,
  id,
  blockControlRef,
  allowNextValueUpdateWhileFocused,
  focusBlock,
  blocksRef,
  editorMapRef,
  pendingFocusRef,
  virtuosoRef,
  setFocusedIndex,
  setBlocksFromValue,
  focusedIndex,
  setSelectionFromMarkdownPosition,
  getMarkdownPositionForSelection,
}: {
  actions?: Actions;
  id?: string;
  blockControlRef: React.MutableRefObject<any>;
  allowNextValueUpdateWhileFocused: () => void;
  focusBlock: (index: number, position?: "start" | "end") => void;
  blocksRef: React.MutableRefObject<string[]>;
  editorMapRef: React.MutableRefObject<Map<number, SlateEditor>>;
  pendingFocusRef: React.MutableRefObject<{
    index: number;
    position: "start" | "end";
  } | null>;
  virtuosoRef: React.MutableRefObject<VirtuosoHandle | null>;
  setFocusedIndex: React.Dispatch<React.SetStateAction<number | null>>;
  setBlocksFromValue: (markdown: string) => void;
  focusedIndex: number | null;
  setSelectionFromMarkdownPosition: (
    pos: { line: number; ch: number } | undefined,
  ) => boolean;
  getMarkdownPositionForSelection: () => { line: number; ch: number } | null;
}) {
  useEffect(() => {
    if (blockControlRef == null) return;
    blockControlRef.current = {
      ...(blockControlRef.current ?? {}),
      allowNextValueUpdateWhileFocused: () => {
        allowNextValueUpdateWhileFocused();
      },
      focusBlock: (index: number, position: "start" | "end" = "start") => {
        focusBlock(index, position);
      },
      setSelectionInBlock: (
        index: number,
        position: "start" | "end" = "start",
      ) => {
        if (index < 0 || index >= blocksRef.current.length) return false;
        const editor = editorMapRef.current.get(index);
        if (!editor) {
          pendingFocusRef.current = { index, position };
          virtuosoRef.current?.scrollToIndex({
            index,
            align: "center",
          });
          return false;
        }
        const point = blockSelectionPoint(editor, position);
        ReactEditor.focus(editor);
        Transforms.setSelection(editor, { anchor: point, focus: point });
        setFocusedIndex(index);
        return true;
      },
      getSelectionInBlock: () => {
        const index = focusedIndex;
        if (index == null) return null;
        const editor = editorMapRef.current.get(index);
        if (!editor || !editor.selection) return null;
        return { index, selection: editor.selection };
      },
      getSelectionForBlock: (index: number) => {
        const editor = editorMapRef.current.get(index);
        if (!editor || !editor.selection) return null;
        return { index, selection: editor.selection };
      },
      getSelectionOffsetForBlock: (index: number) => {
        const editor = editorMapRef.current.get(index);
        if (!editor || !editor.selection) return null;
        return {
          offset: editor.selection.anchor.offset,
          text: Node.string({ children: editor.children } as any),
        };
      },
      getBlocks: () => [...blocksRef.current],
      setMarkdown: (markdown: string) => {
        setBlocksFromValue(markdown);
      },
      getFocusedIndex: () => focusedIndex,
      setSelectionFromMarkdownPosition,
      getMarkdownPositionForSelection,
    };
    if (actions?.registerBlockEditorControl && id != null) {
      actions.registerBlockEditorControl(id, blockControlRef.current);
      return () => {
        actions.unregisterBlockEditorControl?.(id);
      };
    }
  }, [
    actions,
    allowNextValueUpdateWhileFocused,
    blockControlRef,
    blocksRef,
    editorMapRef,
    focusBlock,
    focusedIndex,
    getMarkdownPositionForSelection,
    id,
    pendingFocusRef,
    setBlocksFromValue,
    setFocusedIndex,
    setSelectionFromMarkdownPosition,
    virtuosoRef,
  ]);
}
