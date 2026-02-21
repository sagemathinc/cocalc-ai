/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Input, Popover } from "antd";
import {
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { register, RenderElementProps } from "../register";
import { useFocused, useSelected, useSlate } from "../hooks";
import { useSetElement } from "../set-element";
import infoToMode from "./info-to-mode";
import ActionButtons, { RunFunction } from "./action-buttons";
import { getHistory } from "./history";
import { useFileContext } from "@cocalc/frontend/lib/file-context";
import { isEqual } from "lodash";
import Mermaid from "./mermaid";
import { Icon } from "@cocalc/frontend/components/icon";
import { IS_TOUCH } from "@cocalc/frontend/feature";
import CopyButton from "@cocalc/frontend/components/copy-button";
import { ReactEditor } from "../../slate-react";
import { hash_string } from "@cocalc/util/misc";
import { Editor, Transforms } from "slate";
import { markdown_to_slate } from "../../markdown-to-slate";
import { insertPlainTextInCodeBlock } from "../../format/auto-format";
import type { CodeBlock } from "./types";
import { getCodeBlockLineCount, getCodeBlockText } from "./utils";
import { CodeBlockBody, CodeLineElement } from "./code-like";
import { guessPopularLanguage } from "@cocalc/frontend/misc/detect-language";
import { pointAtPath } from "../../slate-util";
import { useJupyterCellContext } from "../../jupyter-cell-context";

interface FloatingActionMenuProps {
  info: string;
  setInfo: (info: string) => void;
  visible: boolean;
  showInfoInput: boolean;
  onInfoFocus: () => void;
  onInfoBlur: () => void;
  renderActions: () => ReactNode;
  download: () => void;
  code: string;
  lineCount: number;
  modeLabel: string;
  onRun?: () => void;
  collapseToggle?: { label: string; onClick: () => void } | null;
}

function FloatingActionMenu({
  info,
  setInfo,
  visible,
  showInfoInput,
  onInfoFocus,
  onInfoBlur,
  renderActions,
  download,
  code,
  lineCount,
  modeLabel,
  onRun,
  collapseToggle,
}: FloatingActionMenuProps) {
  const [open, setOpen] = useState(false);

  const popoverContent = (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        minWidth: "240px",
      }}
    >
      {showInfoInput && (
        <Input
          size="small"
          placeholder="Info string (py, r, jl, tex, md, etc.)..."
          value={info}
          onFocus={() => {
            onInfoFocus();
          }}
          onBlur={() => {
            onInfoBlur();
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.keyCode == 13 && e.shiftKey) {
              onRun?.();
            }
          }}
          onKeyUp={(e) => e.stopPropagation()}
          onKeyPress={(e) => e.stopPropagation()}
          onBeforeInput={(e) => e.stopPropagation()}
          onInput={(e) => e.stopPropagation()}
          onChange={(e) => {
            const next = e.target.value;
            setInfo(next);
          }}
        />
      )}
      <div
        style={{
          display: "flex",
          gap: "6px",
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        {renderActions()}
        <Button
          size="small"
          type="text"
          style={{ color: "#666" }}
          onClick={() => {
            download();
            setOpen(false);
          }}
        >
          <Icon name="download" /> Download
        </Button>
      </div>
      <div style={{ color: "#888", fontSize: "11px" }}>
        {modeLabel || "plain text"}, {lineCount} lines
      </div>
    </div>
  );

  return (
    <div
      style={{
        position: "absolute",
        top: 6,
        right: 6,
        zIndex: 2,
        display: "flex",
        alignItems: "center",
        gap: "4px",
        background: "rgba(255, 255, 255, 0.9)",
        border: "1px solid #ddd",
        borderRadius: "6px",
        padding: "2px 4px",
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? "auto" : "none",
        transition: "opacity 140ms ease",
      }}
    >
      {collapseToggle && (
        <Button
          size="small"
          type="text"
          style={{ color: "#666", background: "transparent" }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            collapseToggle.onClick();
          }}
        >
          {collapseToggle.label}
        </Button>
      )}
      <CopyButton
        size="small"
        value={code}
        noText
        style={{ color: "#666", background: "transparent" }}
      />
      <Popover
        trigger="click"
        open={open}
        onOpenChange={(next) => setOpen(next)}
        content={popoverContent}
        placement="bottomRight"
      >
        <Button
          size="small"
          type="text"
          style={{ boxShadow: "none", background: "transparent" }}
          aria-label="Code block actions"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <Icon name="ellipsis" rotate="90" />
        </Button>
      </Popover>
    </div>
  );
}

function shouldPreferRichText(text: string): boolean {
  if (!text) return false;
  const markdownHints = [
    /^#{1,6}\s/m,
    /^>\s/m,
    /^(\s*[-*+]|\s*\d+\.)\s/m,
    /```/,
    /\[[^\]]+\]\([^)]+\)/,
    /!\[[^\]]*\]\([^)]+\)/,
    /(^|\s)`[^`]+`/m,
    /\*\*[^*]+\*\*/,
    /(^|\s)_[^_]+_/m,
    /\|\s*[^|]+\s*\|/,
  ];
  const codeHints = [
    /;\s*$/m,
    /[{}]/,
    /=>|::|->|<-|\+=|-=|\*=|\/=|==|!=|<=|>=/,
    /^\s*(def|class|function|import|from|#include|using|public|private|static)\b/m,
    /^\s*[A-Za-z_][\w]*\s*=\s*.+/m,
    /^\s*(if|for|while|switch|case|return)\b/m,
  ];
  const hasMarkdown = markdownHints.some((re) => re.test(text));
  const hasCode = codeHints.some((re) => re.test(text));
  return hasMarkdown && !hasCode;
}

export function CodeLikeEditor({ attributes, children, element }: RenderElementProps) {
  if (element.type === "code_line") {
    return <CodeLineElement attributes={attributes}>{children}</CodeLineElement>;
  }
  if (element.type != "code_block" && element.type != "jupyter_code_cell") {
    throw Error("bug");
  }
  const isJupyterCodeCell = element.type === "jupyter_code_cell";
  const {
    renderOutput: renderJupyterOutput,
    selectedCellId,
    setSelectedCellId,
    hoveredCellId,
    setHoveredCellId,
    runCell,
    getCellChromeInfo,
  } = useJupyterCellContext();
  const jupyterCellId = isJupyterCodeCell
    ? `${(element as any).cell_id ?? ""}`.trim()
    : "";
  const COLLAPSE_THRESHOLD_LINES = 6;
  const { disableMarkdownCodebar } = useFileContext();
  const editor = useSlate();
  const focused = useFocused();
  const [info, setInfo] = useState<string>(element.info ?? "");
  const infoFocusedRef = useRef<boolean>(false);
  const [output, setOutput] = useState<null | ReactNode>(null);
  const runRef = useRef<RunFunction | null>(null);
  const setElement = useSetElement(editor, element);
  // textIndent: 0 is needed due to task lists -- see https://github.com/sagemathinc/cocalc/issues/6074
  const [history, setHistory] = useState<string[]>(
    getHistory(editor, element) ?? [],
  );
  const elementPath = ReactEditor.findPath(editor, element);
  const codeValue = getCodeBlockText(element as CodeBlock);
  const expandState =
    (editor as any).codeBlockExpandState ??
    ((editor as any).codeBlockExpandState = new Map<string, boolean>());
  const blockIndex = (editor as any).blockIndex;
  const collapseKey = useMemo(() => {
    if (blockIndex != null) {
      return `block:${blockIndex}`;
    }
    if (elementPath != null) {
      return `path:${elementPath.join(".")}`;
    }
    const base = `${info ?? ""}\n${codeValue}`;
    return `code:${hash_string(base)}`;
  }, [blockIndex, elementPath, info, codeValue]);
  const [expanded, setExpanded] = useState<boolean>(
    () => expandState.get(collapseKey) ?? false,
  );
  const [menuHovered, setMenuHovered] = useState<boolean>(false);
  const [menuFocused, setMenuFocused] = useState<boolean>(false);
  useEffect(() => {
    setExpanded(expandState.get(collapseKey) ?? false);
  }, [collapseKey]);
  useEffect(() => {
    const newHistory = getHistory(editor, element);
    if (newHistory != null && !isEqual(history, newHistory)) {
      setHistory(newHistory);
    }
    if (!infoFocusedRef.current && element.info != info) {
      // upstream change
      setInfo(element.info);
    }
  }, [editor, element, history, info]);

  const lineCount = getCodeBlockLineCount(element as CodeBlock);
  const modeLabel = infoToMode(info, { value: codeValue }) || "plain text";
  const shouldCollapse = false;
  const selected = useSelected();
  const selectionInBlock = !!focused && !!selected;
  const isSelectedJupyterCell =
    isJupyterCodeCell &&
    !!jupyterCellId &&
    `${selectedCellId ?? ""}`.trim() === jupyterCellId;
  const isHoveredJupyterCell =
    isJupyterCodeCell &&
    !!jupyterCellId &&
    `${hoveredCellId ?? ""}`.trim() === jupyterCellId;
  useEffect(() => {
    if (!isJupyterCodeCell || !selectionInBlock || !jupyterCellId) return;
    setSelectedCellId?.(jupyterCellId);
  }, [isJupyterCodeCell, selectionInBlock, jupyterCellId, setSelectedCellId]);
  const syncSelectionFromDom = useCallback(() => {
    if (typeof window === "undefined") return;
    const domSelection = window.getSelection?.();
    if (!domSelection || domSelection.rangeCount === 0) return;
    const domRange = domSelection.getRangeAt(0);
    const ignoreSelection = editor.getIgnoreSelection?.() ?? false;
    if (ignoreSelection) editor.setIgnoreSelection(false);
    try {
      const range = ReactEditor.toSlateRange(editor, domRange);
      if (range) {
        Transforms.select(editor, range);
      }
    } catch {
      // ignore selection conversion issues
    } finally {
      if (ignoreSelection) editor.setIgnoreSelection(true);
    }
  }, [editor]);
  const forceExpanded = selectionInBlock;
  const isCollapsed = shouldCollapse && !expanded && !forceExpanded;
  const showActionMenu =
    IS_TOUCH || selectionInBlock || menuHovered || menuFocused;
  const markdownCandidate = (element as any).markdownCandidate;
  const preferRichText =
    !!markdownCandidate && shouldPreferRichText(codeValue ?? "");
  const popularGuess = markdownCandidate
    ? guessPopularLanguage(codeValue ?? "")
    : null;
  const showPopularGuess =
    !!popularGuess && popularGuess.score >= 4;
  const projectedJupyterOutput =
    isJupyterCodeCell && jupyterCellId
      ? renderJupyterOutput?.(jupyterCellId)
      : null;
  const jupyterChromeInfo =
    isJupyterCodeCell && jupyterCellId ? getCellChromeInfo?.(jupyterCellId) : undefined;
  const showJupyterChrome =
    isJupyterCodeCell &&
    !!jupyterCellId &&
    (isHoveredJupyterCell ||
      (!hoveredCellId && (selectionInBlock || menuFocused || isSelectedJupyterCell)));
  const setExpandedState = useCallback(
    (next: boolean, focus: boolean) => {
      expandState.set(collapseKey, next);
      setExpanded(next);
      if (next && focus) {
        const point = Editor.start(editor, elementPath);
        Transforms.select(editor, point);
        ReactEditor.focus(editor);
      }
    },
    [collapseKey, expandState, editor, elementPath],
  );

  const toggleCollapse = useCallback(
    (opts?: { focus?: boolean }) => {
      const next = !expanded;
      const focus = next && (opts?.focus ?? true);
      setExpandedState(next, focus);
    },
    [expanded, setExpandedState],
  );

  const collapseNow = useCallback(() => {
    setExpandedState(false, false);
  }, [setExpandedState]);

  const dismissMarkdownCandidate = useCallback(() => {
    setElement({ markdownCandidate: undefined } as any);
  }, [setElement]);

  const focusAfterCodeBlock = useCallback(() => {
    const focusNow = () => {
      const after = Editor.after(editor, elementPath);
      const point = after ?? Editor.end(editor, elementPath);
      Transforms.select(editor, { anchor: point, focus: point });
      ReactEditor.focus(editor);
    };
    if (typeof window === "undefined") {
      focusNow();
      return;
    }
    window.setTimeout(focusNow, 0);
  }, [editor, elementPath]);

  const focusAtPathEnd = useCallback(
    (path: number[]) => {
      const focusNow = () => {
        const point = pointAtPath(editor, path, undefined, "end");
        Transforms.select(editor, { anchor: point, focus: point });
        ReactEditor.focus(editor);
      };
      if (typeof window === "undefined") {
        focusNow();
        return;
      }
      window.setTimeout(focusNow, 0);
    },
    [editor],
  );

  const focusAtInlineBoundary = useCallback(
    (paragraphPath: number[], childIndex: number | null) => {
      const focusNow = () => {
        const point =
          childIndex == null
            ? pointAtPath(editor, paragraphPath, undefined, "end")
            : pointAtPath(
                editor,
                paragraphPath.concat(childIndex),
                0,
                "start",
              );
        Transforms.select(editor, { anchor: point, focus: point });
        ReactEditor.focus(editor);
      };
      if (typeof window === "undefined") {
        focusNow();
        return;
      }
      window.setTimeout(focusNow, 0);
    },
    [editor],
  );

  const convertMarkdownCandidateInline = useCallback(
    (doc: any[]): boolean => {
      if (
        doc.length !== 1 ||
        doc[0]?.type !== "paragraph" ||
        !Array.isArray(doc[0]?.children)
      ) {
        return false;
      }
      const inlineChildrenRaw = doc[0].children;
      if (inlineChildrenRaw.length === 0) return false;
      const inlineChildren =
        typeof structuredClone === "function"
          ? structuredClone(inlineChildrenRaw)
          : JSON.parse(JSON.stringify(inlineChildrenRaw));
      const parentPath = elementPath.slice(0, -1);
      const codeIndex = elementPath[elementPath.length - 1];
      let parentChildren: any[] | undefined;
      try {
        const [parentNode] = Editor.node(editor, parentPath);
        parentChildren = (parentNode as any)?.children;
      } catch {
        return false;
      }
      if (!Array.isArray(parentChildren)) return false;
      const prev = parentChildren[codeIndex - 1];
      const next = parentChildren[codeIndex + 1];
      const afterSpacer = parentChildren[codeIndex + 2];
      const isParagraph = (node: any) =>
        node != null && typeof node === "object" && node.type === "paragraph";
      const isSpacerParagraph = (node: any) =>
        isParagraph(node) && node.spacer === true;
      const newChildren = [...parentChildren];
      let focusParagraphPath: number[] | null = null;
      let focusChildIndex: number | null = null;

      // Most common case when pasting in the middle of a paragraph:
      // [paragraph-before, code-block, spacer, paragraph-after]
      if (isParagraph(prev) && isSpacerParagraph(next) && isParagraph(afterSpacer)) {
        const prevLen = Array.isArray(prev.children) ? prev.children.length : 0;
        const merged = {
          ...prev,
          children: [...(prev.children ?? []), ...inlineChildren, ...(afterSpacer.children ?? [])],
        };
        newChildren.splice(codeIndex - 1, 4, merged);
        focusParagraphPath = parentPath.concat(codeIndex - 1);
        const boundary = prevLen + inlineChildren.length;
        focusChildIndex = boundary < merged.children.length ? boundary : null;
      } else if (isParagraph(prev) && isSpacerParagraph(next)) {
        const merged = {
          ...prev,
          children: [...(prev.children ?? []), ...inlineChildren],
        };
        newChildren.splice(codeIndex - 1, 3, merged);
        focusParagraphPath = parentPath.concat(codeIndex - 1);
        focusChildIndex = null;
      } else if (isSpacerParagraph(next) && isParagraph(afterSpacer)) {
        const merged = {
          ...afterSpacer,
          spacer: undefined,
          children: [...inlineChildren, ...(afterSpacer.children ?? [])],
        };
        newChildren.splice(codeIndex, 3, merged);
        focusParagraphPath = parentPath.concat(codeIndex);
        focusChildIndex =
          inlineChildren.length < merged.children.length
            ? inlineChildren.length
            : null;
      } else if (isSpacerParagraph(next)) {
        const merged = {
          type: "paragraph",
          children: inlineChildren,
        };
        newChildren.splice(codeIndex, 2, merged);
        focusParagraphPath = parentPath.concat(codeIndex);
        focusChildIndex = null;
      } else {
        return false;
      }

      Editor.withoutNormalizing(editor, () => {
        for (let i = parentChildren.length - 1; i >= 0; i--) {
          Transforms.removeNodes(editor, { at: parentPath.concat(i) });
        }
        Transforms.insertNodes(editor, newChildren as any, { at: parentPath.concat(0) });
      });
      if (focusParagraphPath != null) {
        focusAtInlineBoundary(focusParagraphPath, focusChildIndex);
      }
      return true;
    },
    [editor, elementPath, focusAtInlineBoundary],
  );

  const convertMarkdownCandidate = useCallback(() => {
    const markdown = codeValue ?? "";
    const doc = markdown_to_slate(markdown, true);
    if (convertMarkdownCandidateInline(doc as any[])) {
      return;
    }
    const insertPath = [...elementPath];
    Editor.withoutNormalizing(editor, () => {
      Transforms.removeNodes(editor, { at: elementPath });
      Transforms.insertNodes(editor, doc as any, { at: elementPath });
    });
    focusAtPathEnd(insertPath);
  }, [
    editor,
    codeValue,
    elementPath,
    focusAtPathEnd,
    convertMarkdownCandidateInline,
  ]);

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      const text = event.clipboardData?.getData("text/plain");
      if (!text) return;
      event.preventDefault();
      event.stopPropagation();
      syncSelectionFromDom();
      if (!insertPlainTextInCodeBlock(editor, text)) {
        Editor.insertText(editor, text);
      }
    },
    [editor, syncSelectionFromDom],
  );

  return (
    <div
      {...attributes}
      spellCheck={false}
      style={{ textIndent: 0 }}
      data-cocalc-test={isJupyterCodeCell ? "jupyter-singledoc-code-cell" : undefined}
      data-cocalc-cell-id={
        isJupyterCodeCell ? `${(element as any).cell_id ?? ""}` : undefined
      }
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 1 }}>
          <div
            style={{
              position: "relative",
              border: isJupyterCodeCell
                ? isSelectedJupyterCell
                  ? "1px solid #91caff"
                  : "1px solid #d9d9d9"
                : undefined,
              borderRadius: isJupyterCodeCell ? "6px" : undefined,
              paddingTop: isJupyterCodeCell ? "28px" : undefined,
              background: isJupyterCodeCell ? "#fff" : undefined,
            }}
            onMouseEnter={() => {
              if (!IS_TOUCH) {
                setMenuHovered(true);
                if (isJupyterCodeCell && jupyterCellId) {
                  setHoveredCellId?.(jupyterCellId);
                }
              }
            }}
            onMouseLeave={() => {
              if (!IS_TOUCH) {
                setMenuHovered(false);
                if (
                  isJupyterCodeCell &&
                  jupyterCellId &&
                  `${hoveredCellId ?? ""}`.trim() === jupyterCellId
                ) {
                  setHoveredCellId?.(undefined);
                }
              }
            }}
            onFocusCapture={() => {
              if (!IS_TOUCH) setMenuFocused(true);
            }}
            onBlurCapture={(event) => {
              if (IS_TOUCH) return;
              const next = event.relatedTarget as Node | null;
              if (next && (event.currentTarget as HTMLElement).contains(next)) {
                return;
              }
              setMenuFocused(false);
            }}
          >
            {showJupyterChrome && (
              <div
                contentEditable={false}
                data-cocalc-test="jupyter-singledoc-cell-chrome"
                data-cocalc-cell-id={jupyterCellId}
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  minHeight: "26px",
                  borderBottom: "1px solid #f0f0f0",
                  background: "#fafafa",
                  borderTopLeftRadius: "6px",
                  borderTopRightRadius: "6px",
                  padding: "2px 8px",
                  fontSize: "12px",
                  zIndex: 1,
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <Button
                    size="small"
                    type="text"
                    style={{ color: "#333", padding: 0 }}
                    onClick={() => {
                      if (!jupyterCellId) return;
                      runCell?.(jupyterCellId, { insertBelow: false });
                    }}
                  >
                    <Icon name="play" /> Run
                  </Button>
                  <Button
                    size="small"
                    type="text"
                    style={{ color: "#333", padding: 0 }}
                    onClick={() => {
                      if (!jupyterCellId) return;
                      runCell?.(jupyterCellId, { insertBelow: true });
                    }}
                  >
                    <Icon name="caret-down" />
                  </Button>
                  <span style={{ color: "#666" }}>
                    <Icon name="robot" /> Assistant
                  </span>
                  <span style={{ color: "#666" }}>
                    <Icon name="table" /> Format
                  </span>
                </div>
                <div style={{ display: "flex", gap: "10px", color: "#666" }}>
                  {jupyterChromeInfo?.runtimeLabel ? (
                    <span>{jupyterChromeInfo.runtimeLabel}</span>
                  ) : null}
                  {jupyterChromeInfo?.running ? <span>running</span> : null}
                  {jupyterChromeInfo?.execCount ? (
                    <span>{jupyterChromeInfo.execCount}</span>
                  ) : null}
                </div>
              </div>
            )}
            {!disableMarkdownCodebar && !isJupyterCodeCell && (
              <div contentEditable={false}>
                <FloatingActionMenu
                  info={info}
                  setInfo={(info) => {
                    setInfo(info);
                  }}
                  visible={showActionMenu}
                  showInfoInput={!!element.fence}
                  onInfoFocus={() => {
                    infoFocusedRef.current = true;
                    editor.setIgnoreSelection(true);
                  }}
                  onInfoBlur={() => {
                    infoFocusedRef.current = false;
                    editor.setIgnoreSelection(false);
                    if (element.info != info) {
                      setElement({ info });
                    }
                  }}
                  renderActions={() => (
                    <ActionButtons
                      size="small"
                      input={codeValue}
                      history={history}
                      setOutput={setOutput}
                      output={output}
                      info={info}
                      runRef={runRef}
                      setInfo={(info) => {
                        setElement({ info });
                      }}
                    />
                  )}
                  code={codeValue}
                  download={() => {
                    const blob = new Blob([codeValue], {
                      type: "text/plain;charset=utf-8",
                    });
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement("a");
                    link.href = url;
                    const ext =
                      infoToMode(info, { value: codeValue }) || "txt";
                    link.download = `code-block.${ext}`;
                    link.click();
                    URL.revokeObjectURL(url);
                  }}
                  lineCount={lineCount}
                  modeLabel={modeLabel}
                  onRun={() => runRef.current?.()}
                  collapseToggle={
                    shouldCollapse
                      ? {
                          label: isCollapsed ? "Show all" : "Collapse",
                          onClick: isCollapsed
                            ? () => toggleCollapse({ focus: true })
                            : collapseNow,
                        }
                      : null
                  }
                />
              </div>
            )}
            {isCollapsed ? (
              <pre
                className="cocalc-slate-code-block"
                contentEditable={false}
                style={{ margin: 0 }}
              >
                {codeValue
                  .split("\n")
                  .slice(0, COLLAPSE_THRESHOLD_LINES)
                  .join("\n")}
              </pre>
            ) : (
              <CodeBlockBody
                onPaste={handlePaste}
                onInput={() => {
                  const ed = editor as any;
                  if (ed._hasUnsavedChanges === false) {
                    ed._hasUnsavedChanges = undefined;
                  } else {
                    ed._hasUnsavedChanges = {};
                  }
                  // Uses EditableMarkdown's debounced save path.
                  ed.saveValue?.();
                }}
              >
                {children}
              </CodeBlockBody>
            )}
            {markdownCandidate && (
              <div
                contentEditable={false}
                style={{
                  display: "flex",
                  justifyContent: "flex-start",
                  gap: "8px",
                  marginTop: 6,
                  marginBottom: 6,
                }}
                onMouseDown={(e) => {
                  // Prevent toolbar button clicks from stealing DOM focus from Slate.
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                <Button
                  size="small"
                  type={preferRichText ? "primary" : "default"}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    convertMarkdownCandidate();
                  }}
                >
                  Markdown
                </Button>
                <Button
                  size="small"
                  type={preferRichText ? "default" : "primary"}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    dismissMarkdownCandidate();
                    focusAfterCodeBlock();
                  }}
                >
                  Code Block
                </Button>
                {showPopularGuess && popularGuess && (
                  <Button
                    size="small"
                    type="default"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const info = popularGuess.mode;
                      setInfo(info);
                      setElement({ info } as any);
                      dismissMarkdownCandidate();
                      focusAfterCodeBlock();
                    }}
                  >
                    {popularGuess.label}
                  </Button>
                )}
              </div>
            )}
            {!disableMarkdownCodebar && output != null && (
              <div
                contentEditable={false}
                onMouseDown={() => {
                  editor.setIgnoreSelection(true);
                }}
                onMouseUp={() => {
                  editor.setIgnoreSelection(false);
                }}
                style={{
                  borderTop: "1px dashed #ccc",
                  background: "white",
                  padding: "5px 0 5px 30px",
                }}
              >
                {output}
              </div>
            )}
            {projectedJupyterOutput != null && (
              <div contentEditable={false}>{projectedJupyterOutput}</div>
            )}
          </div>
        </div>
        {element.info == "mermaid" && (
          <div contentEditable={false}>
            <Mermaid style={{ flex: 1 }} value={codeValue} />
          </div>
        )}
      </div>
    </div>
  );
}

export function fromSlate({ node }) {
  const value = getCodeBlockText(node as CodeBlock);

  // We always convert them to fenced, because otherwise collaborative editing just
  // isn't possible, e.g., because you can't have blank lines at the end.  This isn't
  // too bad, since the conversion only happens for code blocks you actually touch.
  if (true || node.fence) {
    const info = node.info.trim() ?? "";
    // There is one special case with fenced codeblocks that we
    // have to worry about -- if they contain ```, then we need
    // to wrap with *more* than the max sequence of backticks
    // actually in the codeblock!   See
    //    https://stackoverflow.com/questions/49267811/how-can-i-escape-3-backticks-code-block-in-3-backticks-code-block
    // for an excellent discussion of this, and also
    // https://github.com/mwouts/jupytext/issues/712
    let fence = "```";
    while (value.indexOf(fence) != -1) {
      fence += "`";
    }
    return fence + info + "\n" + value + "\n" + fence + "\n\n";
    // this was the old code for non-fenced blocks:
    //   } else {
    //     return indent(value, 4) + "\n\n";
  }
}

register({
  slateType: "code_block",
  fromSlate,
  Element: CodeLikeEditor,
  rules: {
    autoFocus: true,
    autoAdvance: true,
  },
});

register({
  slateType: "code_line",
  Element: CodeLikeEditor,
});
