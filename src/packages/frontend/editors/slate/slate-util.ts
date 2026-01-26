/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Node,
  Location,
  Editor,
  Element,
  Range,
  Path,
  Point,
  Text,
} from "slate";

export function containingBlock(editor: Editor): undefined | [Node, Location] {
  for (const x of Editor.nodes(editor, {
    match: (node) => Element.isElement(node) && Editor.isBlock(editor, node),
  })) {
    return x;
  }
}

export function getNodeAt(editor: Editor, path: Path): undefined | Node {
  try {
    return Editor.node(editor, path)[0];
  } catch (_) {
    return;
  }
}

function docStart(editor: Editor): Point {
  try {
    return Editor.start(editor, []);
  } catch (_) {
    // Fall back to the first text node so selection always points to a leaf.
    for (const [node, path] of Editor.nodes(editor, {
      at: [],
      match: (n) => Text.isText(n),
    })) {
      const text = node as Text;
      const nextOffset = Math.max(0, Math.min(0, text.text.length));
      return { path, offset: nextOffset };
    }
    return { path: [0], offset: 0 };
  }
}

export function pointAtPath(
  editor: Editor,
  path: Path,
  offset?: number,
  edge: "start" | "end" = "start",
): Point {
  try {
    if (!Node.has(editor, path)) {
      return docStart(editor);
    }
    const point =
      edge === "end" ? Editor.end(editor, path) : Editor.start(editor, path);
    if (offset == null) return point;
    const [node] = Editor.node(editor, point);
    if (Text.isText(node)) {
      const nextOffset = Math.max(0, Math.min(offset, node.text.length));
      return { path: point.path, offset: nextOffset };
    }
    return point;
  } catch (_) {
    return docStart(editor);
  }
}

export function ensurePoint(
  editor: Editor,
  point?: Point | null,
): Point {
  if (point == null) {
    return docStart(editor);
  }
  try {
    const [node] = Editor.node(editor, point);
    if (Text.isText(node)) {
      return point;
    }
  } catch (_) {
    // fall through to coercion
  }
  return pointAtPath(editor, point.path, point.offset);
}

export function ensureRange(
  editor: Editor,
  range?: Range | null,
): Range {
  if (range == null) {
    const point = docStart(editor);
    return { anchor: point, focus: point };
  }
  const anchor = ensurePoint(editor, range.anchor);
  const focus = ensurePoint(editor, range.focus);
  return { anchor, focus };
}

// Range that contains the entire document.
export function rangeAll(editor: Editor): Range {
  const first = pointAtPath(editor, [], 0, "start");
  const last = pointAtPath(editor, [], undefined, "end");
  const offset = last.offset;
  return {
    anchor: first,
    focus: { path: last.path, offset },
  };
}

// Range that goes from selection focus to
// end of the document.
export function rangeToEnd(editor: Editor): Range {
  if (editor.selection == null) return rangeAll(editor);
  const last = pointAtPath(editor, [], undefined, "end");
  return {
    anchor: ensurePoint(editor, editor.selection.focus),
    focus: last,
  };
}

export function rangeFromStart(editor: Editor): Range {
  if (editor.selection == null) return rangeAll(editor);
  const first = pointAtPath(editor, [], 0, "start");
  return {
    anchor: first,
    focus: ensurePoint(editor, editor.selection.focus),
  };
}
