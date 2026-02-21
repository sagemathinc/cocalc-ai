/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Static registration for jupyter_code_cell.
Uses the same rendering path as code_block, but keeps a distinct type so
Jupyter projections can carry stable cell ids and cell-level metadata.
*/

import { register } from "../register";
import { StaticElement, sizeEstimator } from "../code-block/index";

register({
  slateType: "jupyter_code_cell",
  StaticElement,
  sizeEstimator,
});
