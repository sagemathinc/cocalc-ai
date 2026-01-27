/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
What happens when you hit arrow keys. This defines arrow key behavior for our
Slate editor, including moving the cursor up and down, scrolling the window,
moving to the beginning or end of the document, and handling cases where
selections are not in the DOM.
*/

import { register } from "./register";
import {
  blocksCursor,
  moveCursorUp,
  moveCursorDown,
  moveCursorToBeginningOfBlock,
  isAtBeginningOfBlock,
  isAtEndOfBlock,
} from "../control";
import type { SlateEditor } from "../types";
import { ReactEditor } from "../slate-react";
import { Editor, Element, Transforms } from "slate";
import {
  clearGapCursor,
  getGapCursor,
  insertParagraphAtGap,
  setGapCursor,
} from "../gap-cursor";
import { pointAtPath } from "../slate-util";

function topLevelEntry(editor: SlateEditor): { element: Element; index: number } | null {
  const focus = editor.selection?.focus;
  if (!focus) return null;
  const index = focus.path[0];
  const [node] = Editor.node(editor, [index]);
  if (!Element.isElement(node)) return null;
  return { element: node, index };
}

function isParagraphElement(node: Element | null): boolean {
  return !!node && node.type === "paragraph";
}

function shouldUseGapCursor(
  editor: SlateEditor,
  direction: "up" | "down",
): boolean {
  const entry = topLevelEntry(editor);
  if (!entry) return false;
  const { element, index } = entry;
  const neighborIndex = direction === "up" ? index - 1 : index + 1;
  const hasNeighbor = neighborIndex >= 0 && neighborIndex < editor.children.length;
  const neighbor = hasNeighbor ? (Editor.node(editor, [neighborIndex])[0] as any) : null;
  const currentIsVoid = Editor.isVoid(editor, element);
  const neighborIsVoid =
    Element.isElement(neighbor) && Editor.isVoid(editor, neighbor);
  const currentIsParagraph = isParagraphElement(element);
  const neighborIsParagraph = Element.isElement(neighbor)
    ? isParagraphElement(neighbor)
    : false;
  return (
    !hasNeighbor ||
    currentIsVoid ||
    neighborIsVoid ||
    !currentIsParagraph ||
    !neighborIsParagraph
  );
}

function shouldOpenGapBeforeVoid(
  editor: SlateEditor,
  direction: "up" | "down",
): boolean {
  // Strategy: only open a gap cursor when the caret is on the visual edge
  // of the current block (first line for up, last line for down) and the
  // adjacent top-level block is void. We use DOM line boxes (client rects)
  // to avoid confusing wrapped lines with true block boundaries.
  const cur = editor.selection?.focus;
  if (!cur) {
    return false;
  }
  const neighborIndex = direction === "up" ? cur.path[0] - 1 : cur.path[0] + 1;
  if (neighborIndex < 0 || neighborIndex >= editor.children.length) {
    return false;
  }
  const [neighbor] = Editor.node(editor, [neighborIndex]);
  const neighborIsVoid =
    Element.isElement(neighbor) && Editor.isVoid(editor, neighbor);
  if (!neighborIsVoid) {
    return false;
  }
  const caretRect = getCaretRect(editor, direction);
  const edgeRect = getBlockLineRect(editor, direction === "up" ? "start" : "end");
  if (caretRect && edgeRect) {
    const lineHeight = edgeRect.height || caretRect.height;
    const tolerance = Math.max(2, lineHeight * 0.4);
    const distance =
      direction === "up"
        ? Math.abs(edgeRect.top - caretRect.top)
        : Math.abs(edgeRect.bottom - caretRect.bottom);
    const atEdge = distance <= tolerance;
    return atEdge;
  }
  return direction === "up"
    ? isAtBeginningOfBlock(editor, { mode: "highest" })
    : isAtEndOfBlock(editor, { mode: "highest" });
}

function getCaretRect(
  editor: SlateEditor,
  direction: "up" | "down",
): DOMRect | null {
  if (!ReactEditor.selectionIsInDOM(editor) || !editor.selection) {
    return null;
  }
  try {
    const domRange = ReactEditor.toDOMRange(editor, editor.selection);
    const rects = domRange.getClientRects();
    if (rects.length > 0) {
      return direction === "down" ? rects[rects.length - 1] : rects[0];
    }
    return domRange.getBoundingClientRect();
  } catch {
    return null;
  }
}

function getBlockLineRect(
  editor: SlateEditor,
  edge: "start" | "end",
): DOMRect | null {
  if (!ReactEditor.selectionIsInDOM(editor) || !editor.selection) {
    return null;
  }
  try {
    const blockPath = [editor.selection.focus.path[0]];
    const blockNode = ReactEditor.toDOMNode(editor, Editor.node(editor, blockPath)[0]);
    if (!blockNode) return null;
    const range = document.createRange();
    range.selectNodeContents(blockNode);
    const rects = Array.from(range.getClientRects()).filter(
      (rect) => rect.height > 0.5 && rect.width > 0.5,
    );
    if (rects.length === 0) {
      return range.getBoundingClientRect();
    }
    return edge === "start" ? rects[0] : rects[rects.length - 1];
  } catch {
    return null;
  }
}

const down = ({ editor }: { editor: SlateEditor }) => {
  const gapCursor = getGapCursor(editor);
  if (gapCursor) {
    if (gapCursor.side === "after") {
      let isVoid = false;
      try {
        const [node] = Editor.node(editor, gapCursor.path);
        isVoid = Editor.isVoid(editor, node as any);
      } catch {
        isVoid = false;
      }
      if (isVoid) {
        insertParagraphAtGap(editor, gapCursor);
        ReactEditor.focus(editor);
        return true;
      }
      const lastIndex = Math.max(0, editor.children.length - 1);
      if (gapCursor.path[0] >= lastIndex) {
        clearGapCursor(editor);
        const focus = pointAtPath(editor, [lastIndex], undefined, "end");
        Transforms.setSelection(editor, { focus, anchor: focus });
        ReactEditor.focus(editor);
        return true;
      }
    }
    clearGapCursor(editor);
    const index =
      gapCursor.side === "before"
        ? gapCursor.path[0]
        : gapCursor.path[0] + 1;
    const targetIndex = Math.min(
      Math.max(0, index),
      Math.max(0, editor.children.length - 1),
    );
    const focus = pointAtPath(editor, [targetIndex], undefined, "start");
    Transforms.setSelection(editor, { focus, anchor: focus });
    return true;
  }
  const cur = editor.selection?.focus;
  if (
    cur != null &&
    editor.onCursorBottom != null &&
    cur.path[0] >= editor.children.length - 1 &&
    isAtEndOfBlock(editor, { mode: "highest" })
  ) {
    editor.onCursorBottom();
  }
  const index = cur?.path[0];
  if (
    editor.windowedListRef.current != null &&
    cur != null &&
    index != null &&
    cur.path[1] == editor.children[cur.path[0]]["children"]?.length - 1
  ) {
    // moving to the next block:
    editor.scrollIntoDOM(index + 1);
  }
  if (ReactEditor.selectionIsInDOM(editor)) {
    if (cur != null) {
      try {
        const voidEntry = Editor.above(editor, {
          at: cur,
          match: (node) =>
            Element.isElement(node) && Editor.isVoid(editor, node as any),
        });
        if (voidEntry) {
          const voidPath = voidEntry[1];
          setGapCursor(editor, { path: [voidPath[0]], side: "after" });
          ReactEditor.forceUpdate(editor);
          return true;
        }
      } catch {
        // ignore
      }
    }
    if (cur != null && shouldOpenGapBeforeVoid(editor, "down")) {
      const targetIndex = cur.path[0] + 1;
      setGapCursor(editor, { path: [targetIndex], side: "before" });
      ReactEditor.forceUpdate(editor);
      return true;
    }
    if (cur != null && isAtEndOfBlock(editor, { mode: "highest" })) {
      if (shouldUseGapCursor(editor, "down")) {
        setGapCursor(editor, { path: [cur.path[0]], side: "after" });
        ReactEditor.forceUpdate(editor);
        return true;
      }
    }
    // just work in the usual way
    if (!blocksCursor(editor, false)) {
      clearGapCursor(editor);
      // built in cursor movement works fine
      return false;
    }
    moveCursorDown(editor, true);
    moveCursorToBeginningOfBlock(editor);
    return true;
  } else {
    // in case of windowing when actual selection is not even
    // in the DOM, it's much better to just scroll it into view
    // and not move the cursor at all than to have it be all
    // wrong (which is what happens with contenteditable and
    // selection change).  I absolutely don't know how to
    // subsequently move the cursor down programatically in
    // contenteditable, and it makes no sense to do so in slate
    // since the semantics of moving down depend on the exact rendering.
    return true;
  }
};

register({ key: "ArrowDown" }, down);

const up = ({ editor }: { editor: SlateEditor }) => {
  const gapCursor = getGapCursor(editor);
  if (gapCursor) {
    if (gapCursor.side === "before") {
      let isVoid = false;
      try {
        const [node] = Editor.node(editor, gapCursor.path);
        isVoid = Editor.isVoid(editor, node as any);
      } catch {
        isVoid = false;
      }
      if (isVoid) {
        insertParagraphAtGap(editor, gapCursor);
        ReactEditor.focus(editor);
        return true;
      }
      if (gapCursor.path[0] <= 0) {
        clearGapCursor(editor);
        const focus = pointAtPath(editor, [0], undefined, "start");
        Transforms.setSelection(editor, { focus, anchor: focus });
        ReactEditor.focus(editor);
        return true;
      }
    }
    clearGapCursor(editor);
    const index =
      gapCursor.side === "after"
        ? gapCursor.path[0]
        : gapCursor.path[0] - 1;
    const targetIndex = Math.min(
      Math.max(0, index),
      Math.max(0, editor.children.length - 1),
    );
    const focus = pointAtPath(editor, [targetIndex], undefined, "end");
    Transforms.setSelection(editor, { focus, anchor: focus });
    return true;
  }
  const cur = editor.selection?.focus;
  if (
    cur != null &&
    editor.onCursorTop != null &&
    cur?.path[0] == 0 &&
    isAtBeginningOfBlock(editor, { mode: "highest" })
  ) {
    editor.onCursorTop();
  }
  const index = cur?.path[0];
  if (editor.windowedListRef.current != null && index && cur.path[1] == 0) {
    editor.scrollIntoDOM(index - 1);
  }
  if (ReactEditor.selectionIsInDOM(editor)) {
    if (cur != null) {
      try {
        const voidEntry = Editor.above(editor, {
          at: cur,
          match: (node) =>
            Element.isElement(node) && Editor.isVoid(editor, node as any),
        });
        if (voidEntry) {
          const voidPath = voidEntry[1];
          setGapCursor(editor, { path: [voidPath[0]], side: "before" });
          ReactEditor.forceUpdate(editor);
          return true;
        }
      } catch {
        // ignore
      }
    }
    if (cur != null && shouldOpenGapBeforeVoid(editor, "up")) {
      const targetIndex = Math.max(0, cur.path[0] - 1);
      setGapCursor(editor, { path: [targetIndex], side: "after" });
      ReactEditor.forceUpdate(editor);
      return true;
    }
    if (cur != null && isAtBeginningOfBlock(editor, { mode: "highest" })) {
      if (shouldUseGapCursor(editor, "up")) {
        setGapCursor(editor, { path: [cur.path[0]], side: "before" });
        ReactEditor.forceUpdate(editor);
        return true;
      }
    }
    if (!blocksCursor(editor, true)) {
      clearGapCursor(editor);
      // built in cursor movement works fine
      return false;
    }
    moveCursorUp(editor, true);
    moveCursorToBeginningOfBlock(editor);
    return true;
  } else {
    return true;
  }
};

register({ key: "ArrowUp" }, up);

/*
The following functions are needed when using windowing, since
otherwise page up/page down get stuck when the rendered window
is at the edge.  This is unavoidable, even if we were to
render a big overscan. If scrolling doesn't move, the code below
forces a manual move by one page.

NOTE/TODO: none of the code below moves the *cursor*; it only
moves the scroll position on the page.  In contrast, word,
google docs and codemirror all move the cursor when you page up/down,
so maybe that should be implemented...?
*/

function pageWindowed(_sign) {
  return ({ editor }) => {
    const scroller = editor.windowedListRef.current?.getScrollerRef();
    if (scroller == null) return false;

    return false;
  };
}

const pageUp = pageWindowed(-1);
register({ key: "PageUp" }, pageUp);

const pageDown = pageWindowed(1);
register({ key: "PageDown" }, pageDown);

function beginningOfDoc({ editor }) {
  const scroller = editor.windowedListRef.current?.getScrollerRef();
  if (scroller == null) return false;
  scroller.scrollTop = 0;
  return true;
}
function endOfDoc({ editor }) {
  const scroller = editor.windowedListRef.current?.getScrollerRef();
  if (scroller == null) return false;
  scroller.scrollTop = 1e20; // basically infinity
  return true;
}
register({ key: "ArrowUp", meta: true }, beginningOfDoc); // mac
register({ key: "Home", ctrl: true }, beginningOfDoc); // windows
register({ key: "ArrowDown", meta: true }, endOfDoc); // mac
register({ key: "End", ctrl: true }, endOfDoc); // windows

function endOfLine() {
  return false;
}

function beginningOfLine() {
  return false;
}

register({ key: "ArrowRight", meta: true }, endOfLine);
register({ key: "ArrowRight", ctrl: true }, endOfLine);
register({ key: "ArrowLeft", meta: true }, beginningOfLine);
register({ key: "ArrowLeft", ctrl: true }, beginningOfLine);
