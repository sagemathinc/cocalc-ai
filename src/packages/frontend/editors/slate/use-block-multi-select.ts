/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
// Multi-block selection logic for block mode lives here.
// It computes the selection range and provides operations like delete, move,
// and insert, keeping block-markdown-editor-core simpler.

import { useCallback, useEffect, useMemo } from "react";

export function useBlockMultiSelect({
  blockSelection,
  setBlockSelection,
  blockSelectionRef,
  blocksRef,
  setBlocks,
  setGapCursorState,
  setFocusedIndex,
  saveBlocksDebounced,
  is_current,
  containerRef,
  focusedIndex,
  splitMarkdownToBlocks,
}: {
  blockSelection: { anchor: number; focus: number } | null;
  setBlockSelection: React.Dispatch<
    React.SetStateAction<{ anchor: number; focus: number } | null>
  >;
  blockSelectionRef: React.MutableRefObject<{
    anchor: number;
    focus: number;
  } | null>;
  blocksRef: React.MutableRefObject<string[]>;
  setBlocks: React.Dispatch<React.SetStateAction<string[]>>;
  setGapCursorState: (
    gap: { index: number; side: "before" | "after"; path?: number[] } | null,
  ) => void;
  setFocusedIndex: React.Dispatch<React.SetStateAction<number | null>>;
  saveBlocksDebounced: () => void;
  is_current?: boolean;
  containerRef: React.MutableRefObject<HTMLDivElement | null>;
  focusedIndex: number | null;
  splitMarkdownToBlocks: (markdown: string) => string[];
}) {
  const selectionRange = useMemo(() => {
    if (!blockSelection) return null;
    const start = Math.min(blockSelection.anchor, blockSelection.focus);
    const end = Math.max(blockSelection.anchor, blockSelection.focus);
    return { start, end };
  }, [blockSelection]);

  useEffect(() => {
    blockSelectionRef.current = blockSelection;
  }, [blockSelection, blockSelectionRef]);

  const clearBlockSelection = useCallback(() => {
    if (!blockSelectionRef.current) return;
    blockSelectionRef.current = null;
    setBlockSelection(null);
  }, [blockSelectionRef, setBlockSelection]);

  const handleSelectBlock = useCallback(
    (index: number, opts: { shiftKey: boolean }) => {
      setGapCursorState(null);
      setFocusedIndex(null);
      containerRef.current?.focus();
      if (opts.shiftKey) {
        const anchor =
          blockSelectionRef.current?.anchor ??
          focusedIndex ??
          index;
        const next = { anchor, focus: index };
        blockSelectionRef.current = next;
        setBlockSelection(next);
      } else {
        const next = { anchor: index, focus: index };
        blockSelectionRef.current = next;
        setBlockSelection(next);
      }
    },
    [
      blockSelectionRef,
      containerRef,
      focusedIndex,
      setBlockSelection,
      setFocusedIndex,
      setGapCursorState,
    ],
  );

  const getSelectedBlocks = useCallback(() => {
    if (!selectionRange) return [];
    return blocksRef.current.slice(
      selectionRange.start,
      selectionRange.end + 1,
    );
  }, [selectionRange, blocksRef]);

  const setSelectionToRange = useCallback(
    (start: number, end: number) => {
      setBlockSelection({ anchor: start, focus: end });
    },
    [setBlockSelection],
  );

  const deleteSelectedBlocks = useCallback(() => {
    if (!selectionRange) return;
    const { start, end } = selectionRange;
    setGapCursorState(null);
    setFocusedIndex(null);
    setBlocks((prev) => {
      const next = [...prev];
      next.splice(start, end - start + 1);
      if (next.length === 0) {
        next.push("");
      }
      blocksRef.current = next;
      return next;
    });
    if (is_current) saveBlocksDebounced();
    const nextIndex = Math.min(start, blocksRef.current.length - 1);
    setSelectionToRange(nextIndex, nextIndex);
  }, [
    selectionRange,
    setBlocks,
    blocksRef,
    is_current,
    saveBlocksDebounced,
    setSelectionToRange,
    setFocusedIndex,
    setGapCursorState,
  ]);

  const moveSelectedBlocks = useCallback(
    (direction: "up" | "down") => {
      if (!selectionRange) return;
      const { start, end } = selectionRange;
      const delta = direction === "up" ? -1 : 1;
      if (direction === "up" && start === 0) return;
      if (direction === "down" && end === blocksRef.current.length - 1) return;
      setBlocks((prev) => {
        const next = [...prev];
        const removed = next.splice(start, end - start + 1);
        const insertAt = direction === "up" ? start - 1 : start + 1;
        next.splice(insertAt, 0, ...removed);
        blocksRef.current = next;
        return next;
      });
      setSelectionToRange(start + delta, end + delta);
      if (is_current) saveBlocksDebounced();
    },
    [
      selectionRange,
      blocksRef,
      setBlocks,
      setSelectionToRange,
      is_current,
      saveBlocksDebounced,
    ],
  );

  const insertBlocksAfterSelection = useCallback(
    (markdown: string) => {
      if (!selectionRange) return;
      const newBlocks = splitMarkdownToBlocks(markdown);
      const insertIndex = selectionRange.end + 1;
      setGapCursorState(null);
      setFocusedIndex(null);
      setBlocks((prev) => {
        const next = [...prev];
        next.splice(insertIndex, 0, ...newBlocks);
        blocksRef.current = next;
        return next;
      });
      if (is_current) saveBlocksDebounced();
      setSelectionToRange(
        insertIndex,
        insertIndex + Math.max(0, newBlocks.length - 1),
      );
    },
    [
      selectionRange,
      splitMarkdownToBlocks,
      setBlocks,
      blocksRef,
      is_current,
      saveBlocksDebounced,
      setSelectionToRange,
      setFocusedIndex,
      setGapCursorState,
    ],
  );

  return {
    selectionRange,
    clearBlockSelection,
    handleSelectBlock,
    getSelectedBlocks,
    setSelectionToRange,
    deleteSelectedBlocks,
    moveSelectedBlocks,
    insertBlocksAfterSelection,
  };
}
