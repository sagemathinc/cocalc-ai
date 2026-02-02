/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Descendant,
  DecoratedRange,
  Editor,
  Element as SlateElement,
  Node,
  Path,
  Point,
  Range,
  Text,
  Transforms,
  createEditor,
} from "slate";
import { Editable, ReactEditor, Slate, withReact } from "./slate-react";
import type { RenderElementProps, RenderLeafProps } from "./slate-react";
import { markdown_to_slate } from "./markdown-to-slate";
import { slate_to_markdown } from "./slate-to-markdown";
import { withNormalize } from "./normalize";
import { withIsInline, withIsVoid } from "./plugins";
import { withAutoFormat } from "./format";
import { withCodeLineInsertBreak } from "./elements/code-block/with-code-line-insert-break";
import { withInsertBreakHack } from "./elements/link/editable";
import { withNonfatalRange, withSelectionSafety } from "./patches";
import { Element } from "./element";
import Leaf from "./leaf";
import { Actions } from "./types";
import { ChangeContext } from "./use-change";
import { getHandler as getKeyboardHandler } from "./keyboard";
import type { SearchHook } from "./search";
import { isAtBeginningOfBlock, isAtEndOfBlock } from "./control";
import { pointAtPath } from "./slate-util";
import {
  blockSelectionPoint,
  normalizePointForDoc,
  pointFromOffsetInDoc,
} from "./block-selection-utils";
import type { SlateEditor } from "./types";
import { IS_MACOS } from "./keyboard/register";
import { moveListItemDown, moveListItemUp } from "./format/list-move";
import { emptyParagraph, isWhitespaceParagraph } from "./padding";
import { remapSelectionInDocWithSentinels } from "./sync/block-diff";
import {
  findSlatePointNearMarkdownPosition,
  markdownPositionToSlatePoint,
} from "./sync";
import { buildCodeBlockDecorations } from "./elements/code-block/prism";
import type { CodeBlock } from "./elements/code-block/types";
import { debugSyncLog } from "./block-sync-utils";
import { normalizeBlockMarkdown } from "./block-markdown-utils";

const USE_BLOCK_GAP_CURSOR = false;
const USE_BLOCK_CODE_SPACERS = false;
const SHOW_BLOCK_BOUNDARIES = true;
const EMPTY_SEARCH: SearchHook = {
  decorate: () => [],
  Search: null as any,
  search: "",
  previous: () => undefined,
  next: () => undefined,
  focus: () => undefined,
};

function isBlankParagraph(node: Descendant | undefined): boolean {
  return (
    node != null &&
    node["type"] === "paragraph" &&
    node["blank"] === true &&
    Array.isArray(node["children"]) &&
    node["children"].length === 1 &&
    node["children"][0]?.["text"] === ""
  );
}

function stripTrailingBlankParagraphs(value: Descendant[]): Descendant[] {
  let end = value.length;
  while (end > 1 && isBlankParagraph(value[end - 1])) {
    end -= 1;
  }
  return value.slice(0, end);
}

function withCodeBlockSpacers(value: Descendant[]): Descendant[] {
  if (value.length === 0) return value;
  const next: Descendant[] = [];
  value.forEach((node, index) => {
    if (
      SlateElement.isElement(node) &&
      (node.type === "code_block" ||
        node.type === "html_block" ||
        node.type === "meta")
    ) {
      if (index === 0 || !isBlankParagraph(next[next.length - 1])) {
        next.push({
          type: "paragraph",
          spacer: true,
          children: [{ text: "" }],
        } as any);
      }
      next.push(node);
      next.push({
        type: "paragraph",
        spacer: true,
        children: [{ text: "" }],
      } as any);
      return;
    }
    next.push(node);
  });
  return next;
}

export type PendingSelection =
  | { index: number; offset: number; endOffset?: number; mode: "text" }
  | {
      index: number;
      pos: { line: number; ch: number };
      endPos?: { line: number; ch: number };
      mode: "markdown";
    };

export interface BlockRowEditorProps {
  index: number;
  markdown: string;
  remoteVersion?: number;
  isFocused?: boolean;
  clearBlockSelection?: () => void;
  onMergeWithPrevious?: (index: number) => void;
  lastLocalEditAtRef: React.MutableRefObject<number>;
  lastRemoteMergeAtRef: React.MutableRefObject<number>;
  onChangeMarkdown: (index: number, markdown: string) => void;
  onDeleteBlock: (index: number) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onSelectBlock?: (index: number, opts: { shiftKey: boolean }) => void;
  autoFocus?: boolean;
  read_only?: boolean;
  actions?: Actions;
  id?: string;
  rowStyle: React.CSSProperties;
  gapCursor?: { index: number; side: "before" | "after"; path?: number[] } | null;
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
  selected?: boolean;
  gutterWidth?: number;
  leafComponent?: React.ComponentType<RenderLeafProps>;
  searchHook?: SearchHook;
  searchDecorate?: (entry: [Node, Path]) => DecoratedRange[];
  searchQuery?: string;
}

export const BlockRowEditor: React.FC<BlockRowEditorProps> = React.memo(
  (props: BlockRowEditorProps) => {
    const {
      index,
      markdown,
      remoteVersion = 0,
      isFocused = false,
      clearBlockSelection,
      onMergeWithPrevious,
      lastLocalEditAtRef,
      lastRemoteMergeAtRef,
      onChangeMarkdown,
      onDeleteBlock,
      onFocus,
      onBlur,
      onSelectBlock,
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
      selected = false,
      gutterWidth = 0,
      leafComponent,
      searchHook,
      searchDecorate,
    } = props;

    const syncCacheRef = useRef<any>({});
    const editor = useMemo(() => {
      const ed = withSelectionSafety(
        withNonfatalRange(
          withInsertBreakHack(
            withNormalize(
              withAutoFormat(
                withIsInline(
                  withIsVoid(withCodeLineInsertBreak(withReact(createEditor()))),
                ),
              ),
            ),
          ),
        ),
      );
      ed.syncCache = syncCacheRef.current;
      (ed as any).codeBlockExpandState = codeBlockExpandState;
      (ed as SlateEditor).getMarkdownValue = getFullMarkdown;
      (ed as SlateEditor).getSourceValue = getFullMarkdown;
      return ed;
    }, [codeBlockExpandState, getFullMarkdown]);

    useEffect(() => {
      (editor as SlateEditor).preserveBlankLines = preserveBlankLines;
    }, [editor, preserveBlankLines]);

    useEffect(() => {
      registerEditor(index, editor as SlateEditor);
      return () => {
        unregisterEditor(index, editor as SlateEditor);
      };
    }, [index, editor, registerEditor, unregisterEditor]);

    useEffect(() => {
      (editor as any).blockIndex = index;
    }, [editor, index]);

    const [value, setValue] = useState<Descendant[]>(() => {
      const parsed = stripTrailingBlankParagraphs(
        markdown_to_slate(
          normalizeBlockMarkdown(markdown),
          false,
          syncCacheRef.current,
        ),
      );
      return USE_BLOCK_CODE_SPACERS ? withCodeBlockSpacers(parsed) : parsed;
    });
    const [change, setChange] = useState<number>(0);
    const lastMarkdownRef = useRef<string>(markdown);

    const lastRemoteVersionRef = useRef<number>(remoteVersion);
    useEffect(() => {
      if (remoteVersion === lastRemoteVersionRef.current) return;
      lastRemoteVersionRef.current = remoteVersion;
      lastMarkdownRef.current = markdown;
      syncCacheRef.current = {};
      editor.syncCache = syncCacheRef.current;
      const parsed = stripTrailingBlankParagraphs(
        markdown_to_slate(
          normalizeBlockMarkdown(markdown),
          false,
          syncCacheRef.current,
        ),
      );
      const nextValue = USE_BLOCK_CODE_SPACERS
        ? withCodeBlockSpacers(parsed)
        : parsed;
      const prevSelection = editor.selection;
      const now = Date.now();
      const localAgeMs = now - lastLocalEditAtRef.current;
      const remoteAgeMs = now - lastRemoteMergeAtRef.current;
      const isFocusedNow = isFocused || ReactEditor.isFocused(editor);
      const shouldRemap =
        isFocusedNow && prevSelection && remoteAgeMs < 1000 && localAgeMs > 200;
      debugSyncLog("remap-check", {
        index,
        isFocused: isFocusedNow,
        localAgeMs,
        remoteAgeMs,
        shouldRemap,
        remoteVersion,
      });
      const pendingSelection = pendingSelectionRef.current;
      if (pendingSelection?.index === index) {
        let point: Point | undefined;
        let endPoint: Point | undefined;
        if (pendingSelection.mode === "markdown") {
          point =
            markdownPositionToSlatePoint({
              markdown,
              pos: pendingSelection.pos,
              editor,
            }) ??
            findSlatePointNearMarkdownPosition({
              markdown,
              pos: pendingSelection.pos,
              editor,
            }) ??
            blockSelectionPoint(editor, "start") ??
            undefined;
          if (pendingSelection.endPos) {
            endPoint =
              markdownPositionToSlatePoint({
                markdown,
                pos: pendingSelection.endPos,
                editor,
              }) ??
              findSlatePointNearMarkdownPosition({
                markdown,
                pos: pendingSelection.endPos,
                editor,
              }) ??
              point ??
              undefined;
          }
        } else {
          point = pointFromOffsetInDoc(nextValue, pendingSelection.offset);
          if (pendingSelection.endOffset != null) {
            endPoint = pointFromOffsetInDoc(
              nextValue,
              pendingSelection.endOffset,
            );
          }
        }
        if (point) {
          const focusPoint = endPoint ?? point;
          editor.selection = { anchor: point, focus: focusPoint };
          ReactEditor.focus(editor);
          onFocus?.();
          pendingSelectionRef.current = null;
          skipSelectionResetRef.current.add(index);
        }
      }
      if (shouldRemap) {
        const remapped = remapSelectionInDocWithSentinels(
          value,
          nextValue,
          prevSelection,
        );
        if (remapped) {
          const root = { children: nextValue } as Node;
          const anchor = normalizePointForDoc(root, remapped.anchor, "start");
          const focus = normalizePointForDoc(root, remapped.focus, "end");
          if (anchor && focus) {
            remapped.anchor = anchor;
            remapped.focus = focus;
          }
          debugSyncLog("remap-apply", { selection: remapped });
          skipSelectionResetRef.current.add(index);
          editor.selection = remapped;
        }
      }
      const skipReset =
        skipSelectionResetRef.current.has(index) ||
        localAgeMs < 200 ||
        isFocusedNow;
      debugSyncLog("selection-reset-check", {
        index,
        skipReset,
        isFocused,
        localAgeMs,
      });
      if (skipReset) {
        skipSelectionResetRef.current.delete(index);
        const selection = editor.selection;
        if (selection) {
          const root = { children: nextValue } as Node;
          const anchor = normalizePointForDoc(root, selection.anchor, "start");
          const focus = normalizePointForDoc(root, selection.focus, "end");
          const anchorOk = anchor != null;
          const focusOk = focus != null;
          debugSyncLog("selection-validate", {
            index,
            anchorOk,
            focusOk,
          });
          if (!anchorOk || !focusOk) {
            editor.selection = null;
            editor.marks = null;
          } else {
            editor.selection = { anchor, focus };
            if (isFocusedNow && !ReactEditor.isFocused(editor)) {
              ReactEditor.focus(editor);
            }
          }
        }
      } else {
        debugSyncLog("selection-reset:clear", { index });
        editor.selection = null;
        editor.marks = null;
      }
      setValue(nextValue);
    }, [
      remoteVersion,
      markdown,
      editor,
      index,
      isFocused,
      value,
      lastLocalEditAtRef,
      lastRemoteMergeAtRef,
    ]);

    const renderElement = useCallback(
      (props: RenderElementProps) => <Element {...props} />,
      [],
    );

    const codeBlockCacheRef = useRef<
      WeakMap<
        SlateElement,
        { text: string; info: string; decorations: DecoratedRange[][] }
      >
    >(new WeakMap());

    const decorate = useCallback(
      ([node, path]): DecoratedRange[] => {
        const searchRanges =
          searchDecorate != null ? searchDecorate([node, path]) : [];
        if (!Text.isText(node)) return searchRanges;
        const lineEntry = Editor.above(editor, {
          at: path,
          match: (n) =>
            SlateElement.isElement(n) && n.type === "code_line",
        });
        if (!lineEntry) return searchRanges;
        const blockEntry = Editor.above(editor, {
          at: path,
          match: (n) =>
            SlateElement.isElement(n) &&
            (n.type === "code_block" ||
              n.type === "html_block" ||
              n.type === "meta"),
        });
        if (!blockEntry) return searchRanges;
        const [block, blockPath] = blockEntry as [SlateElement, number[]];
        const lineIndex = lineEntry[1][lineEntry[1].length - 1];
        const cache = codeBlockCacheRef.current;
        const text = block.children.map((line) => Node.string(line)).join("\n");
        const info =
          block.type === "code_block"
            ? (block as CodeBlock).info ?? ""
            : block.type === "html_block"
              ? "html"
              : "yaml";
        const cached = cache.get(block);
        let decorations = cached?.decorations;
        if (!cached || cached.text !== text || cached.info !== info) {
          const blockForDecorations =
            block.type === "code_block"
              ? (block as CodeBlock)
              : ({ ...(block as any), type: "code_block", info } as CodeBlock);
          decorations = buildCodeBlockDecorations(
            blockForDecorations,
            blockPath,
            info,
          );
          cache.set(block, { text, info, decorations });
        }
        const lineDecorations = decorations?.[lineIndex] ?? [];
        return [...searchRanges, ...lineDecorations];
      },
      [editor, searchDecorate],
    );

    const handleChange = useCallback(
      (newValue: Descendant[]) => {
        if (read_only) return;
        if (newValue === value) return;
        setValue(newValue);
        setChange((prev) => prev + 1);
        onEditorChange?.(index);
        clearBlockSelection?.();
        const nextMarkdown = normalizeBlockMarkdown(
          slate_to_markdown(newValue, {
            cache: syncCacheRef.current,
            preserveBlankLines,
          }),
        );
        lastMarkdownRef.current = nextMarkdown;
        onChangeMarkdown(index, nextMarkdown);
      },
      [
        clearBlockSelection,
        index,
        onChangeMarkdown,
        preserveBlankLines,
        read_only,
      ],
    );

    const activeGap =
      USE_BLOCK_GAP_CURSOR
        ? (gapCursor && gapCursor.index === index ? gapCursor : null) ??
          (gapCursorRef.current && gapCursorRef.current.index === index
            ? gapCursorRef.current
            : null)
        : null;
    const getActiveGap = () => {
      if (!USE_BLOCK_GAP_CURSOR) return null;
      const refGap = gapCursorRef.current;
      if (refGap && refGap.index === index) return refGap;
      return gapCursor && gapCursor.index === index ? gapCursor : null;
    };

    const insertGapIntoBlock = useCallback(
      (
        gap: { index: number; side: "before" | "after"; path?: number[] },
        initialText?: string,
      ) => {
        if (gap.index !== index) return false;
        const meaningful = editor.children.filter(
          (node) => !isWhitespaceParagraph(node),
        );
        if (meaningful.length === 0) return false;
        let insertPath: number[];
        if (gap.path) {
          insertPath =
            gap.side === "before" ? gap.path : Path.next(gap.path);
        } else {
          insertPath =
            gap.side === "before" ? [0] : [editor.children.length];
        }
        const paragraph = emptyParagraph();
        Transforms.insertNodes(editor, paragraph, { at: insertPath });
        const point = pointAtPath(editor, insertPath, undefined, "start");
        Transforms.setSelection(editor, { anchor: point, focus: point });
        ReactEditor.focus(editor);
        if (initialText) {
          Editor.insertText(editor, initialText);
        }
        setGapCursor(null);
        pendingGapInsertRef.current = null;
        return true;
      },
      [editor, index, pendingGapInsertRef, setGapCursor],
    );

    const renderLeaf = useCallback(
      (props: any) => React.createElement(leafComponent ?? Leaf, props),
      [leafComponent],
    );

    const rowRef = useRef<HTMLDivElement | null>(null);
    const [gapCursorPos, setGapCursorPos] = useState<{
      top: number;
      bottom: number;
    } | null>(null);

    useEffect(() => {
      if (!USE_BLOCK_GAP_CURSOR) {
        setGapCursorPos(null);
        return;
      }
      const active = getActiveGap();
      if (!active?.path) {
        setGapCursorPos(null);
        return;
      }
      try {
        const [node] = Editor.node(editor, active.path);
        const domNode = ReactEditor.toDOMNode(editor, node);
        const row = rowRef.current;
        if (!row) return;
        const rect = domNode.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        setGapCursorPos({
          top: rect.top - rowRect.top,
          bottom: rect.bottom - rowRect.top,
        });
      } catch {
        setGapCursorPos(null);
      }
    }, [editor, change, gapCursor, gapCursorRef, index]);

    useEffect(() => {
      (editor as any).blockGapCursor = USE_BLOCK_GAP_CURSOR ? activeGap : null;
    }, [editor, activeGap]);

    const handleKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (read_only) {
          event.preventDefault();
          return;
        }
        if (event.defaultPrevented) return;
        if (
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          (event.key === "z" || event.key === "Z")
        ) {
          const actionId = props.id ?? "slate-block";
          if (event.shiftKey) {
            if (actions?.redo != null) {
              saveNow?.();
              actions.redo(actionId);
              event.preventDefault();
              return;
            }
          } else if (actions?.undo != null) {
            saveNow?.();
            actions.undo(actionId);
            event.preventDefault();
            return;
          }
        }
        if (
          (event.ctrlKey || event.metaKey) &&
          event.shiftKey &&
          !event.altKey &&
          (event.key === "v" || event.key === "V")
        ) {
          (editor as any).__forcePlainTextPaste = true;
        }
        if ((event.ctrlKey || event.metaKey) && !event.altKey) {
          const key = event.key.toLowerCase();
          if (key === "f") {
            event.preventDefault();
            const selectedText =
              typeof window !== "undefined"
                ? window.getSelection()?.toString()
                : "";
            searchHook?.focus(selectedText);
            return;
          }
          if (key === "g") {
            event.preventDefault();
            if (event.shiftKey) {
              searchHook?.previous();
            } else {
              searchHook?.next();
            }
            return;
          }
        }
        clearBlockSelection?.();
        const isSaveKey =
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          event.key.toLowerCase() === "s";
        if (isSaveKey) {
          saveNow?.();
          actions?.save?.(true);
          event.preventDefault();
          return;
        }
        if (event.key === "Enter") {
          if (event.shiftKey && actions?.shiftEnter) {
            actions.shiftEnter(getFullMarkdown());
            event.preventDefault();
            return;
          }
          if ((event.altKey || event.metaKey) && actions?.altEnter) {
            actions.altEnter(getFullMarkdown(), id);
            event.preventDefault();
            return;
          }
        }
        if (
          event.key === "Backspace" &&
          editor.selection != null &&
          Range.isCollapsed(editor.selection) &&
          isAtBeginningOfBlock(editor, { mode: "highest" })
        ) {
          if (index > 0) {
            onMergeWithPrevious?.(index);
            event.preventDefault();
            return;
          }
        }

        if (USE_BLOCK_GAP_CURSOR) {
          const isPlainChar =
            event.key.length === 1 &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey;

          const activeGapNow = getActiveGap();
          const pendingGapNow = pendingGapInsertRef.current;
          if (pendingGapNow?.insertIndex != null && isPlainChar) {
            const buffer = `${pendingGapNow.buffer ?? ""}${event.key}`;
            onSetBlockText(pendingGapNow.insertIndex, buffer);
            pendingGapInsertRef.current = { ...pendingGapNow, buffer };
            event.preventDefault();
            return;
          }
          if (pendingGapNow && (event.key === "Enter" || isPlainChar)) {
            if (
              insertGapIntoBlock(
                pendingGapNow,
                isPlainChar ? event.key : undefined,
              )
            ) {
              event.preventDefault();
              return;
            }
            const insertIndex =
              pendingGapNow.side === "before" ? index : index + 1;
            if (isPlainChar) {
              onInsertGap(pendingGapNow, "", "end");
              const buffer = event.key;
              onSetBlockText(insertIndex, buffer);
              pendingGapInsertRef.current = {
                ...pendingGapNow,
                insertIndex,
                buffer,
              };
            } else {
              onInsertGap(pendingGapNow, undefined);
              pendingGapInsertRef.current = null;
            }
            event.preventDefault();
            return;
          }
          if (activeGapNow) {
            if (event.key === "Escape") {
              setGapCursor(null);
              pendingGapInsertRef.current = null;
              event.preventDefault();
              return;
            }
            if (event.key === "Enter" || isPlainChar) {
              if (
                insertGapIntoBlock(
                  activeGapNow,
                  isPlainChar ? event.key : undefined,
                )
              ) {
                event.preventDefault();
                return;
              }
              const insertIndex =
                activeGapNow.side === "before" ? index : index + 1;
              if (isPlainChar) {
                onInsertGap(activeGapNow, "", "end");
                const buffer = event.key;
                onSetBlockText(insertIndex, buffer);
                pendingGapInsertRef.current = {
                  ...activeGapNow,
                  insertIndex,
                  buffer,
                };
              } else {
                onInsertGap(activeGapNow, undefined);
                pendingGapInsertRef.current = null;
              }
              event.preventDefault();
              return;
            }
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              if (event.key === "ArrowUp" && activeGapNow.side === "before") {
                setGapCursor(null);
                pendingGapInsertRef.current = null;
                onNavigate(index - 1, "end");
                event.preventDefault();
                return;
              }
              if (event.key === "ArrowDown" && activeGapNow.side === "after") {
                setGapCursor(null);
                pendingGapInsertRef.current = null;
                onNavigate(index + 1, "start");
                event.preventDefault();
                return;
              }
              setGapCursor(null);
              pendingGapInsertRef.current = null;
            }
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
              setGapCursor(null);
              pendingGapInsertRef.current = null;
            }
          }
        }

        const isFocused = ReactEditor.isFocused(editor);
        if (
          !isFocused &&
          event.key !== "ArrowUp" &&
          event.key !== "ArrowDown" &&
          event.key !== "ArrowLeft" &&
          event.key !== "ArrowRight"
        ) {
          return;
        }

        if (
          event.key === "ArrowUp" &&
          editor.selection != null &&
          Range.isCollapsed(editor.selection) &&
          isAtBeginningOfBlock(editor, { mode: "highest" })
        ) {
          const topIndex = editor.selection.focus.path[0];
          if (topIndex !== 0) {
            return;
          }
          if (index > 0) {
            onNavigate(index - 1, "end");
            event.preventDefault();
            return;
          }
        }

        if (
          event.key === "ArrowDown" &&
          editor.selection != null &&
          Range.isCollapsed(editor.selection) &&
          isAtEndOfBlock(editor, { mode: "highest" })
        ) {
          const topIndex = editor.selection.focus.path[0];
          const lastIndex = Math.max(0, editor.children.length - 1);
          if (topIndex !== lastIndex) {
            return;
          }
          onNavigate(index + 1, "start");
          event.preventDefault();
          return;
        }

        if (
          event.key === "ArrowLeft" &&
          editor.selection != null &&
          Range.isCollapsed(editor.selection)
        ) {
          const topIndex = 0;
          if (!Editor.isStart(editor, editor.selection.anchor, [topIndex])) {
            return;
          }
          if (index > 0) {
            onNavigate(index - 1, "end");
            event.preventDefault();
            return;
          }
        }

        if (
          event.key === "ArrowRight" &&
          editor.selection != null &&
          Range.isCollapsed(editor.selection)
        ) {
          const lastIndex = Math.max(0, editor.children.length - 1);
          if (!Editor.isEnd(editor, editor.selection.anchor, [lastIndex])) {
            return;
          }
          onNavigate(index + 1, "start");
          event.preventDefault();
          return;
        }

        const moveCombo = IS_MACOS
          ? event.ctrlKey && event.metaKey && !event.altKey
          : event.ctrlKey &&
            event.shiftKey &&
            !event.altKey &&
            !event.metaKey;
        const isMoveUp = moveCombo && event.key === "ArrowUp";
        const isMoveDown = moveCombo && event.key === "ArrowDown";
        if (isMoveUp || isMoveDown) {
          const movedListItem = isMoveUp
            ? moveListItemUp(editor)
            : moveListItemDown(editor);
          if (movedListItem) {
            event.preventDefault();
            return;
          }
        }

        if (event.ctrlKey || event.metaKey || event.altKey) return;

        const domSelection =
          typeof window === "undefined" ? null : window.getSelection();
        const selection =
          editor.selection ??
          (domSelection && domSelection.rangeCount > 0
            ? ReactEditor.toSlateRange(editor, domSelection) ?? null
            : null);
        const codeBlockIndex = editor.children.findIndex(
          (node) => SlateElement.isElement(node) && node.type === "code_block",
        );
        const spacerIndex =
          selection &&
          selection.focus.path.length > 0 &&
          SlateElement.isElement(editor.children[selection.focus.path[0]]) &&
          (editor.children[selection.focus.path[0]] as any).spacer
            ? selection.focus.path[0]
            : null;
        const spacerBeforeCode =
          spacerIndex != null &&
          codeBlockIndex >= 0 &&
          spacerIndex < codeBlockIndex;
        const spacerAfterCode =
          spacerIndex != null &&
          codeBlockIndex >= 0 &&
          spacerIndex > codeBlockIndex;
        const codeBlockEntry = (() => {
          if (!selection) return null;
          const entry = Editor.above(editor, {
            at: selection.focus,
            match: (node) =>
              SlateElement.isElement(node) && node.type === "code_block",
          }) as [CodeBlock, number[]] | undefined;
          if (!entry) return null;
          const [block, path] = entry;
          const lineIndex = selection.focus.path[path.length];
          if (typeof lineIndex !== "number") return null;
          return {
            block,
            path,
            lineIndex,
          };
        })();
        const getCodeBlockPath = () => codeBlockEntry?.path ?? null;
        const isCodeBlockEdge = (direction: "up" | "down") => {
          if (!selection) return false;
          if (!codeBlockEntry) return false;
          if (direction === "up") return codeBlockEntry.lineIndex === 0;
          const lastIndex = Math.max(0, codeBlockEntry.block.children.length - 1);
          return codeBlockEntry.lineIndex === lastIndex;
        };

        if (
          selection &&
          (spacerBeforeCode || spacerAfterCode) &&
          (event.key === "ArrowUp" || event.key === "ArrowDown")
        ) {
          if (event.key === "ArrowUp") {
            if (spacerBeforeCode) {
              if (index > 0) {
                onNavigate(index - 1, "end");
              } else {
                onInsertGap({ index, side: "before" }, "", "end");
              }
            } else {
              const point = blockSelectionPoint(editor, "end");
              Transforms.setSelection(editor, { anchor: point, focus: point });
              ReactEditor.focus(editor);
            }
          } else {
            if (spacerAfterCode) {
              if (index < blockCount - 1) {
                onNavigate(index + 1, "start");
              } else {
                onInsertGap({ index, side: "after" }, "", "start");
              }
            } else {
              const point = blockSelectionPoint(editor, "start");
              Transforms.setSelection(editor, { anchor: point, focus: point });
              ReactEditor.focus(editor);
            }
          }
          event.preventDefault();
          return;
        }

        if (
          !USE_BLOCK_GAP_CURSOR &&
          event.key === "ArrowUp" &&
          isCodeBlockEdge("up")
        ) {
          if (index > 0) {
            onNavigate(index - 1, "end");
          } else {
            onInsertGap({ index, side: "before" }, "", "end");
          }
          event.preventDefault();
          return;
        }

        if (
          !USE_BLOCK_GAP_CURSOR &&
          event.key === "ArrowDown" &&
          isCodeBlockEdge("down")
        ) {
          if (index < blockCount - 1) {
            onNavigate(index + 1, "start");
          } else {
            onInsertGap({ index, side: "after" }, "", "start");
          }
          event.preventDefault();
          return;
        }

        if (USE_BLOCK_GAP_CURSOR) {
          if (
            event.key === "ArrowUp" &&
            selection != null &&
            Range.isCollapsed(selection) &&
            isCodeBlockEdge("up")
          ) {
            const path = getCodeBlockPath();
            setGapCursor({ index, side: "before", path: path ?? undefined });
            pendingGapInsertRef.current = {
              index,
              side: "before",
              path: path ?? undefined,
            };
            event.preventDefault();
            return;
          }

          if (
            event.key === "ArrowDown" &&
            selection != null &&
            Range.isCollapsed(selection) &&
            isCodeBlockEdge("down")
          ) {
            const path = getCodeBlockPath();
            setGapCursor({ index, side: "after", path: path ?? undefined });
            pendingGapInsertRef.current = {
              index,
              side: "after",
              path: path ?? undefined,
            };
            event.preventDefault();
            return;
          }

          if (
            event.key === "ArrowUp" &&
            editor.selection != null &&
            Range.isCollapsed(editor.selection) &&
            isAtBeginningOfBlock(editor, { mode: "highest" })
          ) {
            const topLevelIndex = editor.selection.focus.path[0];
            if (topLevelIndex !== 0) {
              return;
            }
            setGapCursor({ index, side: "before" });
            pendingGapInsertRef.current = { index, side: "before" };
            event.preventDefault();
            return;
          }

          if (
            event.key === "ArrowDown" &&
            editor.selection != null &&
            Range.isCollapsed(editor.selection) &&
            isAtEndOfBlock(editor, { mode: "highest" })
          ) {
            const topLevelIndex = editor.selection.focus.path[0];
            const lastTopLevelIndex = Math.max(0, editor.children.length - 1);
            if (topLevelIndex !== lastTopLevelIndex) {
              return;
            }
            setGapCursor({ index, side: "after" });
            pendingGapInsertRef.current = { index, side: "after" };
            event.preventDefault();
            return;
          }
        }

        const handler = getKeyboardHandler(event);
        if (handler) {
          if (
            handler({
              editor,
              extra: {
                actions: actions ?? {},
                id: id ?? "",
                search: searchHook ?? EMPTY_SEARCH,
              },
            })
          ) {
            event.preventDefault();
          }
        }
      },
      [
        actions,
        editor,
        gapCursor,
        getFullMarkdown,
        id,
        index,
        onSetBlockText,
        onInsertGap,
        onNavigate,
        onDeleteBlock,
        read_only,
        searchHook,
        saveNow,
        setGapCursor,
        gapCursorRef,
      ],
    );

    const showGapBefore =
      gapCursor?.index === index && gapCursor.side === "before";
    const showGapAfter =
      gapCursor?.index === index && gapCursor.side === "after";
    const showBoundary = SHOW_BLOCK_BOUNDARIES && index > 0;

    return (
      <div
        ref={rowRef}
        style={{
          ...rowStyle,
          position: "relative",
          background: undefined,
          borderTop: showBoundary
            ? "1px dashed rgba(0, 0, 0, 0.12)"
            : undefined,
          paddingTop: showBoundary ? 12 : undefined,
          marginTop: showBoundary ? 12 : undefined,
        }}
        data-slate-block-index={index}
      >
        {showBoundary && (
          <div
            data-slate-block-boundary="true"
            style={{
              position: "absolute",
              top: -15,
              left: 10,
              fontSize: 10,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "rgba(0, 0, 0, 0.35)",
              pointerEvents: "none",
            }}
          >
            {`Page ${index + 1}`}
          </div>
        )}
        {selected && (
          <div
            data-slate-block-selection="true"
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: 0,
              right: 0,
              background: "rgba(24, 144, 255, 0.08)",
              pointerEvents: "none",
              zIndex: 1,
            }}
          />
        )}
        {gutterWidth > 0 && (
          <div
            data-slate-block-gutter="true"
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              bottom: 0,
              width: gutterWidth,
              cursor: "pointer",
              zIndex: 3,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderLeft: selected
                ? "3px solid rgba(24, 144, 255, 0.8)"
                : "3px solid transparent",
              background: selected ? "rgba(24, 144, 255, 0.12)" : "transparent",
            }}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onSelectBlock?.(index, { shiftKey: event.shiftKey });
            }}
          >
          </div>
        )}
        {USE_BLOCK_GAP_CURSOR && (
          <>
            <div
              data-slate-gap-cursor="block-hit-before"
              style={{
                position: "absolute",
                top: -6,
                left: 0,
                right: 0,
                height: 12,
                cursor: "text",
                zIndex: 1,
              }}
              onMouseDown={(event) => {
                event.preventDefault();
                setGapCursor({ index, side: "before" });
                ReactEditor.focus(editor);
              }}
            />
            {showGapBefore && (
              <div
                data-slate-gap-cursor="block-before"
                style={{
                  position: "absolute",
                  top:
                    activeGap?.path && gapCursorPos
                      ? gapCursorPos.top - 2
                      : -2,
                  left: 0,
                  right: 0,
                  height: 4,
                  background: "rgba(24, 144, 255, 0.25)",
                  borderRadius: 2,
                  pointerEvents: "none",
                  zIndex: 2,
                }}
              />
            )}
          </>
        )}
        <ChangeContext.Provider
          value={{
            change,
            editor: editor as any,
            blockNavigation: {
              setGapCursor: (side) => {
                if (USE_BLOCK_GAP_CURSOR) {
                  setGapCursor({ index, side });
                }
              },
            },
          }}
        >
          <Slate editor={editor} value={value} onChange={handleChange}>
            <Editable
              autoFocus={autoFocus}
              readOnly={read_only}
              renderElement={renderElement}
              renderLeaf={renderLeaf}
              decorate={decorate}
              onFocus={() => {
                onFocus?.();
              }}
              onBlur={onBlur}
              onKeyDown={handleKeyDown}
              style={{
                position: "relative",
                width: "100%",
                minWidth: "80%",
                padding: 0,
                background: "white",
                overflowX: "hidden",
              }}
            />
          </Slate>
        </ChangeContext.Provider>
        {USE_BLOCK_GAP_CURSOR && (
          <>
            {showGapAfter && (
              <div
                data-slate-gap-cursor="block-after"
                style={{
                  position: "absolute",
                  top:
                    activeGap?.path && gapCursorPos
                      ? gapCursorPos.bottom - 2
                      : undefined,
                  bottom:
                    activeGap?.path && gapCursorPos ? undefined : -2,
                  left: 0,
                  right: 0,
                  height: 4,
                  background: "rgba(24, 144, 255, 0.25)",
                  borderRadius: 2,
                  pointerEvents: "none",
                  zIndex: 2,
                }}
              />
            )}
            <div
              data-slate-gap-cursor="block-hit-after"
              style={{
                position: "absolute",
                bottom: -6,
                left: 0,
                right: 0,
                height: 12,
                cursor: "text",
                zIndex: 1,
              }}
              onMouseDown={(event) => {
                event.preventDefault();
                setGapCursor({ index, side: "after" });
                ReactEditor.focus(editor);
              }}
            />
          </>
        )}
      </div>
    );
  },
  (prev, next) => {
    const prevGap =
      prev.gapCursor?.index === prev.index ? prev.gapCursor.side : null;
    const nextGap =
      next.gapCursor?.index === next.index ? next.gapCursor.side : null;
    return (
      prev.markdown === next.markdown &&
      prev.read_only === next.read_only &&
      prevGap === nextGap &&
      prev.selected === next.selected &&
      prev.searchQuery === next.searchQuery
    );
  },
);
