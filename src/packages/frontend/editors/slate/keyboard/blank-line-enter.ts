/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Editor, Element, Path, Transforms } from "slate";
import { emptyParagraph, isWhitespaceParagraph } from "../padding";
import { containingBlock } from "../slate-util";
import { isAtBeginningOfBlock } from "../control";

export function handleBlankLineEnter(editor: Editor): boolean {
  if ((editor as { preserveBlankLines?: boolean }).preserveBlankLines === false) {
    return false;
  }
  const blockEntry = containingBlock(editor);
  const block = blockEntry?.[0];
  const blockPath = blockEntry?.[1] as Path | undefined;

  if (block == null || blockPath == null || block["type"] !== "paragraph") {
    return false;
  }

  if (isWhitespaceParagraph(block)) {
    if ((block as { blank?: boolean }).blank !== true) {
      Transforms.setNodes(editor, { blank: true }, { at: blockPath });
    }
    const nextPath = Path.next(blockPath);
    Transforms.insertNodes(editor, emptyParagraph(), { at: nextPath });
    Transforms.select(editor, Editor.start(editor, nextPath));
    return true;
  }

  if (
    blockPath.length === 1 &&
    isAtBeginningOfBlock(editor, { mode: "lowest" })
  ) {
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

  return false;
}
