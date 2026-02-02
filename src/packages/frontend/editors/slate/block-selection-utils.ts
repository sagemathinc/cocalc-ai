/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Descendant, Editor, Node, Point, Text } from "slate";
import type { SlateEditor } from "./types";
import { pointAtPath } from "./slate-util";

export function pointFromOffsetInDoc(
  doc: Descendant[],
  offset: number,
): { path: number[]; offset: number } {
  let curOffset = 0;
  const root: Node = { children: doc } as any;

  for (const [node, path] of Node.texts(root)) {
    const { text } = node;

    if (curOffset + text.length >= offset) {
      return { path, offset: offset - curOffset };
    }

    curOffset += text.length;
  }

  return Editor.start(root as any, [0]);
}

export function blockSelectionPoint(
  editor: SlateEditor,
  position: "start" | "end",
): Point {
  try {
    const children = editor.children as Descendant[];
    const text = Node.string({ children } as any);
    const offset = position === "start" ? 0 : text.length;
    return pointFromOffsetInDoc(children, offset);
  } catch {
    // fall through to default point
  }
  const fallbackPath = position === "start" ? [0] : [0];
  return pointAtPath(editor, fallbackPath, undefined, position);
}

export function normalizePointForDoc(
  root: Node,
  point: { path: number[]; offset: number },
  edge: "start" | "end",
) {
  try {
    const node = Node.get(root, point.path);
    if (Text.isText(node)) {
      return point;
    }
    return Editor[edge](root as any, point.path);
  } catch {
    return null;
  }
}
