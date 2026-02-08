import "../elements/types";

import { createEditor, Editor } from "slate";
import { withReact } from "../slate-react";
import { withAutoFormat } from "../format";
import { getCodeBlockText, toCodeLines } from "../elements/code-block/utils";

test("backspace keeps selection inside code block when removing empty line", () => {
  const editor = withAutoFormat(withReact(createEditor()));
  editor.children = [
    { type: "paragraph", children: [{ text: "autoindent:" }] },
    { type: "code_block", info: "", children: toCodeLines("dk\n\n") },
    { type: "paragraph", children: [{ text: "after" }] },
  ] as any;
  editor.selection = {
    anchor: { path: [1, 2, 0], offset: 0 },
    focus: { path: [1, 2, 0], offset: 0 },
  };

  editor.deleteBackward();

  expect(getCodeBlockText(editor.children[1] as any)).toBe("dk\n");
  expect(editor.selection?.anchor.path).toEqual([1, 1, 0]);
  expect(editor.selection?.anchor.offset).toBe(0);
});

test("backspace at start of non-empty code line joins with previous line", () => {
  const editor = withAutoFormat(withReact(createEditor()));
  editor.children = [
    { type: "code_block", info: "", children: toCodeLines("a\nb") },
  ] as any;
  editor.selection = {
    anchor: { path: [0, 1, 0], offset: 0 },
    focus: { path: [0, 1, 0], offset: 0 },
  };

  editor.deleteBackward();

  expect(getCodeBlockText(editor.children[0] as any)).toBe("ab");
  expect(editor.selection?.anchor.path).toEqual([0, 0, 0]);
  expect(editor.selection?.anchor.offset).toBe(1);
});

test("backspace join is resilient if Editor.string returns empty", () => {
  const editor = withAutoFormat(withReact(createEditor()));
  editor.children = [
    { type: "code_block", info: "", children: toCodeLines("a\nb") },
  ] as any;
  editor.selection = {
    anchor: { path: [0, 1, 0], offset: 0 },
    focus: { path: [0, 1, 0], offset: 0 },
  };

  const spy = jest.spyOn(Editor, "string").mockReturnValue("");
  try {
    editor.deleteBackward();
  } finally {
    spy.mockRestore();
  }

  expect(getCodeBlockText(editor.children[0] as any)).toBe("ab");
  expect(editor.selection?.anchor.path).toEqual([0, 0, 0]);
  expect(editor.selection?.anchor.offset).toBe(1);
});
