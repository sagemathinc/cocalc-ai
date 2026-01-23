/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// What happens when you hit the enter key.

import { Editor, Element, Path, Transforms } from "slate";
import { isElementOfType } from "../elements";
import { emptyParagraph, isWhitespaceParagraph } from "../padding";
import { register } from "./register";
import {
  isAtBeginningOfBlock,
  isAtEndOfBlock,
  moveCursorToBeginningOfBlock,
} from "../control";
import { containingBlock } from "../slate-util";
import { markdownAutoformat } from "../format/auto-format";

register({ key: "Enter" }, ({ editor }) => {
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
    const blockEntry = containingBlock(editor);
    const block = blockEntry?.[0];
    const blockPath = blockEntry?.[1] as Path | undefined;
    if (
      block != null &&
      blockPath != null &&
      blockPath.length === 1 &&
      !isWhitespaceParagraph(block) &&
      isAtBeginningOfBlock(editor, { mode: "lowest" })
    ) {
      // At the start of a top-level paragraph, insert an explicit blank line
      // above instead of creating a hidden placeholder paragraph.
      const blank = {
        type: "paragraph",
        blank: true,
        children: [{ text: "" }],
      } as Element;
      const nextPath = Path.next(blockPath);
      Transforms.insertNodes(editor, blank, { at: blockPath });
      Transforms.select(editor, Editor.start(editor, nextPath));
      return true;
    }
    if (block != null && isWhitespaceParagraph(block) && blockPath != null) {
      if ((block as { blank?: boolean }).blank !== true) {
        Transforms.setNodes(editor, { blank: true }, { at: blockPath });
      }
      const nextPath = Path.next(blockPath);
      Transforms.insertNodes(editor, emptyParagraph(), { at: nextPath });
      Transforms.select(editor, Editor.start(editor, nextPath));
      return true;
    }
    return false;
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
