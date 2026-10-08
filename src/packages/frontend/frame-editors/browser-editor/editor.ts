/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Top-level React component for a .browser file: a web browser in the project
that agents can drive (`cocalc project browser ... --browser <file>`).
*/

import { set } from "@cocalc/util/misc";
import { createEditor } from "../frame-tree/editor";
import { EditorDescription } from "../frame-tree/types";
import { BrowserFrame } from "./browser-frame";

export const browser: EditorDescription = {
  type: "browser",
  short: "Browser",
  name: "Web browser",
  icon: "global",
  component: BrowserFrame,
  commands: set(["reload", "help"]),
} as const;

const EDITOR_SPEC = {
  browser,
} as const;

export const Editor = createEditor({
  format_bar: false,
  editor_spec: EDITOR_SPEC,
  display_name: "Web browser",
});
