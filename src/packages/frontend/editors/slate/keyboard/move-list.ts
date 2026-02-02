/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { moveListItemDown, moveListItemUp } from "../format/list-move";
import { register } from "./register";

function moveListUp({ editor }) {
  return moveListItemUp(editor);
}

function moveListDown({ editor }) {
  return moveListItemDown(editor);
}

const upKeys = [{ key: "ArrowUp", ctrl: true, shift: true }];

const downKeys = [{ key: "ArrowDown", ctrl: true, shift: true }];

register(upKeys, moveListUp);
register(downKeys, moveListDown);
