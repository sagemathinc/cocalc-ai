/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { register, RenderElementProps } from "../register";

function JupyterMarkdownCellElement({
  attributes,
  children,
  element,
}: RenderElementProps) {
  if (element.type !== "jupyter_markdown_cell") {
    throw Error("bug");
  }
  return (
    <div
      {...attributes}
      data-cocalc-test="jupyter-singledoc-markdown-cell"
      data-cocalc-cell-id={`${(element as any).cell_id ?? ""}`}
    >
      {children}
    </div>
  );
}

register({
  slateType: "jupyter_markdown_cell",
  StaticElement: JupyterMarkdownCellElement,
});
