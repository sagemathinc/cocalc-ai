/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Prototype: always-editable block editor for very large markdown documents.

import React, { MutableRefObject, useCallback, useEffect, useRef } from "react";
import { useRedux } from "@cocalc/frontend/app-framework";
import { type VirtuosoHandle } from "react-virtuoso";
import type { RenderLeafProps } from "./slate-react";
import Leaf from "./leaf";
import { Actions } from "./types";
import type { SlateEditor } from "./types";
import { BlockEditorChrome } from "./block-editor-chrome";
import { BlockRowList } from "./block-row-list";
import { splitMarkdownToBlocks } from "./block-chunking";
import { useBlockSearch } from "./use-block-search";
import { useBlockSelection } from "./use-block-selection";
import { useBlockContainerEvents } from "./use-block-container-events";
import { useBlockEditorRegistry } from "./use-block-editor-registry";
import { useBlockEditorControl } from "./use-block-editor-control";
import { useBlockFocus } from "./use-block-focus";
import { useBlockMultiSelect } from "./use-block-multi-select";
import { useBlockOps } from "./use-block-ops";
import { useBlockRowRenderer } from "./use-block-row-renderer";
import { useBlockState } from "./use-block-state";
import { useBlockSync } from "./use-block-sync";
import { useBlockUiState } from "./use-block-ui-state";
import { joinBlocks } from "./block-markdown-utils";

const DEFAULT_FONT_SIZE = 14;
const DEFAULT_SAVE_DEBOUNCE_MS = 750;
interface BlockMarkdownEditorProps {
  value?: string;
  actions?: Actions;
  read_only?: boolean;
  font_size?: number;
  id?: string;
  is_current?: boolean;
  hidePath?: boolean;
  renderPath?: React.ReactNode;
  leafComponent?: React.ComponentType<RenderLeafProps>;
  style?: React.CSSProperties;
  height?: string;
  noVfill?: boolean;
  divRef?: React.Ref<HTMLDivElement>;
  onBlur?: () => void;
  onFocus?: () => void;
  autoFocus?: boolean;
  saveDebounceMs?: number;
  remoteMergeIdleMs?: number;
  ignoreRemoteMergesWhileFocused?: boolean;
  minimal?: boolean;
  controlRef?: MutableRefObject<any>;
  preserveBlankLines?: boolean;
  getValueRef?: MutableRefObject<() => string>;
  disableBlockEditor?: boolean;
  disableVirtualization?: boolean;
}

export default function BlockMarkdownEditor(props: BlockMarkdownEditorProps) {
  const {
    actions: actions0,
    autoFocus,
    read_only,
    font_size: font_size0,
    height,
    hidePath,
    id,
    is_current,
    noVfill,
    onBlur,
    onFocus,
    saveDebounceMs = DEFAULT_SAVE_DEBOUNCE_MS,
    remoteMergeIdleMs,
    style,
    value,
    minimal,
    divRef,
    controlRef,
    getValueRef,
    renderPath,
    leafComponent,
    disableVirtualization = false,
  } = props;
  const internalControlRef = useRef<any>(null);
  const blockControlRef = controlRef ?? internalControlRef;
  const actions = actions0 ?? {};
  const storeName = actions0?.name ?? "";
  const showHelpModal =
    (useRedux(storeName, "show_slate_help") as boolean | undefined) ?? false;
  const font_size = font_size0 ?? DEFAULT_FONT_SIZE;
  const leafComponentResolved = leafComponent ?? Leaf;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const initialValue = value ?? "";
  const valueRef = useRef<string>(initialValue);
  // Block mode treats each block independently, so always disable significant
  // blank lines to avoid confusing per-block newline behavior.
  const preserveBlankLines = false;

  const {
    blocks,
    setBlocks,
    blocksRef,
    blockIds,
    setBlockIds,
    blockIdsRef,
    remoteVersionRef,
    newBlockId,
    syncRemoteVersionLength,
    bumpRemoteVersionAt,
    setBlocksFromValue,
  } = useBlockState({
    initialValue,
    valueRef,
  });

  const {
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
  } = useBlockUiState();

  const editorMapRef = useRef<Map<number, SlateEditor>>(new Map());
  const codeBlockExpandStateRef = useRef<Map<string, boolean>>(new Map());
  const pendingFocusRef = useRef<{
    index: number;
    position: "start" | "end";
  } | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);

  const getFullMarkdown = useCallback(() => joinBlocks(blocksRef.current), []);
  const ignoreRemoteWhileFocused = false;

  const {
    applyBlocksFromValue,
    allowNextValueUpdateWhileFocused,
    flushPendingRemoteMerge,
    markLocalEdit,
    pendingRemoteIndicator,
    saveBlocksDebounced,
    saveBlocksNow,
    lastLocalEditAtRef,
    lastRemoteMergeAtRef,
  } = useBlockSync({
    actions,
    value,
    initialValue,
    valueRef,
    blocksRef,
    focusedIndex,
    ignoreRemoteWhileFocused,
    remoteMergeIdleMs,
    saveDebounceMs,
    setBlocksFromValue,
    getFullMarkdown,
  });

  useEffect(() => {
    if (getValueRef == null) return;
    getValueRef.current = getFullMarkdown;
  }, [getValueRef, getFullMarkdown]);

  const handleBlockChange = useCallback(
    (index: number, markdown: string) => {
      if (read_only) return;
      markLocalEdit();
      skipSelectionResetRef.current.add(index);
      setBlocks((prev) => {
        if (index >= prev.length) return prev;
        if (prev[index] === markdown) return prev;
        const next = [...prev];
        next[index] = markdown;
        blocksRef.current = next;
        return next;
      });
      setBlockIds((prev) => {
        if (prev.length >= blocksRef.current.length) return prev;
        const next = [...prev];
        while (next.length < blocksRef.current.length) {
          next.push(newBlockId());
        }
        blockIdsRef.current = next;
        return next;
      });
      syncRemoteVersionLength(blocksRef.current);
      if (is_current) saveBlocksDebounced();
    },
    [
      is_current,
      markLocalEdit,
      read_only,
      saveBlocksDebounced,
      newBlockId,
      syncRemoteVersionLength,
    ],
  );

  const { focusBlock, getMarkdownPositionForSelection } = useBlockFocus({
    blocksRef,
    editorMapRef,
    pendingFocusRef,
    virtuosoRef,
    focusedIndex,
    setFocusedIndex,
  });

  const {
    getSelectionGlobalRange,
    selectGlobalRange,
    setSelectionAtOffset,
    setSelectionFromMarkdownPosition,
  } = useBlockSelection({
    blocksRef,
    editorMapRef,
    pendingSelectionRef,
    virtuosoRef,
    focusedIndex,
    lastFocusedIndex,
    setFocusedIndex,
  });

  const { searchHook, searchDecorate, searchQuery } = useBlockSearch({
    getFullMarkdown,
    applyBlocksFromValue,
    selectGlobalRange,
    getSelectionGlobalRange,
  });


  useBlockEditorControl({
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
  });

  const { registerEditor, unregisterEditor, handleActiveEditorChange } =
    useBlockEditorRegistry({
      editorMapRef,
      pendingSelectionRef,
      pendingFocusRef,
      blocksRef,
      focusBlock,
      setFocusedIndex,
      focusedIndex,
      setLastFocusedIndex,
      setActiveEditorSignal,
    });

  const {
    insertBlockAtGap,
    setBlockText,
    deleteBlockAtIndex,
    mergeWithPreviousBlock,
  } = useBlockOps({
    blocksRef,
    blockIdsRef,
    editorMapRef,
    pendingSelectionRef,
    pendingFocusRef,
    skipSelectionResetRef,
    setBlocks,
    setBlockIds,
    setFocusedIndex,
    setSelectionAtOffset,
    setGapCursorState,
    syncRemoteVersionLength,
    bumpRemoteVersionAt,
    markLocalEdit,
    saveBlocksDebounced,
    newBlockId,
    is_current,
    virtuosoRef,
  });

  const {
    selectionRange,
    clearBlockSelection,
    handleSelectBlock,
    getSelectedBlocks,
    setSelectionToRange,
    deleteSelectedBlocks,
    moveSelectedBlocks,
    insertBlocksAfterSelection,
  } = useBlockMultiSelect({
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
  });

  const setContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node;
      if (typeof divRef === "function") {
        divRef(node);
      } else if (divRef && "current" in divRef) {
        (divRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
      }
    },
    [divRef],
  );

  const rowStyle: React.CSSProperties = {
    padding: minimal ? 0 : "0 70px",
    minHeight: "1px",
    position: "relative",
  };
  const gutterWidth = minimal ? 0 : 70;

  const showPendingRemoteIndicator =
    ignoreRemoteWhileFocused && pendingRemoteIndicator;

  const handleMergePending = useCallback(
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      flushPendingRemoteMerge(true);
    },
    [flushPendingRemoteMerge],
  );

  const activeEditorIndex =
    focusedIndex ?? lastFocusedIndex ?? null;
  const activeEditor =
    activeEditorIndex != null
      ? editorMapRef.current.get(activeEditorIndex) ?? null
      : null;
  const editBarKey = activeEditorIndex ?? "none";
  const hideSearch = false;

  const renderBlock = useBlockRowRenderer({
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
    id: props.id,
    rowStyle,
    gapCursor,
    setGapCursor: setGapCursorState,
    gapCursorRef,
    pendingGapInsertRef,
    pendingSelectionRef,
    skipSelectionResetRef,
    onNavigate: focusBlock,
    onInsertGap: insertBlockAtGap,
    onSetBlockText: setBlockText,
    preserveBlankLines,
    saveNow: saveBlocksNow,
    registerEditor,
    unregisterEditor,
    onEditorChange: handleActiveEditorChange,
    getFullMarkdown,
    codeBlockExpandState: codeBlockExpandStateRef.current,
    blockCount: blocks.length,
    gutterWidth,
    leafComponent: leafComponentResolved,
    searchHook,
    searchDecorate,
    searchQuery,
    clearBlockSelection,
    onMergeWithPrevious: mergeWithPreviousBlock,
    onChangeMarkdown: handleBlockChange,
    onDeleteBlock: deleteBlockAtIndex,
    selectedRange: selectionRange,
    handleSelectBlock,
    lastLocalEditAtRef,
    lastRemoteMergeAtRef,
  });

  const {
    onMouseDownCapture,
    onKeyDownCapture,
    onCopyCapture,
    onCutCapture,
    onPasteCapture,
  } = useBlockContainerEvents({
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
  });

  return (
    <div
      ref={setContainerRef}
      className={noVfill || height === "auto" ? undefined : "smc-vfill"}
      tabIndex={-1}
      onMouseDownCapture={onMouseDownCapture}
      onKeyDownCapture={onKeyDownCapture}
      onCopyCapture={onCopyCapture}
      onCutCapture={onCutCapture}
      onPasteCapture={onPasteCapture}
      style={{
        overflow: noVfill || height === "auto" ? undefined : "auto",
        backgroundColor: "white",
        ...style,
        height,
        minHeight: height === "auto" ? "50px" : undefined,
        position: "relative",
      }}
    >
      <BlockEditorChrome
        editBarKey={editBarKey}
        editor={activeEditor ?? null}
        isCurrent={!!is_current}
        updateSignal={activeEditorSignal}
        hideSearch={hideSearch}
        searchHook={searchHook}
        onHelp={() => actions0?.setState?.({ show_slate_help: true })}
        showHelpModal={!!showHelpModal}
        onCloseHelp={() => actions0?.setState?.({ show_slate_help: false })}
        hidePath={hidePath}
        renderPath={renderPath}
        showPendingRemoteIndicator={showPendingRemoteIndicator}
        onMergePending={handleMergePending}
      />
      <BlockRowList
        blocks={blocks}
        blockIds={blockIds}
        disableVirtualization={disableVirtualization}
        renderBlock={renderBlock}
        virtuosoRef={virtuosoRef}
        height={height}
        fontSize={font_size}
        noVfill={noVfill}
      />
    </div>
  );
}
