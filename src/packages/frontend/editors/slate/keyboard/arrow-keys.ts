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
import { Editor, Path, Range, Text, Transforms } from "slate";
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

const ESCAPABLE_MARKS = new Set([
  "bold",
  "italic",
  "strikethrough",
  "underline",
  "sup",
  "sub",
  "tt",
  "code",
  "small",
]);

function isEscapableMark(mark: string): boolean {
  return (
    ESCAPABLE_MARKS.has(mark) ||
    mark.startsWith("color:") ||
    mark.startsWith("font-family:") ||
    mark.startsWith("font-size:")
  );
}

function textHasEscapableMarks(text: Text): boolean {
  const value = text as unknown as Record<string, unknown>;
  return Object.keys(value).some(
    (key) => key != "text" && value[key] === true && isEscapableMark(key),
  );
}

function clearEscapableEditorMarks(editor: SlateEditor): void {
  const marks = Editor.marks(editor);
  if (marks == null) return;
  for (const mark of Object.keys(marks)) {
    if (isEscapableMark(mark)) {
      Editor.removeMark(editor, mark);
    }
  }
}

export function escapeMarkedTextBoundaryOnArrowRight(
  editor: SlateEditor,
): boolean {
  const { selection } = editor;
  if (selection == null || !Range.isCollapsed(selection)) return false;

  const { focus } = selection;
  let text: unknown;
  try {
    [text] = Editor.node(editor, focus.path);
  } catch {
    return false;
  }

  if (
    !Text.isText(text) ||
    text.text.length == 0 ||
    focus.offset != text.text.length ||
    !textHasEscapableMarks(text)
  ) {
    return false;
  }

  const parent = Editor.parent(editor, focus.path)[0] as {
    children?: unknown[];
  };
  const siblingIndex = focus.path[focus.path.length - 1];
  const nextSibling = parent.children?.[siblingIndex + 1];
  const nextPath = Path.next(focus.path);

  if (Text.isText(nextSibling) && !textHasEscapableMarks(nextSibling)) {
    clearEscapableEditorMarks(editor);
    Transforms.select(editor, {
      path: nextPath,
      offset: /^\s/.test(nextSibling.text) ? 1 : 0,
    });
    return true;
  }

  clearEscapableEditorMarks(editor);
  Transforms.insertNodes(editor, { text: " " }, { at: nextPath });
  Transforms.select(editor, { path: nextPath, offset: 1 });
  return true;
}

register({ key: "ArrowRight" }, ({ editor }) =>
  escapeMarkedTextBoundaryOnArrowRight(editor),
);

const down = ({ editor }: { editor: SlateEditor }) => {
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
    // just work in the usual way
    if (!blocksCursor(editor, false)) {
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
    if (!blocksCursor(editor, true)) {
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
