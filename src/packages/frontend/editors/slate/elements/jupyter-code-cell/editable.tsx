/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Editable registration for jupyter_code_cell.
This reuses the existing code-like editor behavior while introducing a
distinct slate type for notebook-cell-aware workflows.
*/

import { register } from "../register";
import { CodeLikeEditor, fromSlate } from "../code-block/editable";

register({
  slateType: "jupyter_code_cell",
  Element: CodeLikeEditor,
  fromSlate,
  rules: {
    autoFocus: true,
    autoAdvance: true,
  },
});
