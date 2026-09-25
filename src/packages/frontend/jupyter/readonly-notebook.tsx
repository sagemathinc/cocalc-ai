/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { fromJS, List, Map } from "immutable";
import type { MutableRefObject } from "react";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { sorted_cell_list } from "@cocalc/jupyter/util/cell-utils";
import { DEFAULT_FONT_SIZE } from "@cocalc/util/consts/ui";
import { path_split } from "@cocalc/util/misc";
import { CellList } from "./cell-list";
import { cm_options } from "./cm_options";

export interface ReadonlyNotebookDocument {
  get(query: { type: "cell" }): List<Map<string, any>> | undefined;
}

export function readonlyNotebookCells(doc: ReadonlyNotebookDocument) {
  let cells = Map<string, any>();
  doc.get({ type: "cell" })?.forEach((cell) => {
    cells = cells.set(cell.get("id"), cell);
  });
  return { cells, cell_list: sorted_cell_list(cells) };
}

/** Render an observed document, without owning a session or execution actions. */
export function ReadonlyNotebook({
  project_id,
  path,
  doc,
  font_size,
  scrollPosition,
}: {
  project_id: string;
  path: string;
  doc: ReadonlyNotebookDocument;
  font_size?: number;
  scrollPosition?: MutableRefObject<number>;
}) {
  const accountFontSize = useTypedRedux("account", "font_size");
  const { cells, cell_list } = readonlyNotebookCells(doc);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        overflowY: "hidden",
      }}
    >
      <CellList
        cell_list={cell_list}
        cells={cells}
        font_size={font_size ?? accountFontSize ?? DEFAULT_FONT_SIZE}
        mode="escape"
        cm_options={fromJS({ markdown: undefined, options: cm_options() })}
        project_id={project_id}
        directory={path_split(path).head}
        trust={false}
        read_only={true}
        scrollPosition={scrollPosition}
      />
    </div>
  );
}
