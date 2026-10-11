/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Register the web browser editor (.browser files)
*/

import { register_file_editor } from "../frame-tree/register";

register_file_editor({
  icon: "global",
  ext: "browser",
  editor: async () => await import("./editor"),
  actions: async () => await import("./actions"),
});
