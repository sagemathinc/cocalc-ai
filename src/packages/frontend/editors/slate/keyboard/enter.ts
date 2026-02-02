/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// What happens when you hit the enter key.

import { Editor, Element, Range, Transforms } from "slate";
import { isElementOfType } from "../elements";
import { register } from "./register";
import { emptyParagraph } from "../padding";
import {
  isAtBeginningOfBlock,
  isAtEndOfBlock,
  moveCursorToBeginningOfBlock,
} from "../control";
import { markdownAutoformat } from "../format/auto-format";
import { handleBlankLineEnter } from "./blank-line-enter";

register({ key: "Enter" }, ({ editor }) => {
  // If we're inside a code-like line (code/html/meta), let Slate's insertBreak
  // handle splitting the line inside the block.
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
        const htmlMetaEntry = Editor.above(editor, {
          at: selection,
          match: (n) =>
            Element.isElement(n) &&
            (n.type === "html_block" || n.type === "meta"),
        });
        if (Range.isExpanded(selection)) {
          Transforms.delete(editor);
        }
        if (htmlMetaEntry) {
          try {
            const linePath = lineEntry[1];
            const start = Editor.start(editor, linePath);
            const end = Editor.end(editor, linePath);
            const beforeText = Editor.string(editor, {
              anchor: start,
              focus: selection.focus,
            });
            const afterText = Editor.string(editor, {
              anchor: selection.focus,
              focus: end,
            });
            if (beforeText.trim() === "" || afterText.trim() === "") {
              return true;
            }
          } catch {
            // ignore and fall through to insertBreak
          }
        }
        const lineText = Editor.string(editor, lineEntry[1]);
        const indentMatch = lineText.match(/^[\t ]*/);
        const indent = indentMatch?.[0] ?? "";
        editor.insertBreak();
        if (codeBlockEntry && indent) {
          Transforms.insertText(editor, indent);
        }
        return true;
      }
    const mathEntry = Editor.above(editor, {
      at: selection,
      match: (n) =>
        Element.isElement(n) && n.type === "math_block",
    });
    if (mathEntry) {
      if (Range.isExpanded(selection)) {
        Transforms.delete(editor);
      }
      // Disallow blank (whitespace-only) lines inside display math.
      try {
        const focus = selection.focus;
        const start = Editor.start(editor, mathEntry[1]);
        const end = Editor.end(editor, mathEntry[1]);
        const beforeText = Editor.string(editor, {
          anchor: start,
          focus,
        });
        const afterText = Editor.string(editor, {
          anchor: focus,
          focus: end,
        });
        const beforeLine = beforeText.split("\n").pop() ?? "";
        const afterLine = afterText.split("\n").shift() ?? "";
        if (beforeLine.trim() === "" || afterLine.trim() === "") {
          return true;
        }
      } catch {
        // If we can't inspect neighbors, fall through and let Slate handle.
      }
      Transforms.insertText(editor, "\n");
      return true;
    }
  }
  markdownAutoformat(editor);
  const fragment = editor.getFragment();
  const x = fragment?.[0];

  if (isElementOfType(x, "heading")) {
    // If you hit enter in a heading,
    Transforms.insertNodes(editor, [emptyParagraph()], {
      match: (node) => isElementOfType(node, "heading"),
    });
    return true;
  }

  if (isElementOfType(x, "paragraph")) {
    // If you hit enter in a paragraph, the default behavior is creating
    // another empty paragraph.  We do a bunch of special cases so that
    // our document corresponds much more closely to what markdown
    // actually supports.
    return handleBlankLineEnter(editor);
  }

  if (isElementOfType(x, ["bullet_list", "ordered_list"])) {
    const atEnd = isAtEndOfBlock(editor, { mode: "lowest" });
    const atBeginning = isAtBeginningOfBlock(editor, { mode: "lowest" });
    Transforms.insertNodes(
      editor,
      [{ type: "list_item", children: [{ text: "" }] } as Element],
      {
        match: (node) => isElementOfType(node, "list_item"),
        mode: "lowest",
      }
    );
    if (atBeginning) {
      // done
      Transforms.move(editor, { distance: 1, unit: "line" });
      return true;
    }
    if (atEnd) {
      // done
      return true;
    }
    // Not at beginning or end, so above insertNodes actually
    // splits the list item so we end up
    // with an extra blank one, which we now remove.
    Transforms.removeNodes(editor, {
      match: (node) => isElementOfType(node, "list_item"),
    });
    moveCursorToBeginningOfBlock(editor);
    return true;
  }
  return false;
});
