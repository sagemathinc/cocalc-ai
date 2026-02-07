/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Editor, Element, Text, Transforms } from "slate";
import { register, IS_MACOS } from "./register";
import { rangeAll } from "../slate-util";
import { withSelectionReason } from "../slate-utils/slate-debug";
import { ReactEditor } from "../slate-react";

// We use this to support windowing.

const lastCodeSelectAt = new WeakMap<Editor, number>();
const CODE_SELECT_WINDOW_MS = 1000;

export function selectAll(editor: Editor) {
  withSelectionReason(editor, "select-all", () => {
    Transforms.setSelection(editor, rangeAll(editor));
  });
}

register({ key: "a", meta: IS_MACOS, ctrl: !IS_MACOS }, ({ editor }) => {
  const selection =
    editor.selection ??
    (() => {
      if (typeof window === "undefined") return null;
      const domSelection = window.getSelection();
      if (!domSelection || domSelection.rangeCount === 0) return null;
      try {
        return ReactEditor.toSlateRange(editor as any, domSelection) ?? null;
      } catch {
        return null;
      }
    })();
  const codeEntry = selection
    ? Editor.above(editor, {
        at: selection.focus,
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
    const textEntries = Array.from(
      Editor.nodes(editor, {
        at: path,
        match: (node) => Text.isText(node),
      }),
    ) as [Text, number[]][];
    const first = textEntries[0];
    const last = textEntries[textEntries.length - 1];
    const anchor = first
      ? { path: first[1], offset: 0 }
      : Editor.start(editor, path);
    const focus = last
      ? { path: last[1], offset: last[0].text.length }
      : Editor.end(editor, path);
    withSelectionReason(editor, "select-all-code-block", () => {
      Transforms.setSelection(editor, { anchor, focus });
    });
    lastCodeSelectAt.set(editor, now);
    return true;
  }
  lastCodeSelectAt.set(editor, 0);
  selectAll(editor);
  return true;
});
