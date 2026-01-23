/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Range, Editor, Element, Path, Point, Text, Transforms } from "slate";

export const withDeleteBackward = (editor) => {
  const { deleteBackward } = editor;

  editor.deleteBackward = (...args) => {
    if (!customDeleteBackwards(editor)) {
      // no custom handling, so just do the default:
      deleteBackward(...args);
    }
  };

  return editor;
};

function customDeleteBackwards(editor: Editor): boolean | undefined {
  // Figure out first if we should so something special:
  const { selection } = editor;
  if (selection == null || !Range.isCollapsed(selection)) return;

  const above = Editor.above(editor, {
    match: (node) => Element.isElement(node) && Editor.isBlock(editor, node),
    mode: "lowest",
  });
  if (above == null) return;
  const [block, path] = above;
  if (Editor.isEditor(block) || !Element.isElement(block)) return;
  const start = Editor.start(editor, path);
  if (!Point.equals(selection.anchor, start)) return;

  if (block.type === "paragraph") {
    if (pullParagraphIntoEmptyBlockquote(editor, path)) {
      return true;
    }
    return;
  }

  // This is where we actually might do something special, finally.
  // Cursor is at the beginning of a non-paragraph block-level
  // element, so maybe do something special.
  switch (block.type) {
    case "heading":
      deleteBackwardsHeading(editor, block, path);
      return true;
  }
}

function pullParagraphIntoEmptyBlockquote(editor: Editor, path: Path): boolean {
  if (path[path.length - 1] === 0) return false;
  const prevPath = Path.previous(path);
  let prevNode;
  try {
    [prevNode] = Editor.node(editor, prevPath);
  } catch {
    return false;
  }
  if (!Element.isElement(prevNode) || prevNode.type !== "blockquote") {
    return false;
  }
  if (Editor.string(editor, prevPath) !== "") {
    return false;
  }

  Editor.withoutNormalizing(editor, () => {
    const quoteNode = Editor.node(editor, prevPath)[0] as Element;
    if (quoteNode.children.length > 0) {
      const lastIndex = quoteNode.children.length - 1;
      const lastPath = prevPath.concat(lastIndex);
      if (Editor.string(editor, lastPath) === "") {
        Transforms.removeNodes(editor, { at: lastPath });
      }
    }
    const updatedQuote = Editor.node(editor, prevPath)[0] as Element;
    const insertIndex = updatedQuote.children.length;
    const targetPath = prevPath.concat(insertIndex);
    Transforms.moveNodes(editor, { at: path, to: targetPath });
    const start = Editor.start(editor, targetPath);
    Transforms.select(editor, start);
  });

  return true;
}

// Special handling at beginning of heading.
function deleteBackwardsHeading(editor: Editor, block: Element, path: Path) {
  if (Text.isText(block.children[0])) {
    Transforms.setNodes(
      editor,
      {
        type: "paragraph",
      },
      { at: path }
    );
  } else {
    Transforms.unwrapNodes(editor, {
      match: (node) => Element.isElement(node),
      split: true,
      mode: "lowest",
      at: path,
    });
  }
}
