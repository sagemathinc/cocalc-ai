/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { register, RenderElementProps } from "../register";
import { useFocused, useSelected } from "../hooks";
import { useJupyterCellContext } from "../../jupyter-cell-context";
import { useEffect } from "react";
import { useSlate, ReactEditor } from "../../slate-react";
import { CSSProperties } from "react";
import { Button } from "antd";
import { Icon } from "@cocalc/frontend/components";

function gapCursorStyle(active: boolean): CSSProperties {
  return {
    height: "10px",
    margin: "2px 0",
    cursor: "text",
    position: "relative",
    zIndex: 2,
    ...(active
      ? { borderTop: "2px solid #1677ff" }
      : { borderTop: "2px solid transparent" }),
  };
}

function JupyterMarkdownCellElement({
  attributes,
  children,
  element,
}: RenderElementProps) {
  if (element.type !== "jupyter_markdown_cell") {
    throw Error("bug");
  }
  const editor = useSlate();
  const focused = useFocused();
  const selected = useSelected();
  const cellId = `${(element as any).cell_id ?? ""}`.trim();
  const {
    selectedCellId,
    setSelectedCellId,
    gapCursor,
    setGapCursor,
    insertCellAtEnd,
  } = useJupyterCellContext();
  const isSelected = !!cellId && selectedCellId === cellId;
  const path = ReactEditor.findPath(editor as any, element as any);
  const topIndex = path[0];
  const isLastCell = topIndex === editor.children.length - 1;
  const beforeActive =
    gapCursor?.index === topIndex && gapCursor.side === "before";
  const afterActive = gapCursor?.index === topIndex && gapCursor.side === "after";
  useEffect(() => {
    if (!cellId || !focused || !selected) return;
    setSelectedCellId?.(cellId);
    setGapCursor?.(null);
  }, [cellId, focused, selected, setSelectedCellId, setGapCursor]);
  return (
    <div
      {...attributes}
      data-cocalc-test="jupyter-singledoc-markdown-cell"
      data-cocalc-cell-id={cellId}
      data-jupyter-lazy-cell-id={cellId}
      onMouseDown={() => {
        if (cellId) {
          setSelectedCellId?.(cellId);
        }
        setGapCursor?.(null);
      }}
      onFocusCapture={() => {
        if (cellId) {
          setSelectedCellId?.(cellId);
        }
        setGapCursor?.(null);
      }}
      style={
        isSelected
          ? {
              background: "rgba(22, 119, 255, 0.04)",
              borderRadius: "4px",
            }
          : undefined
      }
    >
      <div
        contentEditable={false}
        data-cocalc-test="jupyter-singledoc-gap-before"
        data-cocalc-cell-id={cellId}
        style={gapCursorStyle(beforeActive)}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setGapCursor?.({ index: topIndex, side: "before" });
        }}
      />
      {children}
      <div
        contentEditable={false}
        data-cocalc-test="jupyter-singledoc-gap-after"
        data-cocalc-cell-id={cellId}
        style={gapCursorStyle(afterActive)}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setGapCursor?.({ index: topIndex, side: "after" });
        }}
      />
      {isLastCell ? (
        <div
          contentEditable={false}
          data-cocalc-test="jupyter-singledoc-bottom-insert"
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "8px",
            marginTop: "6px",
            marginBottom: "2px",
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <Button
            size="small"
            type="text"
            style={{ color: "#333", padding: 0, height: "20px" }}
            onClick={() => insertCellAtEnd?.("code")}
          >
            <Icon name="code" /> Code
          </Button>
          <Button
            size="small"
            type="text"
            style={{ color: "#333", padding: 0, height: "20px" }}
            onClick={() => insertCellAtEnd?.("markdown")}
          >
            <Icon name="file-alt" /> Text
          </Button>
        </div>
      ) : null}
    </div>
  );
}

register({
  slateType: "jupyter_markdown_cell",
  Element: JupyterMarkdownCellElement,
  fromSlate: ({ children }) => children,
});
