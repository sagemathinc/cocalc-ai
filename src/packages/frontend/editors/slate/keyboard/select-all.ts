/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Editor, Element, Transforms } from "slate";
import { register, IS_MACOS } from "./register";
import { rangeAll } from "../slate-util";
import { withSelectionReason } from "../slate-utils/slate-debug";

// We use this to support windowing.

const lastCodeSelectAt = new WeakMap<Editor, number>();
const CODE_SELECT_WINDOW_MS = 1000;

export function selectAll(editor: Editor) {
  withSelectionReason(editor, "select-all", () => {
    Transforms.setSelection(editor, rangeAll(editor));
  });
}

register({ key: "a", meta: IS_MACOS, ctrl: !IS_MACOS }, ({ editor }) => {
  const selection = editor.selection;
  const codeEntry = selection
    ? Editor.above(editor, {
        match: (node) => Element.isElement(node) && node.type === "code_block",
      })
    : null;
  if (codeEntry) {
    const now = Date.now();
    const lastAt = lastCodeSelectAt.get(editor) ?? 0;
    if (now - lastAt < CODE_SELECT_WINDOW_MS) {
      lastCodeSelectAt.set(editor, 0);
      selectAll(editor);
      return true;
    }
    const [, path] = codeEntry;
    withSelectionReason(editor, "select-all-code-block", () => {
      Transforms.select(editor, Editor.range(editor, path));
    });
    lastCodeSelectAt.set(editor, now);
    return true;
  }
  lastCodeSelectAt.set(editor, 0);
  selectAll(editor);
  return true;
});
