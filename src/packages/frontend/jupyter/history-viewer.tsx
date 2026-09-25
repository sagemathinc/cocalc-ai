/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
History viewer for Jupyter notebooks
*/

import { ReadonlyNotebook, readonlyNotebookCells } from "./readonly-notebook";
import type { ReadonlyNotebookDocument } from "./readonly-notebook";

// The time-travel viewer passes generic editor props before its document loads.
export function HistoryViewer(props) {
  if (!props.doc) return null;
  return <ReadonlyNotebook {...props} />;
}

// The following is just for integrating the history viewer.
import { export_to_ipynb } from "@cocalc/jupyter/ipynb/export-to-ipynb";

export function to_ipynb(doc: ReadonlyNotebookDocument): object {
  const { cells, cell_list } = readonlyNotebookCells(doc);
  return export_to_ipynb({ cells: cells.toJS(), cell_list: cell_list.toJS() });
}
