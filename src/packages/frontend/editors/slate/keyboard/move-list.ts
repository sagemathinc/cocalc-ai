/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { moveListItemDown, moveListItemUp } from "../format/list-move";
import { register, IS_MACOS } from "./register";

function moveListUp({ editor }) {
  return moveListItemUp(editor);
}

function moveListDown({ editor }) {
  return moveListItemDown(editor);
}

const upKeys = IS_MACOS
  ? [{ key: "ArrowUp", ctrl: true, meta: true }]
  : [{ key: "ArrowUp", ctrl: true, shift: true }];

const downKeys = IS_MACOS
  ? [{ key: "ArrowDown", ctrl: true, meta: true }]
  : [{ key: "ArrowDown", ctrl: true, shift: true }];

register(upKeys, moveListUp);
register(downKeys, moveListDown);
