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
  moveCursorToBeginningOfLine,
  moveCursorToEndOfLine,
  isAtBeginningOfBlock,
  isAtEndOfBlock,
} from "../control";
import { SlateEditor } from "../types";
import { ReactEditor } from "../slate-react";
import { Editor, Element, Transforms } from "slate";
import { clearGapCursor, getGapCursor, setGapCursor } from "../gap-cursor";
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

const down = ({ editor }: { editor: SlateEditor }) => {
  const { selection } = editor;
  const gapCursor = getGapCursor(editor);
  if (gapCursor) {
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
  setTimeout(() => {
    if (getGapCursor(editor)) {
      return;
    }
    // We have to do this via a timeout, because we don't control the cursor.
    // Instead the selection in contenteditable changes via the browser and
    // we react to that. Thus this is the only way with our current "sync with
    // contenteditable approach".  Here we just ensure that a move happens, rather
    // than having the cursor be totally stuck, which is super annoying..
    if (editor.selection === selection) {
      Transforms.move(editor, { unit: "line" });
    }
  }, 1);

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
    if (editor.scrollIntoDOM(index + 1)) {
      // we did actually have to scroll the block below current one into the dom.
      setTimeout(() => {
        // did cursor move? -- if not, we manually move it.
        if (cur == editor.selection?.focus) {
          moveCursorDown(editor, true);
          moveCursorToBeginningOfBlock(editor);
        }
      }, 0);
    }
  }
  if (ReactEditor.selectionIsInDOM(editor)) {
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
  const { selection } = editor;
  const gapCursor = getGapCursor(editor);
  if (gapCursor) {
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
  setTimeout(() => {
    if (getGapCursor(editor)) {
      return;
    }
    // We have to do this via a timeout, because we don't control the cursor.
    // Instead the selection in contenteditable changes via the browser and
    // we react to that. Thus this is the only way with our current "sync with
    // contenteditable approach".
    if (editor.selection === selection) {
      Transforms.move(editor, { unit: "line", reverse: true });
    }
  }, 1);

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
    if (editor.scrollIntoDOM(index - 1)) {
      setTimeout(() => {
        if (cur == editor.selection?.focus) {
          moveCursorUp(editor, true);
          moveCursorToBeginningOfBlock(editor);
        }
      }, 0);
    }
  }
  if (ReactEditor.selectionIsInDOM(editor)) {
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

function pageWindowed(sign) {
  return ({ editor }) => {
    const scroller = editor.windowedListRef.current?.getScrollerRef();
    if (scroller == null) return false;
    const { scrollTop } = scroller;

    setTimeout(() => {
      if (scrollTop == scroller.scrollTop) {
        scroller.scrollTop += sign * scroller.getBoundingClientRect().height;
      }
    }, 0);

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
  // might have to do it again do to measuring size of rows...
  setTimeout(() => {
    scroller.scrollTop = 1e20;
  }, 1);
  return true;
}
register({ key: "ArrowUp", meta: true }, beginningOfDoc); // mac
register({ key: "Home", ctrl: true }, beginningOfDoc); // windows
register({ key: "ArrowDown", meta: true }, endOfDoc); // mac
register({ key: "End", ctrl: true }, endOfDoc); // windows

function endOfLine({ editor }) {
  const { selection } = editor;
  setTimeout(() => {
    // We have to do this via a timeout, because we don't control the cursor.
    // Instead the selection in contenteditable changes via the browser and
    // we react to that. Thus this is the only way with our current "sync with
    // contenteditable approach".
    if (editor.selection === selection) {
      // stuck!
      moveCursorToEndOfLine(editor);
    }
  }, 1);
  return false;
}

function beginningOfLine({ editor }) {
  const { selection } = editor;
  setTimeout(() => {
    // We have to do this via a timeout, because we don't control the cursor.
    // Instead the selection in contenteditable changes via the browser and
    // we react to that. Thus this is the only way with our current "sync with
    // contenteditable approach".
    if (editor.selection === selection) {
      // stuck!
      moveCursorToBeginningOfLine(editor);
    }
  }, 1);
  return false;
}

register({ key: "ArrowRight", meta: true }, endOfLine);
register({ key: "ArrowRight", ctrl: true }, endOfLine);
register({ key: "ArrowLeft", meta: true }, beginningOfLine);
register({ key: "ArrowLeft", ctrl: true }, beginningOfLine);
