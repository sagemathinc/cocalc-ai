/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Editor, Element, Path, Point, Range, Transforms } from "slate";
import { getNodeAt } from "../slate-util";

const FORWARD_DELETE_BLOCK_TYPES = new Set<string>([
  "code_block",
  "html_block",
  "meta",
  "math_block",
]);

export const withDeleteForward = (editor) => {
  const { deleteForward } = editor;

  editor.deleteForward = (...args) => {
    if (!customDeleteForward(editor)) {
      deleteForward(...args);
    }
  };

  return editor;
};

function customDeleteForward(editor: Editor): boolean | undefined {
  const { selection } = editor;
  if (!selection || !Range.isCollapsed(selection)) return;

  const above = Editor.above(editor, {
    match: (node) => Element.isElement(node) && Editor.isBlock(editor, node),
    mode: "lowest",
  });
  if (!above) return;
  const [block, path] = above;
  if (!Element.isElement(block)) return;

  const end = Editor.end(editor, path);
  if (!Point.equals(selection.focus, end)) return;

  const nextPath = Path.next(path);
  const nextNode = getNodeAt(editor, nextPath);
  if (Element.isElement(nextNode) && nextNode.type === "paragraph" && nextNode["spacer"]) {
    const afterPath = Path.next(nextPath);
    const afterNode = getNodeAt(editor, afterPath);
    if (Element.isElement(afterNode) && FORWARD_DELETE_BLOCK_TYPES.has(afterNode.type)) {
      Transforms.removeNodes(editor, { at: afterPath });
      Transforms.removeNodes(editor, { at: nextPath });
      return true;
    }
  }
  if (Element.isElement(nextNode) && FORWARD_DELETE_BLOCK_TYPES.has(nextNode.type)) {
    Transforms.removeNodes(editor, { at: nextPath });
    return true;
  }
}

