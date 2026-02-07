/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
// Container-level event handling for the block editor lives here.
// It centralizes keyboard/mouse/clipboard handling so the core component can
// stay focused on state wiring and rendering.

import { useCallback } from "react";
import { Editor, Node, Range } from "slate";
import { formatSelectedText } from "./format/commands";
import { IS_MACOS } from "./keyboard/register";
import { getFontSizeDeltaFromKey } from "./keyboard/font-size-shortcut";
import { normalizePointForDoc } from "./block-selection-utils";
import { joinBlocks } from "./block-markdown-utils";
import type { SearchHook } from "./search";
import type { Actions, SlateEditor } from "./types";

type SelectionRange = { start: number; end: number };

type UseBlockContainerEventsArgs = {
  actions?: Actions;
  id?: string;
  getFullMarkdown: () => string;
  focusedIndex: number | null;
  editorMapRef: React.MutableRefObject<Map<number, SlateEditor>>;
  searchHook: SearchHook;
  selectionRange: SelectionRange | null;
  blockSelection: { anchor: number; focus: number } | null;
  blockSelectionRef: React.MutableRefObject<
    { anchor: number; focus: number } | null
  >;
  containerRef: React.MutableRefObject<HTMLDivElement | null>;
  blocksRef: React.MutableRefObject<string[]>;
  focusBlock: (index: number, position: "start" | "end") => void;
  handleSelectBlock: (index: number, opts: { shiftKey: boolean }) => void;
  setSelectionToRange: (start: number, end: number) => void;
  setBlockSelection: React.Dispatch<
    React.SetStateAction<{ anchor: number; focus: number } | null>
  >;
  getSelectedBlocks: () => string[];
  deleteSelectedBlocks: () => void;
  moveSelectedBlocks: (direction: "up" | "down") => void;
  insertBlocksAfterSelection: (markdown: string) => void;
};

export function useBlockContainerEvents({
  actions,
  id,
  getFullMarkdown,
  focusedIndex,
  editorMapRef,
  searchHook,
  selectionRange,
  blockSelection,
  blockSelectionRef,
  containerRef,
  blocksRef,
  focusBlock,
  handleSelectBlock,
  setSelectionToRange,
  setBlockSelection,
  getSelectedBlocks,
  deleteSelectedBlocks,
  moveSelectedBlocks,
  insertBlocksAfterSelection,
}: UseBlockContainerEventsArgs) {
  const onMouseDownCapture = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!event.shiftKey) return;
      if (!blockSelectionRef.current) return;
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest("[data-slate-block-gutter]")) return;
      const row = target.closest("[data-slate-block-index]");
      if (!row) return;
      const indexAttr = row.getAttribute("data-slate-block-index");
      if (indexAttr == null) return;
      const index = parseInt(indexAttr, 10);
      if (!Number.isFinite(index)) return;
      event.preventDefault();
      event.stopPropagation();
      handleSelectBlock(index, { shiftKey: true });
    },
    [blockSelectionRef, handleSelectBlock],
  );

  const onKeyDownCapture = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === "f" && focusedIndex == null) {
          event.preventDefault();
          const selectedText =
            typeof window !== "undefined"
              ? window.getSelection()?.toString()
              : "";
          searchHook.focus(selectedText);
          return;
        }
        if (key === "g" && focusedIndex == null) {
          event.preventDefault();
          if (event.shiftKey) {
            searchHook.previous();
          } else {
            searchHook.next();
          }
          return;
        }
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        const delta = getFontSizeDeltaFromKey(event.key, event.shiftKey);
        if (delta != null && actions?.change_font_size != null) {
          actions.change_font_size(delta, id);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
      if (
        event.key === "Enter" &&
        (event.altKey || event.metaKey) &&
        actions?.altEnter
      ) {
        actions.altEnter(getFullMarkdown(), id);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const activeEditor =
        focusedIndex != null ? editorMapRef.current.get(focusedIndex) : null;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && activeEditor) {
        const key = event.key.toLowerCase();
        if (!event.shiftKey && key === "b") {
          formatSelectedText(activeEditor as SlateEditor, "bold");
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (!event.shiftKey && key === "i") {
          formatSelectedText(activeEditor as SlateEditor, "italic");
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (!event.shiftKey && key === "u") {
          formatSelectedText(activeEditor as SlateEditor, "underline");
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.shiftKey && key === "x") {
          formatSelectedText(activeEditor as SlateEditor, "strikethrough");
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.shiftKey && key === "c") {
          formatSelectedText(activeEditor as SlateEditor, "code");
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
      if (focusedIndex != null) {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          const editor = editorMapRef.current.get(focusedIndex);
          if (editor && editor.selection && Range.isCollapsed(editor.selection)) {
            const root = { children: editor.children } as Node;
            const normalized = normalizePointForDoc(
              root,
              editor.selection.anchor,
              event.key === "ArrowLeft" ? "start" : "end",
            );
            if (!normalized) return;
            const atEdge =
              event.key === "ArrowLeft"
                ? Editor.isStart(editor, normalized, [])
                : Editor.isEnd(editor, normalized, []);
            if (event.key === "ArrowLeft") {
              if (atEdge && focusedIndex > 0) {
                focusBlock(focusedIndex - 1, "end");
                event.preventDefault();
                event.stopPropagation();
                return;
              }
            } else if (atEdge && focusedIndex < blocksRef.current.length - 1) {
              focusBlock(focusedIndex + 1, "start");
              event.preventDefault();
              event.stopPropagation();
              return;
            }
          }
        }
      }
      if (!selectionRange) return;
      if (event.defaultPrevented) return;
      if (focusedIndex != null) return;
      if (typeof document !== "undefined") {
        const active = document.activeElement;
        if (containerRef.current && active !== containerRef.current) return;
      }
      const key = event.key.toLowerCase();
      const isMod = event.metaKey || event.ctrlKey;
      const isMoveCombo = IS_MACOS
        ? event.metaKey && event.shiftKey && !event.altKey
        : event.ctrlKey && event.shiftKey && !event.altKey;
      if (key === "escape") {
        setBlockSelection(null);
        event.preventDefault();
        return;
      }
      if (isMoveCombo && key === "arrowup") {
        moveSelectedBlocks("up");
        event.preventDefault();
        return;
      }
      if (isMoveCombo && key === "arrowdown") {
        moveSelectedBlocks("down");
        event.preventDefault();
        return;
      }
      if (event.shiftKey && key === "arrowup") {
        const focus = blockSelection?.focus ?? selectionRange.start;
        const anchor = blockSelection?.anchor ?? selectionRange.start;
        const next = Math.max(0, focus - 1);
        setSelectionToRange(anchor, next);
        event.preventDefault();
        return;
      }
      if (event.shiftKey && key === "arrowdown") {
        const focus = blockSelection?.focus ?? selectionRange.end;
        const anchor = blockSelection?.anchor ?? selectionRange.start;
        const next = Math.min(blocksRef.current.length - 1, focus + 1);
        setSelectionToRange(anchor, next);
        event.preventDefault();
        return;
      }
      if ((key === "backspace" || key === "delete") && !event.altKey) {
        deleteSelectedBlocks();
        event.preventDefault();
        return;
      }
      if (isMod && !event.shiftKey && !event.altKey && key === "a") {
        setSelectionToRange(0, blocksRef.current.length - 1);
        event.preventDefault();
        return;
      }
    },
    [
      actions,
      blockSelection,
      blocksRef,
      containerRef,
      deleteSelectedBlocks,
      editorMapRef,
      focusedIndex,
      focusBlock,
      getFullMarkdown,
      id,
      insertBlocksAfterSelection,
      moveSelectedBlocks,
      searchHook,
      selectionRange,
      setBlockSelection,
      setSelectionToRange,
    ],
  );

  const onCopyCapture = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      if (!selectionRange) return;
      const text = joinBlocks(getSelectedBlocks());
      if (event.clipboardData) {
        event.preventDefault();
        event.clipboardData.setData("text/plain", text);
        event.clipboardData.setData("text/markdown", text);
      }
    },
    [getSelectedBlocks, selectionRange],
  );

  const onCutCapture = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      if (!selectionRange) return;
      const text = joinBlocks(getSelectedBlocks());
      if (event.clipboardData) {
        event.preventDefault();
        event.clipboardData.setData("text/plain", text);
        event.clipboardData.setData("text/markdown", text);
        deleteSelectedBlocks();
      }
    },
    [deleteSelectedBlocks, getSelectedBlocks, selectionRange],
  );

  const onPasteCapture = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      if (!selectionRange) return;
      const markdown =
        event.clipboardData?.getData("text/markdown") ||
        event.clipboardData?.getData("text/plain");
      if (!markdown) return;
      event.preventDefault();
      insertBlocksAfterSelection(markdown);
    },
    [insertBlocksAfterSelection, selectionRange],
  );

  return {
    onMouseDownCapture,
    onKeyDownCapture,
    onCopyCapture,
    onCutCapture,
    onPasteCapture,
  };
}
