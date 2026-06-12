/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Register the chatroom editor
*/

import { register_file_editor } from "../frame-tree/register";

register_file_editor({
  ext: "sage-chat",
  asyncData: async () => await import("./loader"),
});

register_file_editor({
  ext: "chat",
  asyncData: async () => await import("./loader"),
});
