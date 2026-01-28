/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Popover, Tooltip } from "antd";
import React, { ReactNode, useEffect, useRef, useState } from "react";
import { Element } from "slate";
import { register, RenderElementProps } from "../register";
import infoToMode from "./info-to-mode";
import ActionButtons from "./action-buttons";
import { useChange } from "../../use-change";
import { getHistory } from "./history";
import { useFileContext } from "@cocalc/frontend/lib/file-context";
import { Icon } from "@cocalc/frontend/components/icon";
import CopyButton from "@cocalc/frontend/components/copy-button";
import { isEqual } from "lodash";
import Mermaid from "./mermaid";
import { highlightCodeHtml } from "./prism";
import { getCodeBlockLineCount, getCodeBlockText, toCodeLines } from "./utils";

interface FloatingActionMenuProps {
  editing: boolean;
  canEdit: boolean;
  info: string;
  content: string;
  onSaveOrEdit: () => void;
  onDownload: () => void;
  renderActions: (size?: "small" | "middle" | "large") => ReactNode;
  collapseToggle?: { label: string; onClick: () => void } | null;
}

function FloatingActionMenu({
  editing,
  canEdit,
  info,
  content,
  onSaveOrEdit,
  onDownload,
  renderActions,
  collapseToggle,
}: FloatingActionMenuProps) {
  const [open, setOpen] = useState(false);

  const actionContent = (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      {canEdit && (
        <Tooltip
          title={
            <>
              Make a <i>temporary</i> change to this code.{" "}
              <b>This is not saved permanently anywhere!</b>
            </>
          }
        >
          <Button
            size="small"
            type={editing ? undefined : "text"}
            style={
              editing
                ? { background: "#5cb85c", color: "white" }
                : { color: "#666", textAlign: "left" }
            }
            onClick={() => {
              onSaveOrEdit();
              setOpen(false);
            }}
          >
            <Icon name={"pencil"} /> {editing ? "Save" : "Edit"}
          </Button>
        </Tooltip>
      )}
      <div
        style={{
          display: "flex",
          gap: "6px",
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        {renderActions("small")}
        <Button
          size="small"
          type="text"
          style={{ color: "#666" }}
          onClick={() => {
            onDownload();
            setOpen(false);
          }}
        >
          <Icon name="download" /> Download
        </Button>
      </div>
      <div style={{ color: "#888", fontSize: "11px" }}>
        {info ? info : "plain text"}, {content.split("\n").length} lines
      </div>
    </div>
  );

  return (
    <div
      style={{
        position: "absolute",
        top: 4,
        right: 4,
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
        value={content}
        noText
        style={{ color: "#666", background: "transparent" }}
      />
      <Popover
        trigger="click"
        open={open}
        onOpenChange={(next) => setOpen(next)}
        content={actionContent}
        placement="bottomRight"
      >
        <Button
          size="small"
          type="text"
          style={{
            boxShadow: "none",
            background: "transparent",
          }}
          aria-label="Code block actions"
        >
          <Icon name="ellipsis" rotate="90" />
        </Button>
      </Popover>
    </div>
  );
}

export const StaticElement: React.FC<RenderElementProps> = ({
  attributes,
  element,
  children,
}) => {
  if (element.type === "code_line") {
    return (
      <div
        {...attributes}
        className="cocalc-slate-code-line"
        style={{ position: "relative" }}
      >
        {children}
      </div>
    );
  }
  if (element.type != "code_block") {
    throw Error("bug");
  }

  const COLLAPSE_THRESHOLD_LINES = 6;
  const { disableMarkdownCodebar, project_id } = useFileContext();

  // we need both a ref and state, because editing is used both for the UI
  // state and also at once point directly to avoid saving the last change
  // after doing shift+enter.
  const editingRef = useRef<boolean>(false);
  const [editing, setEditing0] = useState<boolean>(false);
  const setEditing = (editing) => {
    editingRef.current = editing;
    setEditing0(editing);
  };

  const [newValue, setNewValue] = useState<string | null>(null);
  const runRef = useRef<any>(null);

  const [output, setOutput] = useState<null | ReactNode>(null);

  const { change, editor, setEditor } = useChange();
  const [history, setHistory] = useState<string[]>(
    getHistory(editor, element) ?? [],
  );
  useEffect(() => {
    const newHistory = getHistory(editor, element);
    if (newHistory != null && !isEqual(history, newHistory)) {
      setHistory(newHistory);
    }
  }, [change]);

  const [temporaryInfo, setTemporaryInfo] = useState<string | null>(null);
  useEffect(() => {
    setTemporaryInfo(null);
  }, [element.info]);

  const codeValue = newValue ?? getCodeBlockText(element);
  const lineCount = codeValue.split("\n").length;
  const shouldCollapse = lineCount > COLLAPSE_THRESHOLD_LINES;
  const [expanded, setExpanded] = useState<boolean>(false);
  const forceExpanded = editing;
  const isCollapsed = shouldCollapse && !expanded && !forceExpanded;

  const save = (value: string | null, run: boolean) => {
    setEditing(false);
    if (value != null && setEditor != null && editor != null) {
      // We just directly find it assuming it is a top level block for now.
      // We aren't using the slate library since in static mode right now
      // the editor isn't actually a slate editor object (yet).
      const editor2 = { children: [...editor.children] };
      for (let i = 0; i < editor2.children.length; i++) {
        if (element === editor.children[i]) {
          editor2.children[i] = {
            ...(element as any),
            children: toCodeLines(value),
          };
          setEditor(editor2);
          break;
        }
      }
    }
    if (!run) return;
    // have to wait since above causes re-render
    setTimeout(() => {
      runRef.current?.();
    }, 1);
  };

  const isMermaid = element.info == "mermaid";
  if (isMermaid) {
    return (
      <div {...attributes} style={{ marginBottom: "1em", textIndent: 0 }}>
        <Mermaid value={codeValue} />
      </div>
    );
  }

  // textIndent: 0 is needed due to task lists -- see https://github.com/sagemathinc/cocalc/issues/6074
  // editable since even CodeMirrorStatic is editable, but meant to be *ephemeral* editing.
  const renderedValue = newValue ?? codeValue;

  return (
    <div
      {...attributes}
      style={{ marginBottom: "1em", textIndent: 0, position: "relative" }}
    >
      {!disableMarkdownCodebar && (
        <FloatingActionMenu
          editing={editing}
          info={temporaryInfo ?? element.info}
          onSaveOrEdit={() => {
            if (editing) {
              save(newValue, false);
            } else {
              setEditing(true);
            }
          }}
          canEdit={!!project_id}
          content={renderedValue}
          onDownload={() => {
            const blob = new Blob([renderedValue], {
              type: "text/plain;charset=utf-8",
            });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            const ext = infoToMode(temporaryInfo ?? element.info) || "txt";
            link.download = `code-block.${ext}`;
            link.click();
            URL.revokeObjectURL(url);
          }}
          renderActions={(size = "small") => (
            <ActionButtons
              size={size}
              runRef={runRef}
              input={renderedValue}
              history={history}
              setOutput={setOutput}
              output={output}
              info={temporaryInfo ?? element.info}
              setInfo={(info) => {
                setTemporaryInfo(info);
              }}
            />
          )}
          collapseToggle={
            shouldCollapse
              ? {
                  label: isCollapsed ? "Show all" : "Collapse",
                  onClick: () => {
                    setExpanded((prev) => !prev);
                  },
                }
              : null
          }
        />
      )}
      {editing ? (
        <textarea
          value={renderedValue}
          spellCheck={false}
          onChange={(event) => {
            if (!editingRef.current) return;
            setNewValue(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.shiftKey && event.keyCode === 13) {
              save(newValue, true);
            }
          }}
          style={{
            width: "100%",
            minHeight: "120px",
            background: "white",
            padding: "10px 15px 10px 20px",
            border: "1px solid #dfdfdf",
            borderRadius: "8px",
            fontFamily: "monospace",
            fontSize: "13px",
          }}
        />
      ) : isCollapsed ? (
        <div
          style={{
            cursor: "default",
            padding: "8px 12px 10px 12px",
            background: "white",
            border: "1px solid #dfdfdf",
            borderRadius: "8px",
          }}
        >
          <pre
            className="cocalc-slate-code-block"
            style={{ margin: 0 }}
            dangerouslySetInnerHTML={{
              __html: highlightCodeHtml(
                renderedValue
                  .split("\n")
                  .slice(0, COLLAPSE_THRESHOLD_LINES)
                  .join("\n"),
                temporaryInfo ?? element.info,
              ),
            }}
          />
          <div style={{ marginTop: "6px", fontSize: "12px", color: "#666" }}>
            {lineCount} lines (collapsed)
          </div>
        </div>
      ) : (
        <pre
          className="cocalc-slate-code-block"
          style={{ margin: 0 }}
          dangerouslySetInnerHTML={{
            __html: highlightCodeHtml(renderedValue, temporaryInfo ?? element.info),
          }}
        />
      )}
      {!disableMarkdownCodebar && output != null && (
        <div
          style={{
            borderTop: "1px dashed #ccc",
            background: "white",
            padding: "5px 0 5px 30px",
          }}
        >
          {output}
        </div>
      )}
    </div>
  );
};

export function toSlate({ token }) {
  // fence =block of code with ``` around it, but not indented.
  let value = token.content;

  // We remove the last carriage return (right before ```), since it
  // is much easier to do that here...
  if (value[value.length - 1] == "\n") {
    value = value.slice(0, value.length - 1);
  }
  const info = token.info ?? "";
  if (typeof info != "string") {
    throw Error("info must be a string");
  }
  return {
    type: "code_block",
    fence: token.type == "fence",
    info,
    children: toCodeLines(value),
  } as Element;
}

function sizeEstimator({ node, fontSize }): number {
  return getCodeBlockLineCount(node as any) * (fontSize + 2) + 10 + fontSize;
}

register({
  slateType: "code_block",
  markdownType: ["fence", "code_block"],
  StaticElement,
  toSlate,
  sizeEstimator,
});

register({
  slateType: "code_line",
  StaticElement,
  fromSlate: ({ children }) => `${children}\n`,
});
