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
  const { selectedCellId, setSelectedCellId, gapCursor, setGapCursor } =
    useJupyterCellContext();
  const isSelected = !!cellId && selectedCellId === cellId;
  const path = ReactEditor.findPath(editor as any, element as any);
  const topIndex = path[0];
  const beforeActive =
    gapCursor?.index === topIndex && gapCursor.side === "before";
  const afterActive = gapCursor?.index === topIndex && gapCursor.side === "after";
  useEffect(() => {
    if (!cellId || !focused || !selected) return;
    setSelectedCellId?.(cellId);
    setGapCursor?.(null);
  }, [cellId, focused, selected, setSelectedCellId]);
  return (
    <div
      {...attributes}
      data-cocalc-test="jupyter-singledoc-markdown-cell"
      data-cocalc-cell-id={cellId}
      onMouseDown={() => setGapCursor?.(null)}
      style={
        isSelected
          ? {
              border: "1px solid #91caff",
              borderRadius: "6px",
              padding: "2px 8px",
              background: "#fff",
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
    </div>
  );
}

register({
  slateType: "jupyter_markdown_cell",
  Element: JupyterMarkdownCellElement,
  fromSlate: ({ children }) => children,
});
