/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Editor, Element, Range, Transforms } from "slate";
import { register } from "./register";
import { isCodeLikeBlockType } from "../elements/code-block/utils";

function splitCodeBlock({ editor }) {
  const { selection } = editor;
  if (!selection || !Range.isCollapsed(selection)) {
    return false;
  }
  const entry = Editor.above(editor, {
    match: (node) => Element.isElement(node) && isCodeLikeBlockType(node.type),
  });
  if (!entry) return false;
  Editor.withoutNormalizing(editor, () => {
    Transforms.splitNodes(editor, {
      at: selection,
      match: (node) => Element.isElement(node) && isCodeLikeBlockType(node.type),
    });
  });
  return true;
}

register([{ key: ";", ctrl: true }], splitCodeBlock);
