/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createEditor } from "../frame-tree/editor";
import { terminal } from "./terminal-spec";

export { terminal } from "./terminal-spec";

export const Editor = createEditor({
  format_bar: false,
  editor_spec: { terminal },
  display_name: "TerminalEditor",
});
