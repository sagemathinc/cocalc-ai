/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Editor, Element, Range, Text, Transforms } from "slate";

export function autoformatBlockquoteAtStart(editor: Editor): boolean {
  const { selection } = editor;
  if (selection == null || !Range.isCollapsed(selection)) {
    return false;
  }

  let node;
  try {
    [node] = Editor.node(editor, selection.focus.path);
  } catch {
    return false;
  }

  if (!Text.isText(node)) {
    return false;
  }

  const path = selection.focus.path;
  const pos = path[path.length - 1];
  if (path.length !== 2 || pos !== 0) {
    return false;
  }

  if (!node.text.startsWith(">")) {
    return false;
  }

  if (selection.anchor.offset !== 1 || selection.focus.offset !== 1) {
    return false;
  }

  const blockPath = path.slice(0, path.length - 1);

  Editor.withoutNormalizing(editor, () => {
    Transforms.delete(editor, {
      at: { path, offset: 0 },
      distance: 1,
    });
    Transforms.wrapNodes(editor, { type: "blockquote" } as Element, {
      at: blockPath,
      match: (node) => Element.isElement(node) && Editor.isBlock(editor, node),
      mode: "lowest",
    });
  });

  return true;
}
