/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useCallback } from "react";
import { Descendant, Editor, Transforms } from "slate";
import { ReactEditor } from "./slate-react";
import type { SlateEditor } from "./types";
import { blockSelectionPoint, pointFromOffsetInDoc } from "./block-selection-utils";
import {
  blockOffsetForGlobalIndex,
  globalIndexForBlockOffset,
  joinBlocks,
  normalizeBlockMarkdown,
} from "./block-markdown-utils";
import {
  findSlatePointNearMarkdownPosition,
  indexToPosition,
  markdownPositionToSlatePoint,
  nearestMarkdownIndexForSlatePoint,
  positionToIndex,
} from "./sync";

interface PendingSelection {
  index: number;
  offset?: number;
  endOffset?: number;
  pos?: { line: number; ch: number };
  endPos?: { line: number; ch: number };
  mode: "text" | "markdown";
}

interface Options {
  blocksRef: React.MutableRefObject<string[]>;
  editorMapRef: React.MutableRefObject<Map<number, SlateEditor>>;
  pendingSelectionRef: React.MutableRefObject<PendingSelection | null>;
  virtuosoRef: React.MutableRefObject<{ scrollToIndex: (opts: any) => void } | null>;
  focusedIndex: number | null;
  lastFocusedIndex: number | null;
  setFocusedIndex: (index: number | null) => void;
}

export function useBlockSelection(options: Options) {
  const {
    blocksRef,
    editorMapRef,
    pendingSelectionRef,
    virtuosoRef,
    focusedIndex,
    lastFocusedIndex,
    setFocusedIndex,
  } = options;

  const safelyFocusAndSelect = useCallback(
    (
      editor: SlateEditor,
      anchor: { path: number[]; offset: number },
      focus: { path: number[]; offset: number } = anchor,
    ) => {
      if (!Editor.hasPath(editor, anchor.path) || !Editor.hasPath(editor, focus.path)) {
        return false;
      }
      try {
        // Preserve prior behavior: focus first, then set selection.
        ReactEditor.focus(editor);
        Transforms.setSelection(editor, { anchor, focus });
      } catch (_err) {
        // If focus fails due stale DOM selection mapping, retry with a fresh selection.
        try {
          Transforms.setSelection(editor, { anchor, focus });
          ReactEditor.focus(editor);
        } catch (_retryErr) {
          // Last resort: clear selection state and retry once.
          try {
            Transforms.deselect(editor);
            ReactEditor.focus(editor);
            Transforms.setSelection(editor, { anchor, focus });
          } catch (_lastErr) {
            return false;
          }
        }
      }
      return true;
    },
    [],
  );

  const tryApplySelectionAtOffset = useCallback(
    (index: number, offset: number) => {
      if (index < 0 || index >= blocksRef.current.length) return false;
      const editor = editorMapRef.current.get(index);
      if (!editor) return false;
      const point = pointFromOffsetInDoc(editor.children as Descendant[], offset);
      if (!safelyFocusAndSelect(editor, point)) return false;
      setFocusedIndex(index);
      return true;
    },
    [blocksRef, editorMapRef, safelyFocusAndSelect, setFocusedIndex],
  );

  const setSelectionAtOffset = useCallback(
    (index: number, offset: number) => {
      if (index < 0 || index >= blocksRef.current.length) return false;
      pendingSelectionRef.current = { index, offset, mode: "text" };
      const applied = tryApplySelectionAtOffset(index, offset);
      if (!applied) {
        virtuosoRef.current?.scrollToIndex({ index, align: "center" });
        return false;
      }
      return true;
    },
    [blocksRef, pendingSelectionRef, tryApplySelectionAtOffset, virtuosoRef],
  );

  const setSelectionFromMarkdownPosition = useCallback(
    (pos: { line: number; ch: number } | undefined) => {
      if (pos == null) return false;
      const blocks = blocksRef.current;
      const fullMarkdown = joinBlocks(blocks);
      const globalIndex = positionToIndex({ markdown: fullMarkdown, pos });
      if (globalIndex == null) return false;
      const target = blockOffsetForGlobalIndex(blocks, globalIndex);
      const blockMarkdown = normalizeBlockMarkdown(blocks[target.index] ?? "");
      const blockPos =
        indexToPosition({ index: target.offset, markdown: blockMarkdown }) ??
        { line: 0, ch: 0 };
      const editor = editorMapRef.current.get(target.index);
      if (!editor) {
        pendingSelectionRef.current = {
          index: target.index,
          pos: blockPos,
          mode: "markdown",
        };
        virtuosoRef.current?.scrollToIndex({
          index: target.index,
          align: "center",
        });
        return false;
      }
      const point =
        markdownPositionToSlatePoint({
          markdown: blockMarkdown,
          pos: blockPos,
          editor,
        }) ??
        findSlatePointNearMarkdownPosition({
          markdown: blockMarkdown,
          pos: blockPos,
          editor,
        }) ??
        blockSelectionPoint(editor, "start");
      if (!point) return false;
      if (!safelyFocusAndSelect(editor, point)) return false;
      setFocusedIndex(target.index);
      return true;
    },
    [
      blocksRef,
      editorMapRef,
      pendingSelectionRef,
      safelyFocusAndSelect,
      setFocusedIndex,
      virtuosoRef,
    ],
  );

  const setSelectionRangeFromMarkdownPosition = useCallback(
    (
      startPos: { line: number; ch: number } | undefined,
      endPos: { line: number; ch: number } | undefined,
    ) => {
      if (startPos == null) return false;
      if (endPos == null) return setSelectionFromMarkdownPosition(startPos);
      const blocks = blocksRef.current;
      const fullMarkdown = joinBlocks(blocks);
      const startGlobal = positionToIndex({ markdown: fullMarkdown, pos: startPos });
      if (startGlobal == null) return false;
      const endGlobal = positionToIndex({ markdown: fullMarkdown, pos: endPos });
      if (endGlobal == null) return setSelectionFromMarkdownPosition(startPos);
      const start = blockOffsetForGlobalIndex(blocks, startGlobal);
      const end = blockOffsetForGlobalIndex(blocks, endGlobal);
      if (start.index !== end.index) {
        return setSelectionFromMarkdownPosition(startPos);
      }
      const blockMarkdown = normalizeBlockMarkdown(blocks[start.index] ?? "");
      const startBlockPos =
        indexToPosition({ index: start.offset, markdown: blockMarkdown }) ??
        { line: 0, ch: 0 };
      const endBlockPos =
        indexToPosition({ index: end.offset, markdown: blockMarkdown }) ??
        startBlockPos;
      const editor = editorMapRef.current.get(start.index);
      if (!editor) {
        pendingSelectionRef.current = {
          index: start.index,
          pos: startBlockPos,
          endPos: endBlockPos,
          mode: "markdown",
        };
        virtuosoRef.current?.scrollToIndex({
          index: start.index,
          align: "center",
        });
        return false;
      }
      const startPoint =
        markdownPositionToSlatePoint({
          markdown: blockMarkdown,
          pos: startBlockPos,
          editor,
        }) ??
        findSlatePointNearMarkdownPosition({
          markdown: blockMarkdown,
          pos: startBlockPos,
          editor,
        }) ??
        blockSelectionPoint(editor, "start");
      const endPoint =
        markdownPositionToSlatePoint({
          markdown: blockMarkdown,
          pos: endBlockPos,
          editor,
        }) ??
        findSlatePointNearMarkdownPosition({
          markdown: blockMarkdown,
          pos: endBlockPos,
          editor,
        }) ??
        startPoint;
      if (!safelyFocusAndSelect(editor, startPoint, endPoint)) return false;
      setFocusedIndex(start.index);
      return true;
    },
    [
      blocksRef,
      editorMapRef,
      pendingSelectionRef,
      safelyFocusAndSelect,
      setFocusedIndex,
      setSelectionFromMarkdownPosition,
      virtuosoRef,
    ],
  );

  const getSelectionGlobalRange = useCallback(() => {
    let index = focusedIndex ?? lastFocusedIndex ?? null;
    let editor = index != null ? editorMapRef.current.get(index) ?? null : null;
    if (!editor || !editor.selection) {
      for (const [idx, candidate] of editorMapRef.current.entries()) {
        if (!candidate?.selection) continue;
        editor = candidate;
        index = idx;
        if (ReactEditor.isFocused(candidate)) break;
      }
    }
    if (index == null || !editor || !editor.selection) return null;
    const anchorLocal = nearestMarkdownIndexForSlatePoint(
      editor,
      editor.selection.anchor,
    ).index;
    const focusLocal = nearestMarkdownIndexForSlatePoint(
      editor,
      editor.selection.focus,
    ).index;
    if (anchorLocal < 0 || focusLocal < 0) return null;
    const startLocal = Math.min(anchorLocal, focusLocal);
    const endLocal = Math.max(anchorLocal, focusLocal);
    const startGlobal = globalIndexForBlockOffset(
      blocksRef.current,
      index,
      startLocal,
    );
    const endGlobal = globalIndexForBlockOffset(
      blocksRef.current,
      index,
      endLocal,
    );
    return { start: startGlobal, end: endGlobal };
  }, [blocksRef, editorMapRef, focusedIndex, lastFocusedIndex]);

  const selectGlobalRange = useCallback(
    (startIndex: number, endIndex: number) => {
      const blocks = blocksRef.current;
      const fullMarkdown = joinBlocks(blocks);
      const startPos = indexToPosition({ index: startIndex, markdown: fullMarkdown });
      const endPos = indexToPosition({ index: endIndex, markdown: fullMarkdown });
      if (startPos && endPos) {
        setSelectionRangeFromMarkdownPosition(startPos, endPos);
        return;
      }
      if (startPos) {
        setSelectionFromMarkdownPosition(startPos);
        return;
      }
      const start = blockOffsetForGlobalIndex(blocks, startIndex);
      setSelectionAtOffset(start.index, start.offset);
    },
    [
      blocksRef,
      setSelectionAtOffset,
      setSelectionFromMarkdownPosition,
      setSelectionRangeFromMarkdownPosition,
    ],
  );

  return {
    getSelectionGlobalRange,
    selectGlobalRange,
    setSelectionAtOffset,
    setSelectionFromMarkdownPosition,
    setSelectionRangeFromMarkdownPosition,
  };
}
