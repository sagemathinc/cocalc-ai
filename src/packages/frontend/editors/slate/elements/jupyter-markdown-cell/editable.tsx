/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { register, RenderElementProps } from "../register";
import { useFocused, useSelected } from "../hooks";
import { useJupyterCellContext } from "../../jupyter-cell-context";
import { useEffect } from "react";

function JupyterMarkdownCellElement({
  attributes,
  children,
  element,
}: RenderElementProps) {
  if (element.type !== "jupyter_markdown_cell") {
    throw Error("bug");
  }
  const focused = useFocused();
  const selected = useSelected();
  const cellId = `${(element as any).cell_id ?? ""}`.trim();
  const { selectedCellId, setSelectedCellId } = useJupyterCellContext();
  const isSelected = !!cellId && selectedCellId === cellId;
  useEffect(() => {
    if (!cellId || !focused || !selected) return;
    setSelectedCellId?.(cellId);
  }, [cellId, focused, selected, setSelectedCellId]);
  return (
    <div
      {...attributes}
      data-cocalc-test="jupyter-singledoc-markdown-cell"
      data-cocalc-cell-id={cellId}
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
      {children}
    </div>
  );
}

register({
  slateType: "jupyter_markdown_cell",
  Element: JupyterMarkdownCellElement,
  fromSlate: ({ children }) => children,
});
