/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Editor, Element, Range, Transforms } from "slate";

// Ensure Enter inside a code_line stays inside its parent block (code/html/meta).
export function withCodeLineInsertBreak(editor) {
  const { insertBreak } = editor;

  editor.insertBreak = () => {
    const { selection } = editor;
    if (selection && Range.isCollapsed(selection)) {
      const lineEntry = Editor.above(editor, {
        at: selection,
        match: (n) => Element.isElement(n) && n.type === "code_line",
      });
      if (lineEntry) {
        Transforms.splitNodes(editor, {
          at: selection,
          match: (n) => Element.isElement(n) && n.type === "code_line",
          // Always create a new line, even when splitting at end-of-line.
          always: true,
        });
        return;
      }
    }
    insertBreak();
  };

  return editor;
}
