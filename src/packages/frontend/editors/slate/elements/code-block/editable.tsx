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
import { useIsMountedRef } from "@cocalc/frontend/app-framework";
import { register, RenderElementProps } from "../register";
import { useSlate } from "../hooks";
import { SlateCodeMirror } from "../codemirror";
import { delay } from "awaiting";
import { useSetElement } from "../set-element";
import infoToMode from "./info-to-mode";
import ActionButtons, { RunFunction } from "./action-buttons";
import { useChange } from "../../use-change";
import { getHistory } from "./history";
import { useFileContext } from "@cocalc/frontend/lib/file-context";
import { isEqual } from "lodash";
import Mermaid from "./mermaid";
import { Icon } from "@cocalc/frontend/components/icon";
import CopyButton from "@cocalc/frontend/components/copy-button";
import { ReactEditor } from "../../slate-react";
import { useFocused, useSelected } from "../hooks";
import { hash_string } from "@cocalc/util/misc";

interface FloatingActionMenuProps {
  info: string;
  setInfo: (info: string) => void;
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
          onKeyDown={(e) => {
            if (e.keyCode == 13 && e.shiftKey) {
              onRun?.();
            }
          }}
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

function Element({ attributes, children, element }: RenderElementProps) {
  if (element.type != "code_block") {
    throw Error("bug");
  }
  const COLLAPSE_THRESHOLD_LINES = 6;
  const { disableMarkdownCodebar } = useFileContext();
  const editor = useSlate();
  const focused = useFocused();
  const selected = useSelected();
  const isMountedRef = useIsMountedRef();
  const [info, setInfo] = useState<string>(element.info ?? "");
  const infoFocusedRef = useRef<boolean>(false);
  const [output, setOutput] = useState<null | ReactNode>(null);
  const runRef = useRef<RunFunction | null>(null);
  const setElement = useSetElement(editor, element);
  // textIndent: 0 is needed due to task lists -- see https://github.com/sagemathinc/cocalc/issues/6074
  const { change, blockNavigation } = useChange();
  const [codeFocused, setCodeFocused] = useState<boolean>(false);
  const [history, setHistory] = useState<string[]>(
    getHistory(editor, element) ?? [],
  );
  const elementPath = ReactEditor.findPath(editor, element);
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
    const base = `${info ?? ""}\n${element.value}`;
    return `code:${hash_string(base)}`;
  }, [blockIndex, elementPath, info, element.value]);
  const [expanded, setExpanded] = useState<boolean>(
    () => expandState.get(collapseKey) ?? false,
  );
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
  }, [change, element]);

  const lineCount = element.value.split("\n").length;
  const modeLabel = infoToMode(info, { value: element.value }) || "plain text";
  const shouldCollapse = lineCount > COLLAPSE_THRESHOLD_LINES;
  const forceExpanded = codeFocused || (focused && selected);
  const isCollapsed = shouldCollapse && !expanded && !forceExpanded;
  const setExpandedState = useCallback(
    (next: boolean, focus: boolean) => {
      expandState.set(collapseKey, next);
      setExpanded(next);
      if (next && focus) {
        (editor as any).pendingCodeBlockFocusPath = elementPath;
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

  return (
    <div {...attributes}>
      <div contentEditable={false} style={{ textIndent: 0 }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1 }}>
            <div style={{ position: "relative" }}>
              {!disableMarkdownCodebar && (
                <FloatingActionMenu
                  info={info}
                  setInfo={(info) => {
                    setInfo(info);
                    setElement({ info });
                  }}
                  showInfoInput={!!element.fence}
                  onInfoFocus={() => {
                    infoFocusedRef.current = true;
                    editor.setIgnoreSelection(true);
                  }}
                  onInfoBlur={() => {
                    infoFocusedRef.current = false;
                    editor.setIgnoreSelection(false);
                  }}
                  renderActions={() => (
                    <ActionButtons
                      size="small"
                      input={element.value}
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
                  code={element.value}
                  download={() => {
                    const blob = new Blob([element.value], {
                      type: "text/plain;charset=utf-8",
                    });
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement("a");
                    link.href = url;
                    const ext =
                      infoToMode(info, { value: element.value }) || "txt";
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
              )}
              <SlateCodeMirror
                options={{ lineWrapping: true }}
                value={element.value}
                info={infoToMode(info, { value: element.value })}
                focusOnSelect
                elementPath={elementPath}
                onRequestGapCursor={blockNavigation?.setGapCursor}
                collapsed={shouldCollapse ? isCollapsed : false}
                collapseLines={shouldCollapse ? COLLAPSE_THRESHOLD_LINES : undefined}
                onChange={(value) => {
                  setElement({ value });
                }}
                onFocus={async () => {
                  setCodeFocused(true);
                  await delay(1); // must be a little longer than the onBlur below.
                  if (!isMountedRef.current) return;
                }}
                onBlur={async () => {
                  setCodeFocused(false);
                  await delay(0);
                  if (!isMountedRef.current) return;
                }}
                onShiftEnter={() => {
                  runRef.current?.();
                }}
                addonAfter={
                  disableMarkdownCodebar || output == null ? null : (
                    <div
                      onMouseDown={() => {
                        editor.setIgnoreSelection(true);
                      }}
                      onMouseUp={() => {
                        // Re-enable slate listing for selection changes again in next render loop.
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
                  )
                }
              />
            </div>
          </div>
          {element.info == "mermaid" && (
            <Mermaid style={{ flex: 1 }} value={element.value} />
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

function fromSlate({ node }) {
  const value = node.value as string;

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
  Element,
  rules: {
    autoFocus: true,
    autoAdvance: true,
  },
});
