/*
 * This hook centralizes UI state for the block editor's focus, selection,
 * and gap-cursor tracking. Keeping these related refs and setters together
 * makes it easier to wire other hooks that depend on consistent focus state.
 */

import { useCallback, useRef, useState } from "react";
import { type PendingSelection } from "./block-row-editor";

export function useBlockUiState() {
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const [lastFocusedIndex, setLastFocusedIndex] = useState<number | null>(null);
  const [activeEditorSignal, setActiveEditorSignal] = useState<number>(0);
  const [blockSelection, setBlockSelection] = useState<{
    anchor: number;
    focus: number;
  } | null>(null);
  const blockSelectionRef = useRef<{
    anchor: number;
    focus: number;
  } | null>(null);
  const [gapCursor, setGapCursor] = useState<{
    index: number;
    side: "before" | "after";
    path?: number[];
  } | null>(null);
  const gapCursorRef = useRef<{
    index: number;
    side: "before" | "after";
    path?: number[];
  } | null>(null);
  const pendingGapInsertRef = useRef<{
    index: number;
    side: "before" | "after";
    path?: number[];
    insertIndex?: number;
    buffer?: string;
  } | null>(null);
  const pendingSelectionRef = useRef<PendingSelection | null>(null);
  const skipSelectionResetRef = useRef<Set<number>>(new Set());

  const setGapCursorState = useCallback(
    (
      next:
        | { index: number; side: "before" | "after"; path?: number[] }
        | null,
    ) => {
      gapCursorRef.current = next;
      setGapCursor(next);
    },
    [],
  );

  return {
    focusedIndex,
    setFocusedIndex,
    lastFocusedIndex,
    setLastFocusedIndex,
    activeEditorSignal,
    setActiveEditorSignal,
    blockSelection,
    setBlockSelection,
    blockSelectionRef,
    gapCursor,
    setGapCursorState,
    gapCursorRef,
    pendingGapInsertRef,
    pendingSelectionRef,
    skipSelectionResetRef,
  };
}
