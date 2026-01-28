import "../elements/types";

import { createEditor, Descendant, Editor, Transforms } from "slate";

import { withReact, ReactEditor } from "../slate-react";
import { withAutoFormat } from "../format";

test("autoformat inline code span at cursor", () => {
  const editor = withAutoFormat(withReact(createEditor()));
  const value: Descendant[] = [
    { type: "paragraph", children: [{ text: "`code`" }] },
  ];
  editor.children = value;
  editor.selection = null;

  const focusSpy = jest
    .spyOn(ReactEditor, "focus")
    .mockImplementation(() => undefined);

  const textLength = "`code`".length;
  Transforms.select(editor, { path: [0, 0], offset: textLength });
  editor.insertText(" ", true);

  expect(Editor.string(editor, [0])).toBe("code ");
  const leaf = editor.children[0]?.["children"]?.[0];
  expect(leaf?.["code"]).toBe(true);

  focusSpy.mockRestore();
});
