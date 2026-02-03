import "../elements/types";

import { createEditor } from "slate";
import { withReact } from "../slate-react";
import { withAutoFormat, insertPlainTextInCodeBlock } from "../format/auto-format";
import { getCodeBlockText, toCodeLines } from "../elements/code-block/utils";

test("plain text paste inside code block keeps caret at insert point", () => {
  const editor = withAutoFormat(withReact(createEditor()));
  editor.children = [
    { type: "code_block", info: "", children: toCodeLines("a\nb\nc") },
  ] as any;
  editor.selection = {
    anchor: { path: [0, 1, 0], offset: 0 },
    focus: { path: [0, 1, 0], offset: 0 },
  };

  const ok = insertPlainTextInCodeBlock(editor as any, "c");
  expect(ok).toBe(true);
  expect(getCodeBlockText(editor.children[0] as any)).toBe("a\ncb\nc");
  expect(editor.selection?.focus.path).toEqual([0, 1, 0]);
  expect(editor.selection?.focus.offset).toBe(1);
});
