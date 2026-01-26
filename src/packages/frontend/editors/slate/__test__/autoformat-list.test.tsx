import "../elements/types";

import { createEditor, Descendant, Editor, Element, Transforms } from "slate";

import { withReact, ReactEditor } from "../slate-react";
import { withAutoFormat } from "../format";
import { withNormalize } from "../normalize";

test("autoformat list does not leave a blank paragraph between blocks", () => {
  const editor = withAutoFormat(withReact(createEditor()));
  const value: Descendant[] = [
    { type: "paragraph", children: [{ text: "foo" }] },
    { type: "paragraph", children: [{ text: "-" }] },
  ];
  editor.children = value;
  editor.selection = null;

  const focusSpy = jest
    .spyOn(ReactEditor, "focus")
    .mockImplementation(() => undefined);

  Transforms.select(editor, { path: [1, 0], offset: 1 });
  editor.insertText(" ", true);
  expect(editor.children).toHaveLength(2);
  expect(editor.children[0]?.["type"]).toBe("paragraph");
  expect(editor.children[1]?.["type"]).toBe("bullet_list");
  expect(
    editor.children.some(
      (node) => node["type"] === "paragraph" && node["blank"] === true,
    ),
  ).toBe(false);
  expect(editor.selection).not.toBeNull();
  if (editor.selection) {
    const listEntry = Editor.above(editor, {
      at: editor.selection.focus,
      match: (node) =>
        Element.isElement(node) &&
        (node.type === "bullet_list" || node.type === "ordered_list"),
    });
    expect(listEntry).toBeDefined();
  }

  focusSpy.mockRestore();
});

test("autoformat list preserves existing paragraph text", () => {
  const editor = withAutoFormat(withReact(createEditor()));
  const value: Descendant[] = [
    { type: "paragraph", children: [{ text: "foo" }] },
    { type: "paragraph", children: [{ text: "bar" }] },
  ];
  editor.children = value;
  editor.selection = null;

  const focusSpy = jest
    .spyOn(ReactEditor, "focus")
    .mockImplementation(() => undefined);

  // simulate typing "-" then space at start of a non-empty line
  Transforms.select(editor, { path: [1, 0], offset: 0 });
  editor.insertText("-");
  editor.insertText(" ", true);
  const didFormat = true;
  expect(didFormat).toBe(true);
  expect(editor.children).toHaveLength(2);
  expect(editor.children[0]?.["type"]).toBe("paragraph");
  expect(editor.children[1]?.["type"]).toBe("bullet_list");

  const listText = Editor.string(editor, [1]);
  expect(listText).toBe("bar");

  focusSpy.mockRestore();
});

test("autoformat list merges with following list without throwing", () => {
  const editor = withAutoFormat(withNormalize(withReact(createEditor())));
  const value: Descendant[] = [
    { type: "paragraph", children: [{ text: "foo" }] },
    { type: "paragraph", children: [{ text: "-" }] },
    {
      type: "bullet_list",
      tight: true,
      children: [
        {
          type: "list_item",
          children: [{ type: "paragraph", children: [{ text: "existing" }] }],
        },
      ],
    },
  ];
  editor.children = value;
  editor.selection = null;

  const focusSpy = jest
    .spyOn(ReactEditor, "focus")
    .mockImplementation(() => undefined);

  Transforms.select(editor, { path: [1, 0], offset: 1 });
  editor.insertText(" ", true);

  expect(editor.children).toHaveLength(2);
  expect(editor.children[1]?.["type"]).toBe("bullet_list");
  const listText = Editor.string(editor, [1]);
  expect(listText).toContain("existing");

  focusSpy.mockRestore();
});
