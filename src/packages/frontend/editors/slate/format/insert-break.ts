/*
 * This helper overrides Slate's insertBreak to preserve code-block structure
 * and add simple autoindent. It only changes behavior inside code blocks,
 * delegating to the default insertBreak everywhere else.
 */

import { Editor, Element, Range, Transforms } from "slate";
import type { SlateEditor } from "../types";

export const withInsertBreak = (editor: SlateEditor) => {
  const { insertBreak } = editor;

  editor.insertBreak = () => {
    const selection = editor.selection;
    if (selection) {
      const lineEntry = Editor.above(editor, {
        at: selection,
        match: (n) => Element.isElement(n) && n.type === "code_line",
      });
      if (lineEntry) {
        const codeBlockEntry = Editor.above(editor, {
          at: selection,
          match: (n) => Element.isElement(n) && n.type === "code_block",
        });
        if (!codeBlockEntry) {
          insertBreak();
          return;
        }
        if (Range.isExpanded(selection)) {
          Transforms.delete(editor);
        }
        const lineText = Editor.string(editor, lineEntry[1]);
        const indentMatch = lineText.match(/^[\t ]*/);
        const indent = indentMatch?.[0] ?? "";
        insertBreak();
        if (indent) {
          Transforms.insertText(editor, indent);
        }
        return;
      }
    }
    insertBreak();
  };

  return editor;
};
