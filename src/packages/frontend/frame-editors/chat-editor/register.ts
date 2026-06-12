/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Register the chatroom editor
*/

import { register_file_editor } from "../frame-tree/register";
import { Actions } from "./actions";
import { Editor } from "./editor";

register_file_editor({
  ext: "sage-chat",
  component: Editor,
  Actions,
});

register_file_editor({
  ext: "chat",
  component: Editor,
  Actions,
});
