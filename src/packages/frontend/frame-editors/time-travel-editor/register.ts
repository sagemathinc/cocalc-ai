/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Register the TimeTravel frame tree editor
*/

import { register_file_editor } from "../frame-tree/register";

register_file_editor({
  ext: "time-travel",
  asyncData: async () => {
    const [{ Editor }, { TimeTravelActions }] = await Promise.all([
      import("./editor"),
      import("./actions"),
    ]);
    return { component: Editor, Actions: TimeTravelActions };
  },
});
