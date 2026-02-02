/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Prototype: always-editable block editor for very large markdown documents.

import { debounce } from "lodash";
import React, {
  MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRedux } from "@cocalc/frontend/app-framework";
import {
  Descendant,
  DecoratedRange,
  Editor,
  Element as SlateElement,
  Node,
  Point,
  Range,
  Path,
  Text,
  Transforms,
  createEditor,
} from "slate";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { Editable, ReactEditor, Slate, withReact } from "./slate-react";
import type { RenderElementProps, RenderLeafProps } from "./slate-react";
import { markdown_to_slate } from "./markdown-to-slate";
import { slate_to_markdown } from "./slate-to-markdown";
import { withNormalize } from "./normalize";
import { withIsInline, withIsVoid } from "./plugins";
import { withAutoFormat } from "./format";
import { formatSelectedText } from "./format/commands";
import { withCodeLineInsertBreak } from "./elements/code-block/with-code-line-insert-break";
import { withInsertBreakHack } from "./elements/link/editable";
import { withNonfatalRange, withSelectionSafety } from "./patches";
import { Element } from "./element";
import Leaf from "./leaf";
import { Actions } from "./types";
import { SimpleInputMerge } from "../../../sync/editor/generic/simple-input-merge";
import { ChangeContext } from "./use-change";
import { getHandler as getKeyboardHandler } from "./keyboard";
import type { SearchHook } from "./search";
import { useSearch } from "./search";
import { isAtBeginningOfBlock, isAtEndOfBlock } from "./control";
import { pointAtPath } from "./slate-util";
import type { SlateEditor } from "./types";
import { IS_MACOS } from "./keyboard/register";
import { moveListItemDown, moveListItemUp } from "./format/list-move";
import { emptyParagraph, isWhitespaceParagraph } from "./padding";
import { ensureSlateDebug, logSlateDebug } from "./slate-utils/slate-debug";
import { remapSelectionInDocWithSentinels } from "./sync/block-diff";
import {
  findSlatePointNearMarkdownPosition,
  indexToPosition,
  markdownPositionToSlatePoint,
  nearestMarkdownIndexForSlatePoint,
  positionToIndex,
} from "./sync";
import {
  buildCodeBlockDecorations,
  getPrismGrammar,
} from "./elements/code-block/prism";
import type { CodeBlock } from "./elements/code-block/types";
import { EditBar, useLinkURL, useListProperties, useMarks } from "./edit-bar";
import { SlateHelpModal } from "./help-modal";

const DEFAULT_FONT_SIZE = 14;
const DEFAULT_SAVE_DEBOUNCE_MS = 750;
const BLOCK_CHUNK_TARGET_CHARS = 4000;
const SHOW_BLOCK_BOUNDARIES = true;
const BLOCK_DEFER_CHARS = 200_000;
const BLOCK_DEFER_MS = 300;

function getBlockChunkTargetChars(): number {
  if (typeof globalThis === "undefined") return BLOCK_CHUNK_TARGET_CHARS;
  const value = (globalThis as any).COCALC_SLATE_BLOCK_CHUNK_CHARS;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return BLOCK_CHUNK_TARGET_CHARS;
}

function getBlockDeferChars(): number {
  if (typeof globalThis === "undefined") return BLOCK_DEFER_CHARS;
  const value = (globalThis as any).COCALC_SLATE_BLOCK_DEFER_CHARS;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return BLOCK_DEFER_CHARS;
}

function getBlockDeferMs(): number {
  if (typeof globalThis === "undefined") return BLOCK_DEFER_MS;
  const value = (globalThis as any).COCALC_SLATE_BLOCK_DEFER_MS;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return BLOCK_DEFER_MS;
}

function debugSyncLog(type: string, data?: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  if (!(window as any).__slateDebugLog) return;
  ensureSlateDebug();
  logSlateDebug(`block-sync:${type}`, data);
  // eslint-disable-next-line no-console
  console.log(`[slate-sync:block] ${type}`, data ?? {});
}

function normalizePointForDoc(root: Node, point: { path: number[]; offset: number }, edge: "start" | "end") {
  try {
    const node = Node.get(root, point.path);
    if (Text.isText(node)) {
      return point;
    }
    return Editor[edge](root as any, point.path);
  } catch {
    return null;
  }
}

function pointFromOffsetInDoc(doc: Descendant[], offset: number): { path: number[]; offset: number } {
  let total = 0;
  let lastPath: Path | null = null;
  let lastLength = 0;
  const root = { children: doc } as Descendant;
  for (const [node, path] of Node.texts(root)) {
    const nextTotal = total + node.text.length;
    if (offset <= nextTotal) {
      return { path, offset: Math.max(0, offset - total) };
    }
    total = nextTotal;
    lastPath = path;
    lastLength = node.text.length;
  }
  if (lastPath) {
    return { path: lastPath, offset: lastLength };
  }
  return Editor.start({ children: doc } as any, [0]);
}

function blockSelectionPoint(
  editor: SlateEditor,
  position: "start" | "end",
): Point {
  try {
    const children = editor.children as Descendant[];
    const text = Node.string({ children } as any);
    const offset = position === "start" ? 0 : text.length;
    return pointFromOffsetInDoc(children, offset);
  } catch {
    // fall through to default point
  }
  const fallbackPath = position === "start" ? [0] : [0];
  return pointAtPath(editor, fallbackPath, undefined, position);
}

const USE_BLOCK_GAP_CURSOR = false;
const USE_BLOCK_CODE_SPACERS = false;
const EMPTY_SEARCH: SearchHook = {
  decorate: () => [],
  Search: null as any,
  search: "",
  previous: () => undefined,
  next: () => undefined,
  focus: () => undefined,
};

const BLOCK_EDIT_BAR_HEIGHT = 25;

const BlockEditBar: React.FC<{
  editor: SlateEditor | null;
  isCurrent: boolean;
  updateSignal: number;
  hideSearch?: boolean;
  onHelp?: () => void;
}> = ({ editor, isCurrent, updateSignal, hideSearch, onHelp }) => {
  if (!editor) {
    return (
      <div
        style={{
          borderBottom: isCurrent
            ? "1px solid lightgray"
            : "1px solid transparent",
          height: BLOCK_EDIT_BAR_HEIGHT,
        }}
      />
    );
  }
  const search = useSearch({ editor });
  const { marks, updateMarks } = useMarks(editor);
  const { linkURL, updateLinkURL } = useLinkURL(editor);
  const { listProperties, updateListProperties } = useListProperties(editor);

  useEffect(() => {
    updateMarks();
    updateLinkURL();
    updateListProperties();
  }, [updateSignal, updateMarks, updateLinkURL, updateListProperties]);

  return (
    <EditBar
      Search={search?.Search ?? EMPTY_SEARCH.Search}
      isCurrent={isCurrent}
      marks={marks}
      linkURL={linkURL}
      listProperties={listProperties}
      editor={editor}
      hideSearch={hideSearch}
      onHelp={onHelp}
    />
  );
};

function stripTrailingNewlines(markdown: string): string {
  return markdown.replace(/\n+$/g, "");
}

function normalizeBlockMarkdown(markdown: string): string {
  return stripTrailingNewlines(markdown);
}

function joinBlocks(blocks: string[]): string {
  const cleaned = blocks.map((block) => normalizeBlockMarkdown(block));
  return cleaned.join("\n\n");
}

function globalIndexForBlockOffset(
  blocks: string[],
  blockIndex: number,
  offset: number,
): number {
  let index = 0;
  const last = blocks.length - 1;
  for (let i = 0; i < blocks.length; i++) {
    const block = normalizeBlockMarkdown(blocks[i] ?? "");
    const blockLen = block.length;
    if (i === blockIndex) {
      const clamped = Math.max(0, Math.min(offset, blockLen));
      return index + clamped;
    }
    index += blockLen;
    if (i < last) {
      index += 2; // separator \n\n
    }
  }
  return index;
}

function blockOffsetForGlobalIndex(
  blocks: string[],
  globalIndex: number,
): { index: number; offset: number } {
  const safeIndex = Math.max(0, globalIndex);
  let cursor = 0;
  const last = blocks.length - 1;
  for (let i = 0; i < blocks.length; i++) {
    const block = normalizeBlockMarkdown(blocks[i] ?? "");
    const blockLen = block.length;
    const blockEnd = cursor + blockLen;
    if (safeIndex <= blockEnd) {
      return { index: i, offset: Math.max(0, safeIndex - cursor) };
    }
    cursor = blockEnd;
    if (i < last) {
      const separatorEnd = cursor + 2;
      if (safeIndex <= separatorEnd) {
        return { index: i + 1, offset: 0 };
      }
      cursor = separatorEnd;
    }
  }
  if (blocks.length === 0) {
    return { index: 0, offset: 0 };
  }
  const lastBlock = normalizeBlockMarkdown(blocks[last] ?? "");
  return { index: last, offset: lastBlock.length };
}

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

export const __test__ = {
  splitMarkdownToBlocks,
  splitMarkdownToBlocksIncremental,
  computeIncrementalSlices,
};

function stripTrailingBlankParagraphs(value: Descendant[]): Descendant[] {
  if (value.length <= 1) return value;
  let end = value.length;
  while (end > 1 && isBlankParagraph(value[end - 1])) {
    end -= 1;
  }
  if (end === value.length) return value;
  return value.slice(0, end);
}

function isParagraphNode(node: Descendant | undefined): boolean {
  return node != null && node["type"] === "paragraph";
}

function isVoidBlockNode(node: Descendant | undefined): boolean {
  if (!node || typeof node !== "object") return false;
  return (node as any).isVoid === true;
}

function spacerParagraph(): Descendant {
  return {
    type: "paragraph",
    spacer: true,
    children: [{ text: "" }],
  } as Descendant;
}

function withCodeBlockSpacers(value: Descendant[]): Descendant[] {
  const next: Descendant[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const node = value[i];
    if (node?.["type"] === "code_block" || isVoidBlockNode(node)) {
      const prev = next[next.length - 1];
      if (!isParagraphNode(prev)) {
        next.push(spacerParagraph());
      }
      next.push(node);
      const nextNode = value[i + 1];
      if (!isParagraphNode(nextNode)) {
        next.push(spacerParagraph());
      }
      continue;
    }
    next.push(node);
  }
  return next.length === value.length ? value : next;
}

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

function splitMarkdownToBlocks(markdown: string): string[] {
  if (!markdown) return [""];
  const cache: { [node: string]: string } = {};
  const doc = markdown_to_slate(markdown, false, cache);
  const filtered = doc.filter(
    (node) => !(node?.["type"] === "paragraph" && node?.["blank"] === true),
  );
  if (filtered.length === 0) return [""];
  const nodeMarkdown = filtered.map((node) => {
    if (SlateElement.isElement(node) && node.type === "code_block") {
      const info = (node as any).info ? String((node as any).info).trim() : "";
      const lines = Array.isArray(node.children)
        ? node.children.map((child) => Node.string(child))
        : [];
      const fence = "```" + info;
      return normalizeBlockMarkdown([fence, ...lines, "```"].join("\n"));
    }
    return normalizeBlockMarkdown(
      slate_to_markdown([node], { cache, preserveBlankLines: false }),
    );
  });
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLength = 0;
  const targetChars = getBlockChunkTargetChars();
  const flush = () => {
    if (current.length === 0) return;
    chunks.push(current.join("\n\n"));
    current = [];
    currentLength = 0;
  };
  for (const block of nodeMarkdown) {
    const blockLength = block.length;
    const nextLength =
      currentLength === 0 ? blockLength : currentLength + 2 + blockLength;
    if (
      current.length > 0 &&
      nextLength > targetChars
    ) {
      flush();
    }
    current.push(block);
    currentLength =
      currentLength === 0 ? blockLength : currentLength + 2 + blockLength;
  }
  flush();
  const result = chunks.length > 0 ? chunks : [""];
  return result;
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) {
    i += 1;
  }
  return i;
}

function commonSuffixLength(a: string, b: string, prefix: number): number {
  const max = Math.min(a.length, b.length) - prefix;
  let i = 0;
  while (
    i < max &&
    a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)
  ) {
    i += 1;
  }
  return i;
}

type IncrementalSlices = {
  prefixBlocks: string[];
  suffixBlocks: string[];
  middleText: string;
};

function computeIncrementalSlices(
  prevMarkdown: string,
  nextMarkdown: string,
  prevBlocks: string[],
): IncrementalSlices | null {
  const prefix = commonPrefixLength(prevMarkdown, nextMarkdown);
  const suffix = commonSuffixLength(prevMarkdown, nextMarkdown, prefix);
  const oldLength = prevMarkdown.length;
  const suffixStartOld = oldLength - suffix;

  let prefixIndex = 0;
  let prefixOffset = 0;
  for (let i = 0; i < prevBlocks.length; i += 1) {
    const blockLen = prevBlocks[i].length;
    const sep = i < prevBlocks.length - 1 ? 2 : 0;
    const nextOffset = prefixOffset + blockLen + sep;
    if (prefix >= nextOffset) {
      prefixOffset = nextOffset;
      prefixIndex = i + 1;
      continue;
    }
    break;
  }

  let suffixIndex = prevBlocks.length;
  let suffixStartOffset = oldLength;
  let offset = 0;
  for (let i = 0; i < prevBlocks.length; i += 1) {
    const blockLen = prevBlocks[i].length;
    const sep = i < prevBlocks.length - 1 ? 2 : 0;
    const nextOffset = offset + blockLen + sep;
    if (suffixStartOld <= offset) {
      suffixIndex = i;
      suffixStartOffset = offset;
      break;
    }
    if (suffixStartOld < nextOffset) {
      suffixIndex = i + 1;
      suffixStartOffset = nextOffset;
      break;
    }
    offset = nextOffset;
  }
  if (suffixIndex >= prevBlocks.length) {
    suffixStartOffset = oldLength;
  }

  const prefixBlocks = prefixIndex > 0 ? prevBlocks.slice(0, prefixIndex) : [];
  const suffixBlocks =
    suffixIndex < prevBlocks.length ? prevBlocks.slice(suffixIndex) : [];
  const suffixReuseLen = Math.max(0, oldLength - suffixStartOffset);
  const middleStart = prefixOffset;
  const middleEnd = nextMarkdown.length - suffixReuseLen;

  if (middleStart < 0 || middleEnd < middleStart) {
    return null;
  }

  const middleText = nextMarkdown.slice(middleStart, middleEnd);
  return { prefixBlocks, suffixBlocks, middleText };
}

function splitMarkdownToBlocksIncremental(
  prevMarkdown: string,
  nextMarkdown: string,
  prevBlocks: string[],
): string[] {
  if (!prevMarkdown) return splitMarkdownToBlocks(nextMarkdown);
  if (prevBlocks.length === 0) return splitMarkdownToBlocks(nextMarkdown);
  if (prevMarkdown === nextMarkdown) return prevBlocks;
  const slices = computeIncrementalSlices(
    prevMarkdown,
    nextMarkdown,
    prevBlocks,
  );
  if (!slices) {
    return splitMarkdownToBlocks(nextMarkdown);
  }
  const { prefixBlocks, suffixBlocks, middleText } = slices;
  const middleBlocks =
    middleText.length > 0 ? splitMarkdownToBlocks(middleText) : [];
  const nextBlocks = [...prefixBlocks, ...middleBlocks, ...suffixBlocks];
  return nextBlocks.length > 0 ? nextBlocks : [""];
}

interface BlockRowEditorProps {
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
}

type PendingSelection =
  | { index: number; offset: number; mode: "text" }
  | { index: number; pos: { line: number; ch: number }; mode: "markdown" };

const BlockRowEditor: React.FC<BlockRowEditorProps> = React.memo(
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
        } else {
          point = pointFromOffsetInDoc(nextValue, pendingSelection.offset);
        }
        if (point) {
          editor.selection = { anchor: point, focus: point };
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
        if (!Text.isText(node)) return [];
        const lineEntry = Editor.above(editor, {
          at: path,
          match: (n) =>
            SlateElement.isElement(n) && n.type === "code_line",
        });
        if (!lineEntry) return [];
        const blockEntry = Editor.above(editor, {
          at: path,
          match: (n) =>
            SlateElement.isElement(n) &&
            (n.type === "code_block" ||
              n.type === "html_block" ||
              n.type === "meta"),
        });
        if (!blockEntry) return [];
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
        if (!cached || cached.text !== text || cached.info !== info) {
          if (getPrismGrammar(info, text)) {
            cache.set(block, {
              text,
              info,
              decorations: buildCodeBlockDecorations(block as CodeBlock, blockPath, info),
            });
          } else {
            cache.set(block, { text, info, decorations: [] });
          }
        }
        return cache.get(block)?.decorations?.[lineIndex] ?? [];
      },
      [editor],
    );

    const handleChange = useCallback(
      (newValue: Descendant[]) => {
        if (read_only) return;
        onEditorChange?.(index);
        setValue(newValue);
        setChange((prev) => prev + 1);
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
              extra: { actions: actions ?? {}, id: id ?? "", search: EMPTY_SEARCH },
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
      prev.selected === next.selected
    );
  },
);

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

  const nextBlockIdRef = useRef<number>(1);
  const newBlockId = useCallback(
    () => `b${nextBlockIdRef.current++}`,
    [],
  );
  const [blocks, setBlocks] = useState<string[]>(() =>
    splitMarkdownToBlocks(initialValue),
  );
  const blocksRef = useRef<string[]>(blocks);
  const [blockIds, setBlockIds] = useState<string[]>(() =>
    blocks.map(() => newBlockId()),
  );
  const blockIdsRef = useRef<string[]>(blockIds);
  const remoteVersionRef = useRef<number[]>(blocks.map(() => 0));
  const syncRemoteVersionLength = useCallback((nextBlocks: string[]) => {
    const prevVersions = remoteVersionRef.current;
    if (prevVersions.length === nextBlocks.length) return;
    remoteVersionRef.current = nextBlocks.map((_, idx) => prevVersions[idx] ?? 0);
  }, []);
  const bumpRemoteVersionAt = useCallback((index: number, length: number) => {
    const prevVersions = remoteVersionRef.current;
    const next = [...prevVersions];
    while (next.length < length) {
      next.push(0);
    }
    next[index] = (next[index] ?? 0) + 1;
    remoteVersionRef.current = next;
  }, []);
  useEffect(() => {
    blocksRef.current = blocks;
  }, [blocks]);
  useEffect(() => {
    blockIdsRef.current = blockIds;
  }, [blockIds]);

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

  const editorMapRef = useRef<Map<number, SlateEditor>>(new Map());
  const codeBlockExpandStateRef = useRef<Map<string, boolean>>(new Map());
  const pendingFocusRef = useRef<{
    index: number;
    position: "start" | "end";
  } | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);

  const lastSetValueRef = useRef<string | null>(null);
  const pendingRemoteRef = useRef<string | null>(null);
  const pendingRemoteTimerRef = useRef<number | null>(null);
  const mergeHelperRef = useRef<SimpleInputMerge>(
    new SimpleInputMerge(initialValue),
  );
  const lastLocalEditAtRef = useRef<number>(0);
  const lastRemoteMergeAtRef = useRef<number>(0);
  const remoteMergeConfig =
    typeof window === "undefined"
      ? {}
      : ((window as any).COCALC_SLATE_REMOTE_MERGE ?? {});
  const ignoreRemoteWhileFocused = false;
  const mergeIdleMs =
    remoteMergeConfig.idleMs ??
    remoteMergeIdleMs ??
    saveDebounceMs ??
    DEFAULT_SAVE_DEBOUNCE_MS;
  const mergeIdleMsRef = useRef<number>(mergeIdleMs);
  mergeIdleMsRef.current = mergeIdleMs;
  const [pendingRemoteIndicator, setPendingRemoteIndicator] =
    useState<boolean>(false);
  const allowFocusedValueUpdateRef = useRef<boolean>(false);

  const updatePendingRemoteIndicator = useCallback(
    (remote: string, local: string) => {
      const preview = mergeHelperRef.current.previewMerge({ remote, local });
      debugSyncLog("pending-indicator:preview", {
        changed: preview.changed,
        remoteLength: remote.length,
        localLength: local.length,
      });
      if (!preview.changed) {
        pendingRemoteRef.current = null;
        mergeHelperRef.current.noteApplied(preview.merged);
      } else {
        pendingRemoteRef.current = remote;
      }
      setPendingRemoteIndicator((prev) =>
        prev === preview.changed ? prev : preview.changed,
      );
      return preview.changed;
    },
    [],
  );

  const bumpRemoteVersions = useCallback((nextBlocks: string[]) => {
    const prevBlocks = blocksRef.current;
    const prevVersions = remoteVersionRef.current;
    if (nextBlocks.length !== prevBlocks.length) {
      remoteVersionRef.current = nextBlocks.map(
        (_, idx) => (prevVersions[idx] ?? 0) + 1,
      );
      return;
    }
    const nextVersions = nextBlocks.map((block, idx) => {
      if (block !== prevBlocks[idx]) return (prevVersions[idx] ?? 0) + 1;
      return prevVersions[idx] ?? 0;
    });
    remoteVersionRef.current = nextVersions;
  }, []);

  const updateBlockIdsForRemote = useCallback(
    (nextBlocks: string[]) => {
      const prevBlocks = blocksRef.current;
      const prevIds = blockIdsRef.current;
      const nextIds = nextBlocks.map((block, idx) => {
        if (prevBlocks[idx] === block) {
          return prevIds[idx] ?? newBlockId();
        }
        return newBlockId();
      });
      blockIdsRef.current = nextIds;
      setBlockIds(nextIds);
    },
    [newBlockId],
  );

  const setBlocksFromValue = useCallback((markdown: string) => {
    if (markdown === valueRef.current && blocksRef.current.length > 0) {
      return;
    }
    const prevMarkdown = valueRef.current ?? "";
    const prevBlocks = blocksRef.current;
    valueRef.current = markdown;
    const nextBlocks =
      prevBlocks.length > 0 && prevMarkdown.length > 0
        ? splitMarkdownToBlocksIncremental(prevMarkdown, markdown, prevBlocks)
        : splitMarkdownToBlocks(markdown);
    bumpRemoteVersions(nextBlocks);
    blocksRef.current = nextBlocks;
    setBlocks(nextBlocks);
    updateBlockIdsForRemote(nextBlocks);
  }, [bumpRemoteVersions, updateBlockIdsForRemote]);

  const pendingValueRef = useRef<string | null>(null);
  const pendingValueTimerRef = useRef<number | null>(null);

  const flushPendingValue = useCallback(() => {
    if (pendingValueTimerRef.current != null) {
      window.clearTimeout(pendingValueTimerRef.current);
      pendingValueTimerRef.current = null;
    }
    const pending = pendingValueRef.current;
    if (pending == null) return;
    pendingValueRef.current = null;
    setBlocksFromValue(pending);
  }, [setBlocksFromValue]);

  const schedulePendingValue = useCallback(
    (markdown: string) => {
      pendingValueRef.current = markdown;
      if (pendingValueTimerRef.current != null) {
        window.clearTimeout(pendingValueTimerRef.current);
      }
      const delay = getBlockDeferMs();
      pendingValueTimerRef.current = window.setTimeout(() => {
        pendingValueTimerRef.current = null;
        flushPendingValue();
      }, delay);
    },
    [flushPendingValue],
  );

  const applyBlocksFromValue = useCallback(
    (markdown: string) => {
      if (markdown === valueRef.current && blocksRef.current.length > 0) {
        return;
      }
      const deferChars = getBlockDeferChars();
      if (focusedIndex == null && markdown.length >= deferChars) {
        schedulePendingValue(markdown);
        return;
      }
      flushPendingValue();
      setBlocksFromValue(markdown);
    },
    [focusedIndex, flushPendingValue, schedulePendingValue, setBlocksFromValue],
  );

  const getFullMarkdown = useCallback(() => joinBlocks(blocksRef.current), []);

  useEffect(() => {
    if (getValueRef == null) return;
    getValueRef.current = getFullMarkdown;
  }, [getValueRef, getFullMarkdown]);

  useEffect(() => {
    const nextValue = value ?? "";
    debugSyncLog("value-prop", {
      focusedIndex,
      sameAsLastSet: nextValue === lastSetValueRef.current,
      sameAsValueRef: nextValue === valueRef.current,
      pendingRemote: pendingRemoteRef.current != null,
    });
    if (nextValue === lastSetValueRef.current) {
      lastSetValueRef.current = null;
      return;
    }
    if (nextValue === valueRef.current) return;
    const allowFocusedValueUpdate = allowFocusedValueUpdateRef.current;
    if (
      ignoreRemoteWhileFocused &&
      focusedIndex != null &&
      !allowFocusedValueUpdate
    ) {
      debugSyncLog("value-prop:defer-focused", {
        focusedIndex,
      });
      updatePendingRemoteIndicator(nextValue, joinBlocks(blocksRef.current));
      return;
    }
    allowFocusedValueUpdateRef.current = false;
    if (pendingRemoteRef.current != null) return;
    applyBlocksFromValue(nextValue);
  }, [
    value,
    focusedIndex,
    ignoreRemoteWhileFocused,
    applyBlocksFromValue,
    updatePendingRemoteIndicator,
  ]);

  useEffect(() => {
    if (focusedIndex != null) {
      flushPendingValue();
    }
  }, [focusedIndex, flushPendingValue]);

  function shouldDeferRemoteMerge(): boolean {
    const idleMs = mergeIdleMsRef.current;
    return Date.now() - lastLocalEditAtRef.current < idleMs;
  }

  function schedulePendingRemoteMerge() {
    if (pendingRemoteTimerRef.current != null) {
      window.clearTimeout(pendingRemoteTimerRef.current);
    }
    const idleMs = mergeIdleMsRef.current;
    debugSyncLog("pending-remote:schedule", { idleMs });
    pendingRemoteTimerRef.current = window.setTimeout(() => {
      pendingRemoteTimerRef.current = null;
      flushPendingRemoteMerge();
    }, idleMs);
  }

  function flushPendingRemoteMerge(force = false) {
    const pending = pendingRemoteRef.current;
    if (pending == null) return;
    if (!force && shouldDeferRemoteMerge()) {
      debugSyncLog("pending-remote:defer", {
        idleMs: mergeIdleMsRef.current,
      });
      schedulePendingRemoteMerge();
      return;
    }
    debugSyncLog("pending-remote:flush", { force });
    pendingRemoteRef.current = null;
    setPendingRemoteIndicator(false);
    lastRemoteMergeAtRef.current = Date.now();
    mergeHelperRef.current.handleRemote({
      remote: pending,
      getLocal: () => joinBlocks(blocksRef.current),
      applyMerged: applyBlocksFromValue,
    });
  }

  useEffect(() => {
    return () => {
      if (pendingRemoteTimerRef.current != null) {
        window.clearTimeout(pendingRemoteTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (actions._syncstring == null) return;
    const change = () => {
      const remote = actions._syncstring?.to_str() ?? "";
      debugSyncLog("syncstring:change", {
        focusedIndex,
        remoteLength: remote.length,
        shouldDefer: shouldDeferRemoteMerge(),
      });
      if (ignoreRemoteWhileFocused && focusedIndex != null) {
        updatePendingRemoteIndicator(remote, joinBlocks(blocksRef.current));
        return;
      }
      if (shouldDeferRemoteMerge()) {
        pendingRemoteRef.current = remote;
        schedulePendingRemoteMerge();
        return;
      }
      debugSyncLog("syncstring:apply", { remoteLength: remote.length });
      lastRemoteMergeAtRef.current = Date.now();
      mergeHelperRef.current.handleRemote({
        remote,
        getLocal: () => joinBlocks(blocksRef.current),
        applyMerged: applyBlocksFromValue,
      });
    };
    actions._syncstring.on("change", change);
    return () => {
      actions._syncstring?.removeListener("change", change);
    };
  }, [actions, focusedIndex, ignoreRemoteWhileFocused, applyBlocksFromValue, updatePendingRemoteIndicator]);

  useEffect(() => {
    if (!ignoreRemoteWhileFocused) return;
    if (focusedIndex == null) {
      flushPendingRemoteMerge(true);
    }
  }, [focusedIndex, ignoreRemoteWhileFocused]);

  const saveBlocksNow = useCallback(() => {
    if (actions.set_value == null) return;
    const markdown = joinBlocks(blocksRef.current);
    if (markdown === valueRef.current) return;
    lastSetValueRef.current = markdown;
    valueRef.current = markdown;
    mergeHelperRef.current.noteSaved(markdown);
    actions.set_value(markdown);
    actions.syncstring_commit?.();
  }, [actions]);

  const saveBlocksDebounced = useMemo(
    () => debounce(saveBlocksNow, saveDebounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS),
    [saveBlocksNow, saveDebounceMs],
  );

  const handleBlockChange = useCallback(
    (index: number, markdown: string) => {
      if (read_only) return;
      lastLocalEditAtRef.current = Date.now();
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
      if (
        ignoreRemoteWhileFocused &&
        focusedIndex != null &&
        pendingRemoteRef.current != null
      ) {
        updatePendingRemoteIndicator(
          pendingRemoteRef.current,
          joinBlocks(blocksRef.current),
        );
      }
    },
    [
      focusedIndex,
      ignoreRemoteWhileFocused,
      is_current,
      read_only,
      saveBlocksDebounced,
      newBlockId,
      syncRemoteVersionLength,
      updatePendingRemoteIndicator,
    ],
  );

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
    [],
  );

  const tryApplySelectionAtOffset = useCallback(
    (index: number, offset: number) => {
      if (index < 0 || index >= blocksRef.current.length) return false;
      const editor = editorMapRef.current.get(index);
      if (!editor) return false;
      const point = pointFromOffsetInDoc(editor.children as Descendant[], offset);
      ReactEditor.focus(editor);
      Transforms.setSelection(editor, { anchor: point, focus: point });
      setFocusedIndex(index);
      return true;
    },
    [],
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
    [tryApplySelectionAtOffset],
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
      ReactEditor.focus(editor);
      Transforms.setSelection(editor, { anchor: point, focus: point });
      setFocusedIndex(target.index);
      return true;
    },
    [],
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
  }, [focusedIndex]);


  useEffect(() => {
    if (blockControlRef == null) return;
    blockControlRef.current = {
      ...(blockControlRef.current ?? {}),
      allowNextValueUpdateWhileFocused: () => {
        allowFocusedValueUpdateRef.current = true;
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
    blockControlRef,
    focusBlock,
    focusedIndex,
    getMarkdownPositionForSelection,
    id,
    setBlocksFromValue,
    setSelectionFromMarkdownPosition,
  ]);

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
    [focusBlock],
  );

  const unregisterEditor = useCallback((index: number, editor: SlateEditor) => {
    const current = editorMapRef.current.get(index);
    if (current === editor) {
      editorMapRef.current.delete(index);
    }
  }, []);

  useEffect(() => {
    if (focusedIndex != null) {
      setLastFocusedIndex(focusedIndex);
    }
    setActiveEditorSignal((prev) => prev + 1);
  }, [focusedIndex]);

  const handleActiveEditorChange = useCallback(
    (index: number) => {
      if (index !== focusedIndex) return;
      setActiveEditorSignal((prev) => prev + 1);
    },
    [focusedIndex],
  );

  const insertBlockAtGap = useCallback(
    (
      gap: { index: number; side: "before" | "after" },
      initialText?: string,
      focusPosition?: "start" | "end",
    ) => {
      const insertIndex = gap.side === "before" ? gap.index : gap.index + 1;
      lastLocalEditAtRef.current = Date.now();
      setGapCursorState(null);
      setBlocks((prev) => {
        const next = [...prev];
        next.splice(insertIndex, 0, initialText ?? "");
        blocksRef.current = next;
        return next;
      });
      setBlockIds((prev) => {
        const next = [...prev];
        next.splice(insertIndex, 0, newBlockId());
        blockIdsRef.current = next;
        return next;
      });
      syncRemoteVersionLength(blocksRef.current);
      if (is_current) saveBlocksDebounced();
      const position: "start" | "end" =
        focusPosition ?? (initialText ? "end" : "start");
      pendingFocusRef.current = {
        index: insertIndex,
        position,
      };
      virtuosoRef.current?.scrollToIndex({
        index: insertIndex,
        align: "center",
      });
    },
    [is_current, newBlockId, saveBlocksDebounced, syncRemoteVersionLength],
  );

  const setBlockText = useCallback(
    (index: number, text: string) => {
      if (index < 0) return;
      lastLocalEditAtRef.current = Date.now();
      skipSelectionResetRef.current.add(index);
      setBlocks((prev) => {
        const next = [...prev];
        while (next.length <= index) {
          next.push("");
        }
        next[index] = text;
        blocksRef.current = next;
        bumpRemoteVersionAt(index, next.length);
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
      bumpRemoteVersionAt,
      is_current,
      newBlockId,
      saveBlocksDebounced,
      syncRemoteVersionLength,
    ],
  );

  const deleteBlockAtIndex = useCallback(
    (index: number, opts?: { focus?: boolean }) => {
      if (index < 0 || index >= blocksRef.current.length) return;
      if (blocksRef.current.length === 1) return;
      lastLocalEditAtRef.current = Date.now();
      setGapCursorState(null);
      setBlocks((prev) => {
        const next = [...prev];
        next.splice(index, 1);
        blocksRef.current = next;
        return next;
      });
      setBlockIds((prev) => {
        const next = [...prev];
        next.splice(index, 1);
        blockIdsRef.current = next;
        return next;
      });
      syncRemoteVersionLength(blocksRef.current);
      if (is_current) saveBlocksDebounced();
      if (opts?.focus === false) return;
      const targetIndex = Math.max(0, index - 1);
      pendingFocusRef.current = { index: targetIndex, position: "end" };
      virtuosoRef.current?.scrollToIndex({ index: targetIndex, align: "center" });
    },
    [
      is_current,
      saveBlocksDebounced,
      setGapCursorState,
      syncRemoteVersionLength,
    ],
  );

  const mergeWithPreviousBlock = useCallback(
    (index: number) => {
      if (index <= 0) return;
      const prevEditor = editorMapRef.current.get(index - 1);
      const currEditor = editorMapRef.current.get(index);
      if (!prevEditor || !currEditor) return;

      lastLocalEditAtRef.current = Date.now();
      setGapCursorState(null);

      const insertIndex = prevEditor.children.length;
      const insertPath: Path = [insertIndex];
      const mergeOffset = (blocksRef.current[index - 1] ?? "").length;
      const boundaryPoint = (() => {
        const texts = Array.from(Node.texts(prevEditor));
        for (let i = texts.length - 1; i >= 0; i -= 1) {
          const [node, path] = texts[i];
          if (node.text.length > 0) {
            return { path, offset: node.text.length };
          }
        }
        return Editor.end(prevEditor, Path.previous(insertPath));
      })();
      const boundaryRef = Editor.pointRef(prevEditor, boundaryPoint, {
        affinity: "backward",
      });
      pendingSelectionRef.current = {
        index: index - 1,
        offset: mergeOffset,
        mode: "text",
      };
      const inserted = currEditor.children.map((node) =>
        JSON.parse(JSON.stringify(node)),
      );
      try {
        Transforms.setSelection(prevEditor, {
          anchor: boundaryPoint,
          focus: boundaryPoint,
        });
        Transforms.insertFragment(prevEditor, inserted);
        const point = boundaryRef.current;
        if (point) {
          Transforms.setSelection(prevEditor, { anchor: point, focus: point });
        }
        ReactEditor.focus(prevEditor);
        setFocusedIndex(index - 1);
      } catch {
        // If we cannot merge, leave selection unchanged.
      } finally {
        boundaryRef.unref();
      }

      deleteBlockAtIndex(index, { focus: false });
      if (typeof window !== "undefined") {
        window.setTimeout(() => {
          setSelectionAtOffset(index - 1, mergeOffset);
        }, 0);
      } else {
        setSelectionAtOffset(index - 1, mergeOffset);
      }
    },
    [deleteBlockAtIndex, setGapCursorState, setSelectionAtOffset],
  );

  const selectionRange = useMemo(() => {
    if (!blockSelection) return null;
    const start = Math.min(blockSelection.anchor, blockSelection.focus);
    const end = Math.max(blockSelection.anchor, blockSelection.focus);
    return { start, end };
  }, [blockSelection]);

  useEffect(() => {
    blockSelectionRef.current = blockSelection;
  }, [blockSelection]);

  const clearBlockSelection = useCallback(() => {
    if (!blockSelectionRef.current) return;
    blockSelectionRef.current = null;
    setBlockSelection(null);
  }, []);

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
    [focusedIndex],
  );

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

  const getSelectedBlocks = useCallback(() => {
    if (!selectionRange) return [];
    return blocksRef.current.slice(
      selectionRange.start,
      selectionRange.end + 1,
    );
  }, [selectionRange]);

  const setSelectionToRange = useCallback(
    (start: number, end: number) => {
      setBlockSelection({ anchor: start, focus: end });
    },
    [],
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
    is_current,
    saveBlocksDebounced,
    setSelectionToRange,
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
    [selectionRange, is_current, saveBlocksDebounced, setSelectionToRange],
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
      is_current,
      saveBlocksDebounced,
      setSelectionToRange,
      setGapCursorState,
    ],
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
  const hideSearch = true;

  const renderBlock = (index: number) => {
    const markdown = blocks[index] ?? "";
    const remoteVersion = remoteVersionRef.current[index] ?? 0;
    const isSelected =
      selectionRange != null &&
      index >= selectionRange.start &&
      index <= selectionRange.end;
    return (
      <BlockRowEditor
        index={index}
        markdown={markdown}
        remoteVersion={remoteVersion}
        isFocused={focusedIndex === index}
        clearBlockSelection={clearBlockSelection}
        onMergeWithPrevious={mergeWithPreviousBlock}
        lastLocalEditAtRef={lastLocalEditAtRef}
        lastRemoteMergeAtRef={lastRemoteMergeAtRef}
        onChangeMarkdown={handleBlockChange}
        onDeleteBlock={deleteBlockAtIndex}
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
        id={props.id}
        rowStyle={rowStyle}
        gapCursor={gapCursor}
        setGapCursor={setGapCursorState}
        gapCursorRef={gapCursorRef}
        pendingGapInsertRef={pendingGapInsertRef}
        pendingSelectionRef={pendingSelectionRef}
        skipSelectionResetRef={skipSelectionResetRef}
        onNavigate={focusBlock}
        onInsertGap={insertBlockAtGap}
        onSetBlockText={setBlockText}
        preserveBlankLines={preserveBlankLines}
        saveNow={saveBlocksNow}
        registerEditor={registerEditor}
        unregisterEditor={unregisterEditor}
        onEditorChange={handleActiveEditorChange}
        getFullMarkdown={getFullMarkdown}
        codeBlockExpandState={codeBlockExpandStateRef.current}
        blockCount={blocks.length}
        selected={isSelected}
        gutterWidth={gutterWidth}
        leafComponent={leafComponentResolved}
      />
    );
  };

  return (
    <div
      ref={setContainerRef}
      className={noVfill || height === "auto" ? undefined : "smc-vfill"}
      tabIndex={-1}
      onMouseDownCapture={(event) => {
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
      }}
      onKeyDownCapture={(event) => {
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
      }}
      onCopyCapture={(event) => {
        if (!selectionRange) return;
        const text = joinBlocks(getSelectedBlocks());
        if (event.clipboardData) {
          event.preventDefault();
          event.clipboardData.setData("text/plain", text);
          event.clipboardData.setData("text/markdown", text);
        }
      }}
      onCutCapture={(event) => {
        if (!selectionRange) return;
        const text = joinBlocks(getSelectedBlocks());
        if (event.clipboardData) {
          event.preventDefault();
          event.clipboardData.setData("text/plain", text);
          event.clipboardData.setData("text/markdown", text);
          deleteSelectedBlocks();
        }
      }}
      onPasteCapture={(event) => {
        if (!selectionRange) return;
        const markdown =
          event.clipboardData?.getData("text/markdown") ||
          event.clipboardData?.getData("text/plain");
        if (!markdown) return;
        event.preventDefault();
        insertBlocksAfterSelection(markdown);
      }}
      style={{
        overflow: noVfill || height === "auto" ? undefined : "auto",
        backgroundColor: "white",
        ...style,
        height,
        minHeight: height === "auto" ? "50px" : undefined,
        position: "relative",
      }}
    >
      <BlockEditBar
        key={editBarKey}
        editor={activeEditor ?? null}
        isCurrent={!!is_current}
        updateSignal={activeEditorSignal}
        hideSearch={hideSearch}
        onHelp={() => actions0?.setState?.({ show_slate_help: true })}
      />
      <SlateHelpModal
        open={!!showHelpModal}
        onClose={() => actions0?.setState?.({ show_slate_help: false })}
      />
      {!hidePath && renderPath}
      {showPendingRemoteIndicator && (
        <div
          role="button"
          tabIndex={0}
          onMouseDown={handleMergePending}
          onClick={handleMergePending}
          style={{
            position: "absolute",
            top: hidePath ? 6 : 30,
            right: 8,
            fontSize: 12,
            padding: "2px 8px",
            background: "rgba(255, 251, 230, 0.95)",
            border: "1px solid rgba(255, 229, 143, 0.9)",
            borderRadius: 4,
            color: "#8c6d1f",
            cursor: "pointer",
            zIndex: 3,
          }}
        >
          Remote changes pending
        </div>
      )}
      <div
        className={noVfill || height === "auto" ? undefined : "smc-vfill"}
        style={{
          width: "100%",
          fontSize: font_size,
          height,
        }}
      >
        {disableVirtualization ? (
          <div>
            {blocks.map((_, index) => (
              <React.Fragment key={blockIds[index] ?? index}>
                {renderBlock(index)}
              </React.Fragment>
            ))}
          </div>
        ) : (
          <Virtuoso
            className="smc-vfill"
            totalCount={blocks.length}
            itemContent={(index) => renderBlock(index)}
            computeItemKey={(index) => blockIds[index] ?? index}
            ref={virtuosoRef}
          />
        )}
      </div>
    </div>
  );
}
