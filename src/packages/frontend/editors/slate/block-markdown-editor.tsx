/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Prototype: always-editable block editor for very large markdown documents.

import { debounce } from "lodash";
import {
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
import { Descendant, createEditor } from "slate";
import { Virtuoso } from "react-virtuoso";
import { Editable, Slate, withReact } from "./slate-react";
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

const BLOCK_EDITOR_THRESHOLD_CHARS = -1; // always on for prototyping

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
  minimal?: boolean;
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
    normalizeBlockMarkdown(slate_to_markdown([node], { cache })),
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
  highlight?: boolean;
  rowStyle: React.CSSProperties;
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
      highlight,
      rowStyle,
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
          }),
        );
        lastMarkdownRef.current = nextMarkdown;
        onChangeMarkdown(index, nextMarkdown);
      },
      [index, onChangeMarkdown, read_only],
    );

    return (
      <div
        style={{
          ...rowStyle,
          boxShadow: highlight ? "0 0 0 2px rgba(24, 144, 255, 0.25)" : undefined,
          borderRadius: highlight ? "6px" : undefined,
        }}
      >
        <ChangeContext.Provider value={{ change, editor: editor as any }}>
          <Slate editor={editor} value={value} onChange={handleChange}>
            <Editable
              autoFocus={autoFocus}
              readOnly={read_only}
              renderElement={renderElement}
              renderLeaf={Leaf}
              onFocus={onFocus}
              onBlur={onBlur}
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
      </div>
    );
  },
  (prev, next) =>
    prev.markdown === next.markdown &&
    prev.highlight === next.highlight &&
    prev.read_only === next.read_only,
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
    style,
    value,
    minimal,
    divRef,
  } = props;
  const { project_id, path, desc } = useFrameContext();
  const actions = actions0 ?? {};
  const font_size = font_size0 ?? desc?.get("font_size") ?? DEFAULT_FONT_SIZE;
  const initialValue = value ?? "";
  const valueRef = useRef<string>(initialValue);
  valueRef.current = initialValue;

  const [blocks, setBlocks] = useState<string[]>(() =>
    splitMarkdownToBlocks(initialValue),
  );
  const blocksRef = useRef<string[]>(blocks);
  useEffect(() => {
    blocksRef.current = blocks;
  }, [blocks]);

  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  const lastSetValueRef = useRef<string | null>(null);
  const pendingRemoteRef = useRef<string | null>(null);
  const pendingRemoteTimerRef = useRef<number | null>(null);
  const mergeHelperRef = useRef<SimpleInputMerge>(
    new SimpleInputMerge(initialValue),
  );
  const lastLocalEditAtRef = useRef<number>(0);
  const mergeIdleMsRef = useRef<number>(saveDebounceMs ?? SAVE_DEBOUNCE_MS);
  mergeIdleMsRef.current = saveDebounceMs ?? SAVE_DEBOUNCE_MS;

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
    if (pendingRemoteRef.current != null) return;
    setBlocksFromValue(nextValue);
  }, [value, setBlocksFromValue]);

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

  function flushPendingRemoteMerge() {
    const pending = pendingRemoteRef.current;
    if (pending == null) return;
    if (shouldDeferRemoteMerge()) {
      schedulePendingRemoteMerge();
      return;
    }
    pendingRemoteRef.current = null;
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
  }, [actions, setBlocksFromValue]);

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
    },
    [is_current, read_only, saveBlocksDebounced],
  );

  const rowStyle: React.CSSProperties = {
    padding: minimal ? 0 : "0 70px",
    minHeight: "1px",
  };

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
        highlight={focusedIndex === index}
        rowStyle={rowStyle}
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
      }}
    >
      {!hidePath && (
        <Path is_current={is_current} path={path} project_id={project_id} />
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
        />
      </div>
    </div>
  );
}
