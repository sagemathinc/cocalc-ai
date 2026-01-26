import "../elements/types";

import { createEditor, Descendant, Transforms } from "slate";

import { withReact, ReactEditor } from "../slate-react";
import { withAutoFormat } from "../format";

test("autoformat block math at start", () => {
  const editor = withAutoFormat(withReact(createEditor()));
  const value: Descendant[] = [
    { type: "paragraph", children: [{ text: "$$" }] },
  ];
  editor.children = value;
  editor.selection = null;

  const focusSpy = jest
    .spyOn(ReactEditor, "focus")
    .mockImplementation(() => undefined);

  Transforms.select(editor, { path: [0, 0], offset: 2 });
  editor.insertText(" ", true);

  expect(editor.children).toHaveLength(1);
  expect(editor.children[0]?.["type"]).toBe("math_block");

  focusSpy.mockRestore();
});
