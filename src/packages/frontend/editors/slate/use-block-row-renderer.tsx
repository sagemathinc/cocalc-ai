/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
// Block row rendering is centralized here to keep the core editor component slimmer.
// It wires per-row props and focus behavior into BlockRowEditor, while remaining
// a lightweight hook that returns a render function for virtualization.

import { useCallback } from "react";
import type { DecoratedRange, Node, Path } from "slate";
import type { RenderLeafProps } from "./slate-react";
import { BlockRowEditor, type PendingSelection } from "./block-row-editor";
import type { Actions, SlateEditor } from "./types";
import type { SearchHook } from "./search";

type BlockRowRendererArgs = {
  blocks: string[];
  remoteVersionRef: React.MutableRefObject<number[]>;
  focusedIndex: number | null;
  blockSelection: { anchor: number; focus: number } | null;
  setBlockSelection: React.Dispatch<
    React.SetStateAction<{ anchor: number; focus: number } | null>
  >;
  setFocusedIndex: React.Dispatch<React.SetStateAction<number | null>>;
  setActiveEditorSignal: React.Dispatch<React.SetStateAction<number>>;
  onFocus?: () => void;
  onBlur?: () => void;
  autoFocus?: boolean;
  read_only?: boolean;
  actions?: Actions;
  id?: string;
  rowStyle: React.CSSProperties;
  gapCursor:
    | { index: number; side: "before" | "after"; path?: number[] }
    | null;
  setGapCursor: (
    gap: { index: number; side: "before" | "after"; path?: number[] } | null,
  ) => void;
  gapCursorRef: React.MutableRefObject<{
    index: number;
    side: "before" | "after";
    path?: number[];
  } | null>;
  pendingGapInsertRef: React.MutableRefObject<{
    index: number;
    side: "before" | "after";
    path?: number[];
    insertIndex?: number;
    buffer?: string;
  } | null>;
  pendingSelectionRef: React.MutableRefObject<PendingSelection | null>;
  skipSelectionResetRef: React.MutableRefObject<Set<number>>;
  onNavigate: (index: number, position: "start" | "end") => void;
  onInsertGap: (
    gap: { index: number; side: "before" | "after" },
    initialText?: string,
    focusPosition?: "start" | "end",
  ) => void;
  onSetBlockText: (index: number, text: string) => void;
  preserveBlankLines: boolean;
  saveNow?: () => void;
  registerEditor: (index: number, editor: SlateEditor) => void;
  unregisterEditor: (index: number, editor: SlateEditor) => void;
  onEditorChange?: (index: number) => void;
  getFullMarkdown: () => string;
  codeBlockExpandState: Map<string, boolean>;
  blockCount: number;
  gutterWidth?: number;
  leafComponent?: React.ComponentType<RenderLeafProps>;
  searchHook?: SearchHook;
  searchDecorate?: (entry: [Node, Path]) => DecoratedRange[];
  searchQuery?: string;
  clearBlockSelection?: () => void;
  onMergeWithPrevious?: (index: number) => void;
  onChangeMarkdown: (index: number, markdown: string) => void;
  onDeleteBlock: (index: number) => void;
  selectedRange?: { start: number; end: number } | null;
  handleSelectBlock: (index: number, opts: { shiftKey: boolean }) => void;
  lastLocalEditAtRef: React.MutableRefObject<number>;
  lastRemoteMergeAtRef: React.MutableRefObject<number>;
};

export function useBlockRowRenderer(args: BlockRowRendererArgs) {
  const {
    blocks,
    remoteVersionRef,
    focusedIndex,
    blockSelection,
    setBlockSelection,
    setFocusedIndex,
    setActiveEditorSignal,
    onFocus,
    onBlur,
    autoFocus,
    read_only,
    actions,
    id,
    rowStyle,
    gapCursor,
    setGapCursor,
    gapCursorRef,
    pendingGapInsertRef,
    pendingSelectionRef,
    skipSelectionResetRef,
    onNavigate,
    onInsertGap,
    onSetBlockText,
    preserveBlankLines,
    saveNow,
    registerEditor,
    unregisterEditor,
    onEditorChange,
    getFullMarkdown,
    codeBlockExpandState,
    blockCount,
    gutterWidth,
    leafComponent,
    searchHook,
    searchDecorate,
    searchQuery,
    clearBlockSelection,
    onMergeWithPrevious,
    onChangeMarkdown,
    onDeleteBlock,
    selectedRange,
    handleSelectBlock,
    lastLocalEditAtRef,
    lastRemoteMergeAtRef,
  } = args;

  return useCallback(
    (index: number) => {
      const markdown = blocks[index] ?? "";
      const remoteVersion = remoteVersionRef.current[index] ?? 0;
      const isSelected =
        selectedRange != null &&
        index >= selectedRange.start &&
        index <= selectedRange.end;
      return (
        <BlockRowEditor
          index={index}
          markdown={markdown}
          remoteVersion={remoteVersion}
          isFocused={focusedIndex === index}
          clearBlockSelection={clearBlockSelection}
          onMergeWithPrevious={onMergeWithPrevious}
          lastLocalEditAtRef={lastLocalEditAtRef}
          lastRemoteMergeAtRef={lastRemoteMergeAtRef}
          onChangeMarkdown={onChangeMarkdown}
          onDeleteBlock={onDeleteBlock}
          onFocus={() => {
            setFocusedIndex(index);
            setActiveEditorSignal((prev) => prev + 1);
            if (blockSelection) {
              setBlockSelection(null);
            }
            onFocus?.();
          }}
          onBlur={() => {
            setFocusedIndex((prev) => (prev === index ? null : prev));
            onBlur?.();
          }}
          onSelectBlock={handleSelectBlock}
          autoFocus={autoFocus && index === 0}
          read_only={read_only}
          actions={actions}
          id={id}
          rowStyle={rowStyle}
          gapCursor={gapCursor}
          setGapCursor={setGapCursor}
          gapCursorRef={gapCursorRef}
          pendingGapInsertRef={pendingGapInsertRef}
          pendingSelectionRef={pendingSelectionRef}
          skipSelectionResetRef={skipSelectionResetRef}
          onNavigate={onNavigate}
          onInsertGap={onInsertGap}
          onSetBlockText={onSetBlockText}
          preserveBlankLines={preserveBlankLines}
          saveNow={saveNow}
          registerEditor={registerEditor}
          unregisterEditor={unregisterEditor}
          onEditorChange={onEditorChange}
          getFullMarkdown={getFullMarkdown}
          codeBlockExpandState={codeBlockExpandState}
          blockCount={blockCount}
          selected={isSelected}
          gutterWidth={gutterWidth}
          leafComponent={leafComponent}
          searchHook={searchHook}
          searchDecorate={searchDecorate}
          searchQuery={searchQuery}
        />
      );
    },
    [
      actions,
      autoFocus,
      blockCount,
      blockSelection,
      blocks,
      clearBlockSelection,
      codeBlockExpandState,
      focusedIndex,
      gapCursor,
      gapCursorRef,
      getFullMarkdown,
      gutterWidth,
      id,
      leafComponent,
      onBlur,
      onChangeMarkdown,
      onDeleteBlock,
      onEditorChange,
      onFocus,
      onInsertGap,
      onMergeWithPrevious,
      onNavigate,
      onSetBlockText,
      pendingGapInsertRef,
      pendingSelectionRef,
      preserveBlankLines,
      read_only,
      registerEditor,
      remoteVersionRef,
      rowStyle,
      saveNow,
      searchDecorate,
      searchHook,
      searchQuery,
      selectedRange,
      setActiveEditorSignal,
      setBlockSelection,
      setFocusedIndex,
      setGapCursor,
      skipSelectionResetRef,
      unregisterEditor,
      handleSelectBlock,
      lastLocalEditAtRef,
      lastRemoteMergeAtRef,
    ],
  );
}
