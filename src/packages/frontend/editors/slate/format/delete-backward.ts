/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Range, Editor, Element, Path, Point, Text, Transforms, Node } from "slate";
import { isWhitespaceParagraph } from "../padding";
import { isCodeLikeBlockType } from "../elements/code-block/utils";

const BACKWARD_DELETE_BLOCK_TYPES = new Set<string>([
  "code_block",
  "jupyter_code_cell",
  "html_block",
  "meta",
  "math_block",
]);

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

  const codeLineEntry = Editor.above(editor, {
    match: (node) => Element.isElement(node) && node.type === "code_line",
    mode: "lowest",
  });
  if (codeLineEntry != null) {
    const [lineNode, linePath] = codeLineEntry;
    const lineIndex = linePath[linePath.length - 1];
    if (selection.anchor.offset === 0) {
      if (lineIndex > 0) {
        const lineText = Node.string(lineNode);
        const prevPath = Path.previous(linePath);
        Transforms.removeNodes(editor, { at: linePath });
        const prevEnd = Editor.end(editor, prevPath);
        if (lineText !== "") {
          Transforms.insertText(editor, lineText, { at: prevEnd });
        }
        const nextPoint = {
          path: prevEnd.path,
          // Keep cursor at the join boundary (between old and inserted text).
          offset: prevEnd.offset,
        };
        Transforms.select(editor, nextPoint);
        return true;
      }
    }
    if (selection.anchor.offset === 0 && lineIndex === 0) {
      const codeBlockEntry = Editor.above(editor, {
        at: linePath,
        match: (node) => Element.isElement(node) && isCodeLikeBlockType(node.type),
      });
      if (codeBlockEntry != null) {
        // Do nothing at the very start of a code block.
        return true;
      }
    }
  }

  const above = Editor.above(editor, {
    match: (node) => Element.isElement(node) && Editor.isBlock(editor, node),
    mode: "lowest",
  });
  if (above == null) return;
  const [block, path] = above;
  if (Editor.isEditor(block) || !Element.isElement(block)) return;
  const start = Editor.start(editor, path);
  if (!Point.equals(selection.anchor, start)) return;

  if (block.type === "paragraph" && block["spacer"] === true) {
    if (path[path.length - 1] > 0) {
      const prevPath = Path.previous(path);
      const prevNode = Editor.node(editor, prevPath)[0] as any;
      if (Element.isElement(prevNode) && BACKWARD_DELETE_BLOCK_TYPES.has(prevNode.type)) {
        Transforms.removeNodes(editor, { at: prevPath });
        // After removing the previous block, the spacer shifts to prevPath.
        const targetPath = prevPath;
        Transforms.setNodes(editor, { spacer: false } as any, { at: targetPath });
        const start = Editor.start(editor, targetPath);
        Transforms.select(editor, start);
        return true;
      }
    }
  }

  if (block.type === "paragraph") {
    const quoteEntry = Editor.above(editor, {
      at: path,
      match: (node) => Element.isElement(node) && node.type === "blockquote",
      mode: "lowest",
    });
    if (quoteEntry != null) {
      const [, quotePath] = quoteEntry;
      // At the start of a quoted paragraph with an empty quoted sibling above,
      // remove that empty quoted line instead of delegating to Slate's default
      // merge behavior, which can corrupt quote structure.
      if (path.length === quotePath.length + 1 && path[path.length - 1] > 0) {
        const prevSiblingPath = Path.previous(path);
        const prevSibling = Editor.node(editor, prevSiblingPath)[0] as any;
        if (
          Element.isElement(prevSibling) &&
          prevSibling.type === "paragraph" &&
          isWhitespaceParagraph(prevSibling)
        ) {
          Editor.withoutNormalizing(editor, () => {
            Transforms.removeNodes(editor, { at: prevSiblingPath });
            const shiftedPath = Path.previous(path);
            const start = Editor.start(editor, shiftedPath);
            Transforms.select(editor, start);
          });
          return true;
        }
      }
    }

    if (path[path.length - 1] > 1 && isWhitespaceParagraph(block)) {
      const prevPath = Path.previous(path);
      const prevNode = Editor.node(editor, prevPath)[0] as any;
      if (Element.isElement(prevNode) && BACKWARD_DELETE_BLOCK_TYPES.has(prevNode.type)) {
        Transforms.removeNodes(editor, { at: prevPath });
        return true;
      }
    }
    if (path[path.length - 1] > 1) {
      const immediatePrevPath = Path.previous(path);
      const immediatePrevNode = Editor.node(editor, immediatePrevPath)[0] as any;
      if (
        Element.isElement(immediatePrevNode) &&
        immediatePrevNode.type === "paragraph" &&
        isWhitespaceParagraph(immediatePrevNode)
      ) {
        const quotePath = Path.previous(immediatePrevPath);
        const quoteNode = Editor.node(editor, quotePath)[0] as any;
        if (Element.isElement(quoteNode) && quoteNode.type === "blockquote") {
          Editor.withoutNormalizing(editor, () => {
            Transforms.removeNodes(editor, { at: immediatePrevPath });
            const shiftedPath = Path.previous(path);
            pullParagraphIntoPreviousBlockquote(editor, shiftedPath);
          });
          return true;
        }
      }
    }
    if (path[path.length - 1] > 0 && isWhitespaceParagraph(block)) {
      const prevPath = Path.previous(path);
      const prevNode = Editor.node(editor, prevPath)[0] as any;
      if (Element.isElement(prevNode) && BACKWARD_DELETE_BLOCK_TYPES.has(prevNode.type)) {
        Transforms.removeNodes(editor, { at: prevPath });
        return true;
      }
    }
    if (pullParagraphIntoPreviousBlockquote(editor, path)) {
      return true;
    }
    return;
  }

  // This is where we actually might do something special, finally.
  // Cursor is at the beginning of a non-paragraph block-level
  // element, so maybe do something special.
  switch (block.type) {
    case "code_block":
    case "jupyter_code_cell":
      // Do not delete entire code blocks when backspacing at start.
      return true;
    case "heading":
      deleteBackwardsHeading(editor, block, path);
      return true;
  }
}

function pullParagraphIntoPreviousBlockquote(editor: Editor, path: Path): boolean {
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

  Editor.withoutNormalizing(editor, () => {
    // Remove trailing empty quote paragraphs so joins prefer meaningful text.
    while (true) {
      const quoteNode = Editor.node(editor, prevPath)[0] as Element;
      if (!Array.isArray(quoteNode.children) || quoteNode.children.length <= 1) {
        break;
      }
      const lastIndex = quoteNode.children.length - 1;
      const lastPath = prevPath.concat(lastIndex);
      const lastNode = Editor.node(editor, lastPath)[0];
      const nodeText = Node.string(lastNode as any);
      if (
        !Element.isElement(lastNode) ||
        lastNode.type !== "paragraph" ||
        nodeText !== ""
      ) {
        break;
      }
      Transforms.removeNodes(editor, { at: lastPath });
    }

    const quoteAfterTrim = Editor.node(editor, prevPath)[0] as Element;
    const insertIndex = quoteAfterTrim.children.length;
    const targetPath = prevPath.concat(insertIndex);
    const mergeTargetPath =
      insertIndex > 0 ? prevPath.concat(insertIndex - 1) : undefined;
    const joinBoundary =
      mergeTargetPath != null ? Editor.end(editor, mergeTargetPath) : undefined;

    Transforms.moveNodes(editor, { at: path, to: targetPath });
    if (mergeTargetPath != null && joinBoundary != null) {
      const movedNode = Editor.node(editor, targetPath)[0];
      const mergeTargetNode = Editor.node(editor, mergeTargetPath)[0];
      if (
        Element.isElement(movedNode) &&
        Element.isElement(mergeTargetNode) &&
        movedNode.type === "paragraph" &&
        mergeTargetNode.type === "paragraph"
      ) {
        const insertPoint = Editor.end(editor, mergeTargetPath);
        const movedChildren = JSON.parse(
          JSON.stringify((movedNode as any).children ?? []),
        );
        if (Array.isArray(movedChildren) && movedChildren.length > 0) {
          Transforms.insertFragment(editor, movedChildren as any, {
            at: insertPoint,
          } as any);
        }
        Transforms.removeNodes(editor, { at: targetPath });
        Transforms.select(editor, joinBoundary);
        return;
      }
    }

    try {
      const start = Editor.start(editor, targetPath);
      Transforms.select(editor, start);
    } catch {
      // If normalization changed the moved path shape, fall back to selecting
      // the end of the blockquote to avoid throwing.
      const end = Editor.end(editor, prevPath);
      Transforms.select(editor, end);
    }
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
