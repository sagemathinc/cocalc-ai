/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Prototype: always-editable block editor for very large markdown documents.

import { debounce } from "lodash";
import {
  MutableRefObject,
  RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CSS, React } from "@cocalc/frontend/app-framework";
import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";
import { Path } from "@cocalc/frontend/frame-editors/frame-tree/path";
import { DEFAULT_FONT_SIZE } from "@cocalc/util/consts/ui";
import { SAVE_DEBOUNCE_MS } from "@cocalc/frontend/frame-editors/code-editor/const";
import { Descendant, Range, Transforms, createEditor } from "slate";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { Editable, ReactEditor, Slate, withReact } from "./slate-react";
import type { RenderElementProps } from "./slate-react";
import { markdown_to_slate } from "./markdown-to-slate";
import { slate_to_markdown } from "./slate-to-markdown";
import { withNormalize } from "./normalize";
import { withIsInline, withIsVoid } from "./plugins";
import { withAutoFormat } from "./format";
import { withInsertBreakHack } from "./elements/link/editable";
import { withNonfatalRange } from "./patches";
import { Element } from "./element";
import Leaf from "./leaf-with-cursor";
import { Actions } from "./types";
import { SimpleInputMerge } from "@cocalc/sync/editor/generic/simple-input-merge";
import { ChangeContext } from "./use-change";
import { getHandler as getKeyboardHandler } from "./keyboard";
import type { SearchHook } from "./search";
import { isAtBeginningOfBlock, isAtEndOfBlock } from "./control";
import { pointAtPath } from "./slate-util";
import type { SlateEditor } from "./types";

const BLOCK_EDITOR_THRESHOLD_CHARS = -1; // always on for prototyping
const EMPTY_SEARCH: SearchHook = {
  decorate: () => [],
  Search: null as any,
  search: "",
  previous: () => undefined,
  next: () => undefined,
  focus: () => undefined,
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
  if (value.length <= 1) return value;
  let end = value.length;
  while (end > 1 && isBlankParagraph(value[end - 1])) {
    end -= 1;
  }
  if (end === value.length) return value;
  return value.slice(0, end);
}

interface BlockMarkdownEditorProps {
  value?: string;
  actions?: Actions;
  read_only?: boolean;
  font_size?: number;
  id?: string;
  is_current?: boolean;
  hidePath?: boolean;
  style?: CSS;
  height?: string;
  noVfill?: boolean;
  divRef?: RefObject<HTMLDivElement>;
  onBlur?: () => void;
  onFocus?: () => void;
  autoFocus?: boolean;
  saveDebounceMs?: number;
  remoteMergeIdleMs?: number;
  ignoreRemoteMergesWhileFocused?: boolean;
  minimal?: boolean;
  controlRef?: MutableRefObject<any>;
  preserveBlankLines?: boolean;
}

export function shouldUseBlockEditor({
  value,
  height,
}: {
  value?: string;
  height?: string;
}): boolean {
  if (height === "auto") return false;
  if (value == null) return true;
  return value.length >= BLOCK_EDITOR_THRESHOLD_CHARS;
}

function splitMarkdownToBlocks(markdown: string): string[] {
  if (!markdown) return [""];
  const cache: { [node: string]: string } = {};
  const doc = markdown_to_slate(markdown, false, cache);
  const filtered = doc.filter(
    (node) => !(node?.["type"] === "paragraph" && node?.["blank"] === true),
  );
  if (filtered.length === 0) return [""];
  return filtered.map((node) =>
    normalizeBlockMarkdown(
      slate_to_markdown([node], { cache, preserveBlankLines: false }),
    ),
  );
}

interface BlockRowEditorProps {
  index: number;
  markdown: string;
  onChangeMarkdown: (index: number, markdown: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  autoFocus?: boolean;
  read_only?: boolean;
  actions?: Actions;
  id?: string;
  rowStyle: React.CSSProperties;
  gapCursor?: { index: number; side: "before" | "after" } | null;
  setGapCursor: (gap: { index: number; side: "before" | "after" } | null) => void;
  onNavigate: (index: number, position: "start" | "end") => void;
  onInsertGap: (
    gap: { index: number; side: "before" | "after" },
    initialText?: string,
  ) => void;
  preserveBlankLines: boolean;
  registerEditor: (index: number, editor: SlateEditor) => void;
  unregisterEditor: (index: number, editor: SlateEditor) => void;
}

const BlockRowEditor: React.FC<BlockRowEditorProps> = React.memo(
  (props: BlockRowEditorProps) => {
    const {
      index,
      markdown,
      onChangeMarkdown,
      onFocus,
      onBlur,
      autoFocus,
      read_only,
      actions,
      id,
      rowStyle,
      gapCursor,
      setGapCursor,
      onNavigate,
      onInsertGap,
      preserveBlankLines,
      registerEditor,
      unregisterEditor,
    } = props;

    const syncCacheRef = useRef<any>({});
    const editor = useMemo(() => {
      const ed = withNonfatalRange(
        withInsertBreakHack(
          withNormalize(
            withAutoFormat(withIsInline(withIsVoid(withReact(createEditor())))),
          ),
        ),
      );
      ed.syncCache = syncCacheRef.current;
      return ed;
    }, []);

    useEffect(() => {
      (editor as SlateEditor).preserveBlankLines = preserveBlankLines;
    }, [editor, preserveBlankLines]);

    useEffect(() => {
      registerEditor(index, editor as SlateEditor);
      return () => {
        unregisterEditor(index, editor as SlateEditor);
      };
    }, [index, editor, registerEditor, unregisterEditor]);

    const [value, setValue] = useState<Descendant[]>(() =>
      stripTrailingBlankParagraphs(
        markdown_to_slate(
          normalizeBlockMarkdown(markdown),
          false,
          syncCacheRef.current,
        ),
      ),
    );
    const [change, setChange] = useState<number>(0);
    const lastMarkdownRef = useRef<string>(markdown);

    useEffect(() => {
      if (markdown === lastMarkdownRef.current) return;
      lastMarkdownRef.current = markdown;
      syncCacheRef.current = {};
      editor.syncCache = syncCacheRef.current;
      editor.selection = null;
      editor.marks = null;
      setValue(
        stripTrailingBlankParagraphs(
          markdown_to_slate(
            normalizeBlockMarkdown(markdown),
            false,
            syncCacheRef.current,
          ),
        ),
      );
    }, [markdown, editor]);

    const renderElement = useCallback(
      (props: RenderElementProps) => <Element {...props} />,
      [],
    );

    const handleChange = useCallback(
      (newValue: Descendant[]) => {
        if (read_only) return;
        setValue(newValue);
        setChange((prev) => prev + 1);
        const nextMarkdown = normalizeBlockMarkdown(
          slate_to_markdown(newValue, {
            cache: syncCacheRef.current,
            preserveBlankLines,
          }),
        );
        lastMarkdownRef.current = nextMarkdown;
        onChangeMarkdown(index, nextMarkdown);
      },
      [index, onChangeMarkdown, preserveBlankLines, read_only],
    );

    const activeGap =
      gapCursor && gapCursor.index === index ? gapCursor : null;

    useEffect(() => {
      (editor as any).blockGapCursor = activeGap;
    }, [editor, activeGap]);

    const handleKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (read_only) {
          event.preventDefault();
          return;
        }
        if (event.defaultPrevented) return;
        if (!ReactEditor.isFocused(editor)) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;

        const isPlainChar =
          event.key.length === 1 &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey;

        if (activeGap) {
          if (event.key === "Escape") {
            setGapCursor(null);
            event.preventDefault();
            return;
          }
          if (event.key === "Enter" || isPlainChar) {
            onInsertGap(activeGap, isPlainChar ? event.key : undefined);
            event.preventDefault();
            return;
          }
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            if (event.key === "ArrowUp" && activeGap.side === "before") {
              setGapCursor(null);
              onNavigate(index - 1, "end");
              event.preventDefault();
              return;
            }
            if (event.key === "ArrowDown" && activeGap.side === "after") {
              setGapCursor(null);
              onNavigate(index + 1, "start");
              event.preventDefault();
              return;
            }
            setGapCursor(null);
          }
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
            setGapCursor(null);
          }
        }

        if (
          event.key === "ArrowUp" &&
          editor.selection != null &&
          Range.isCollapsed(editor.selection) &&
          isAtBeginningOfBlock(editor, { mode: "highest" })
        ) {
          setGapCursor({ index, side: "before" });
          event.preventDefault();
          return;
        }

        if (
          event.key === "ArrowDown" &&
          editor.selection != null &&
          Range.isCollapsed(editor.selection) &&
          isAtEndOfBlock(editor, { mode: "highest" })
        ) {
          setGapCursor({ index, side: "after" });
          event.preventDefault();
          return;
        }

        const handler = getKeyboardHandler(event);
        if (!handler) return;
        if (
          handler({
            editor,
            extra: { actions: actions ?? {}, id: id ?? "", search: EMPTY_SEARCH },
          })
        ) {
          event.preventDefault();
        }
      },
      [
        actions,
        editor,
        gapCursor,
        id,
        index,
        onInsertGap,
        onNavigate,
        read_only,
        setGapCursor,
      ],
    );

    const showGapBefore = gapCursor?.index === index && gapCursor.side === "before";
    const showGapAfter = gapCursor?.index === index && gapCursor.side === "after";

    return (
      <div
        style={{
          ...rowStyle,
        }}
      >
        {showGapBefore && (
          <div
            data-slate-gap-cursor="block-before"
            style={{
              position: "absolute",
              top: -2,
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
        <ChangeContext.Provider
          value={{
            change,
            editor: editor as any,
            blockNavigation: {
              setGapCursor: (side) => {
                setGapCursor({ index, side });
              },
            },
          }}
        >
          <Slate editor={editor} value={value} onChange={handleChange}>
            <Editable
              autoFocus={autoFocus}
              readOnly={read_only}
              renderElement={renderElement}
              renderLeaf={Leaf}
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
        {showGapAfter && (
          <div
            data-slate-gap-cursor="block-after"
            style={{
              position: "absolute",
              bottom: -2,
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
      prevGap === nextGap
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
    is_current,
    noVfill,
    onBlur,
    onFocus,
    saveDebounceMs = SAVE_DEBOUNCE_MS,
    remoteMergeIdleMs,
    ignoreRemoteMergesWhileFocused = true,
    style,
    value,
    minimal,
    divRef,
    controlRef,
  } = props;
  const { project_id, path, desc } = useFrameContext();
  const actions = actions0 ?? {};
  const font_size = font_size0 ?? desc?.get("font_size") ?? DEFAULT_FONT_SIZE;
  const initialValue = value ?? "";
  const valueRef = useRef<string>(initialValue);
  valueRef.current = initialValue;
  // Block mode treats each block independently, so always disable significant
  // blank lines to avoid confusing per-block newline behavior.
  const preserveBlankLines = false;

  const [blocks, setBlocks] = useState<string[]>(() =>
    splitMarkdownToBlocks(initialValue),
  );
  const blocksRef = useRef<string[]>(blocks);
  useEffect(() => {
    blocksRef.current = blocks;
  }, [blocks]);

  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const [gapCursor, setGapCursor] = useState<{
    index: number;
    side: "before" | "after";
  } | null>(null);

  const editorMapRef = useRef<Map<number, SlateEditor>>(new Map());
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
  const remoteMergeConfig =
    typeof window === "undefined"
      ? {}
      : ((window as any).COCALC_SLATE_REMOTE_MERGE ?? {});
  const ignoreRemoteWhileFocused =
    remoteMergeConfig.ignoreWhileFocused ?? ignoreRemoteMergesWhileFocused;
  const mergeIdleMs =
    remoteMergeConfig.idleMs ??
    remoteMergeIdleMs ??
    saveDebounceMs ??
    SAVE_DEBOUNCE_MS;
  const mergeIdleMsRef = useRef<number>(mergeIdleMs);
  mergeIdleMsRef.current = mergeIdleMs;
  const [pendingRemoteIndicator, setPendingRemoteIndicator] =
    useState<boolean>(false);
  const allowFocusedValueUpdateRef = useRef<boolean>(false);

  const updatePendingRemoteIndicator = useCallback(
    (remote: string, local: string) => {
      const preview = mergeHelperRef.current.previewMerge({ remote, local });
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

  const setBlocksFromValue = useCallback((markdown: string) => {
    valueRef.current = markdown;
    const nextBlocks = splitMarkdownToBlocks(markdown);
    blocksRef.current = nextBlocks;
    setBlocks(nextBlocks);
  }, []);

  useEffect(() => {
    const nextValue = value ?? "";
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
      updatePendingRemoteIndicator(nextValue, joinBlocks(blocksRef.current));
      return;
    }
    allowFocusedValueUpdateRef.current = false;
    if (pendingRemoteRef.current != null) return;
    setBlocksFromValue(nextValue);
  }, [
    value,
    focusedIndex,
    ignoreRemoteWhileFocused,
    setBlocksFromValue,
    updatePendingRemoteIndicator,
  ]);

  useEffect(() => {
    if (controlRef == null) return;
    controlRef.current = {
      ...(controlRef.current ?? {}),
      allowNextValueUpdateWhileFocused: () => {
        allowFocusedValueUpdateRef.current = true;
      },
    };
  }, [controlRef]);

  function shouldDeferRemoteMerge(): boolean {
    const idleMs = mergeIdleMsRef.current;
    return Date.now() - lastLocalEditAtRef.current < idleMs;
  }

  function schedulePendingRemoteMerge() {
    if (pendingRemoteTimerRef.current != null) {
      window.clearTimeout(pendingRemoteTimerRef.current);
    }
    const idleMs = mergeIdleMsRef.current;
    pendingRemoteTimerRef.current = window.setTimeout(() => {
      pendingRemoteTimerRef.current = null;
      flushPendingRemoteMerge();
    }, idleMs);
  }

  function flushPendingRemoteMerge(force = false) {
    const pending = pendingRemoteRef.current;
    if (pending == null) return;
    if (!force && shouldDeferRemoteMerge()) {
      schedulePendingRemoteMerge();
      return;
    }
    pendingRemoteRef.current = null;
    setPendingRemoteIndicator(false);
    mergeHelperRef.current.handleRemote({
      remote: pending,
      getLocal: () => joinBlocks(blocksRef.current),
      applyMerged: setBlocksFromValue,
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
      if (ignoreRemoteWhileFocused && focusedIndex != null) {
        updatePendingRemoteIndicator(remote, joinBlocks(blocksRef.current));
        return;
      }
      if (shouldDeferRemoteMerge()) {
        pendingRemoteRef.current = remote;
        schedulePendingRemoteMerge();
        return;
      }
      mergeHelperRef.current.handleRemote({
        remote,
        getLocal: () => joinBlocks(blocksRef.current),
        applyMerged: setBlocksFromValue,
      });
    };
    actions._syncstring.on("change", change);
    return () => {
      actions._syncstring?.removeListener("change", change);
    };
  }, [actions, focusedIndex, ignoreRemoteWhileFocused, setBlocksFromValue, updatePendingRemoteIndicator]);

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
    () => debounce(saveBlocksNow, saveDebounceMs ?? SAVE_DEBOUNCE_MS),
    [saveBlocksNow, saveDebounceMs],
  );

  const handleBlockChange = useCallback(
    (index: number, markdown: string) => {
      if (read_only) return;
      lastLocalEditAtRef.current = Date.now();
      setBlocks((prev) => {
        if (index >= prev.length) return prev;
        if (prev[index] === markdown) return prev;
        const next = [...prev];
        next[index] = markdown;
        blocksRef.current = next;
        return next;
      });
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
      const lastIndex = Math.max(0, editor.children.length - 1);
      const basePath = position === "start" ? [0] : [lastIndex];
      const point = pointAtPath(editor, basePath, undefined, position);
      Transforms.setSelection(editor, { anchor: point, focus: point });
      ReactEditor.focus(editor);
      setFocusedIndex(targetIndex);
    },
    [],
  );

  const registerEditor = useCallback(
    (index: number, editor: SlateEditor) => {
      editorMapRef.current.set(index, editor);
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

  const insertBlockAtGap = useCallback(
    (
      gap: { index: number; side: "before" | "after" },
      initialText?: string,
    ) => {
      const insertIndex = gap.side === "before" ? gap.index : gap.index + 1;
      lastLocalEditAtRef.current = Date.now();
      setGapCursor(null);
      setBlocks((prev) => {
        const next = [...prev];
        next.splice(insertIndex, 0, initialText ?? "");
        blocksRef.current = next;
        return next;
      });
      if (is_current) saveBlocksDebounced();
      pendingFocusRef.current = {
        index: insertIndex,
        position: initialText ? "end" : "start",
      };
      virtuosoRef.current?.scrollToIndex({ index: insertIndex, align: "center" });
    },
    [is_current, saveBlocksDebounced],
  );

  const rowStyle: React.CSSProperties = {
    padding: minimal ? 0 : "0 70px",
    minHeight: "1px",
    position: "relative",
  };

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

  const renderBlock = (index: number) => {
    const markdown = blocks[index] ?? "";
    return (
      <BlockRowEditor
        index={index}
        markdown={markdown}
        onChangeMarkdown={handleBlockChange}
        onFocus={() => {
          setFocusedIndex(index);
          onFocus?.();
        }}
        onBlur={() => {
          setFocusedIndex((prev) => (prev === index ? null : prev));
          onBlur?.();
        }}
        autoFocus={autoFocus && index === 0}
        read_only={read_only}
        actions={actions}
        id={props.id}
        rowStyle={rowStyle}
        gapCursor={gapCursor}
        setGapCursor={setGapCursor}
        onNavigate={focusBlock}
        onInsertGap={insertBlockAtGap}
        preserveBlankLines={preserveBlankLines}
        registerEditor={registerEditor}
        unregisterEditor={unregisterEditor}
      />
    );
  };

  return (
    <div
      ref={divRef}
      className={noVfill || height === "auto" ? undefined : "smc-vfill"}
      style={{
        overflow: noVfill || height === "auto" ? undefined : "auto",
        backgroundColor: "white",
        ...style,
        height,
        minHeight: height === "auto" ? "50px" : undefined,
        position: "relative",
      }}
    >
      {!hidePath && (
        <Path is_current={is_current} path={path} project_id={project_id} />
      )}
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
        <Virtuoso
          className="smc-vfill"
          totalCount={blocks.length}
          itemContent={(index) => renderBlock(index)}
          ref={virtuosoRef}
        />
      </div>
    </div>
  );
}
