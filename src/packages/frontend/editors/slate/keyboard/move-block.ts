/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { register, IS_MACOS } from "./register";
import type { SlateEditor } from "../types";
import { moveListItemDown, moveListItemUp } from "../format/list-move";

function moveBlock(editor: SlateEditor, direction: "up" | "down"): boolean {
  if (direction === "up" && moveListItemUp(editor)) {
    return true;
  }
  if (direction === "down" && moveListItemDown(editor)) {
    return true;
  }
  return false;
}

const moveUpKey = IS_MACOS
  ? { key: "ArrowUp", ctrl: true, meta: true }
  : { key: "ArrowUp", ctrl: true, shift: true };
const moveDownKey = IS_MACOS
  ? { key: "ArrowDown", ctrl: true, meta: true }
  : { key: "ArrowDown", ctrl: true, shift: true };

register(moveUpKey, ({ editor }) => moveBlock(editor, "up"));
register(moveDownKey, ({ editor }) => moveBlock(editor, "down"));
