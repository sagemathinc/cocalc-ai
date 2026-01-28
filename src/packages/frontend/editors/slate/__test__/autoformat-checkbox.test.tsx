import "../elements/types";

import { createEditor, Descendant, Editor, Transforms } from "slate";

import { withReact, ReactEditor } from "../slate-react";
import { withAutoFormat } from "../format";
import { withIsInline, withIsVoid } from "../plugins";

test("autoformat checkbox in list item", () => {
  const editor = withAutoFormat(
    withIsInline(withIsVoid(withReact(createEditor())))
  );
  const value: Descendant[] = [
    {
      type: "bullet_list",
      children: [
        {
          type: "list_item",
          children: [
            { type: "paragraph", children: [{ text: "[ ]" }] },
          ],
        },
      ],
    },
  ];
  editor.children = value;
  editor.selection = null;

  const focusSpy = jest
    .spyOn(ReactEditor, "focus")
    .mockImplementation(() => undefined);

  Transforms.select(editor, { path: [0, 0, 0, 0], offset: 3 });
  expect(editor.selection?.focus.offset).toBe(3);
  expect(Editor.string(editor, [0, 0, 0])).toBe("[ ]");
  editor.insertText(" ", true);

  const checkboxEntry = Editor.nodes(editor, {
    at: [],
    match: (node) => node?.["type"] === "checkbox",
  }).next().value;
  expect(checkboxEntry).toBeDefined();

  focusSpy.mockRestore();
});

test("autoformat checked checkbox in list item", () => {
  const editor = withAutoFormat(
    withIsInline(withIsVoid(withReact(createEditor())))
  );
  const value: Descendant[] = [
    {
      type: "bullet_list",
      children: [
        {
          type: "list_item",
          children: [
            { type: "paragraph", children: [{ text: "[x]" }] },
          ],
        },
      ],
    },
  ];
  editor.children = value;
  editor.selection = null;

  const focusSpy = jest
    .spyOn(ReactEditor, "focus")
    .mockImplementation(() => undefined);

  Transforms.select(editor, { path: [0, 0, 0, 0], offset: 3 });
  expect(editor.selection?.focus.offset).toBe(3);
  expect(Editor.string(editor, [0, 0, 0])).toBe("[x]");
  editor.insertText(" ", true);

  const checkboxEntry = Editor.nodes(editor, {
    at: [],
    match: (node) => node?.["type"] === "checkbox",
  }).next().value;
  expect(checkboxEntry).toBeDefined();
  if (checkboxEntry) {
    expect(checkboxEntry[0]?.["value"]).toBe(true);
  }

  focusSpy.mockRestore();
});
