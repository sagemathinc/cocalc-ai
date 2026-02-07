import "../elements/types";
import { createEditor, Transforms } from "slate";

import { handleBlankLineEnter } from "../keyboard/blank-line-enter";

const selectStart = (editor, path: number[]) => {
  Transforms.select(editor, { path, offset: 0 });
};

test("blank line enter is ignored when preserveBlankLines is false", () => {
  const editor = createEditor();
  (editor as any).preserveBlankLines = false;
  editor.children = [
    { type: "paragraph", blank: true, children: [{ text: "" }] },
  ];

  selectStart(editor, [0, 0]);
  const handled = handleBlankLineEnter(editor);

  expect(handled).toBe(true);
  expect(editor.children).toHaveLength(1);
  expect(editor.children.some((node) => node["blank"] === true)).toBe(false);
});

test("blank line enter allows normal split when preserveBlankLines is false", () => {
  const editor = createEditor();
  (editor as any).preserveBlankLines = false;
  editor.children = [{ type: "paragraph", children: [{ text: "hi" }] }];

  selectStart(editor, [0, 0]);
  const handled = handleBlankLineEnter(editor);

  expect(handled).toBe(false);
});
