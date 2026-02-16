import "../elements/types";

import { createEditor, Descendant, Editor, Transforms } from "slate";

import { withReact } from "../slate-react";
import { moveListItemDown, moveListItemUp } from "../format/list-move";

function listTexts(editor: Editor): string[] {
  const list = editor.children[0] as any;
  return list.children.map((_: any, idx: number) => Editor.string(editor, [0, idx]));
}

test("moveListItemUp moves the current list item up", () => {
  const editor = withReact(createEditor());
  const value: Descendant[] = [
    {
      type: "bullet_list",
      children: [
        { type: "list_item", children: [{ type: "paragraph", children: [{ text: "first" }] }] },
        { type: "list_item", children: [{ type: "paragraph", children: [{ text: "second" }] }] },
        { type: "list_item", children: [{ type: "paragraph", children: [{ text: "third" }] }] },
      ],
    },
  ];
  editor.children = value;
  editor.selection = null;

  Transforms.select(editor, { path: [0, 1, 0, 0], offset: 0 });
  const moved = moveListItemUp(editor);
  expect(moved).toBe(true);
  expect(listTexts(editor)).toEqual(["second", "first", "third"]);
});

test("moveListItemDown moves the current list item down", () => {
  const editor = withReact(createEditor());
  const value: Descendant[] = [
    {
      type: "bullet_list",
      children: [
        { type: "list_item", children: [{ type: "paragraph", children: [{ text: "first" }] }] },
        { type: "list_item", children: [{ type: "paragraph", children: [{ text: "second" }] }] },
        { type: "list_item", children: [{ type: "paragraph", children: [{ text: "third" }] }] },
      ],
    },
  ];
  editor.children = value;
  editor.selection = null;

  Transforms.select(editor, { path: [0, 1, 0, 0], offset: 0 });
  const moved = moveListItemDown(editor);
  expect(moved).toBe(true);
  expect(listTexts(editor)).toEqual(["first", "third", "second"]);
});

test("moveListItemUp returns false when not in a list", () => {
  const editor = withReact(createEditor());
  const value: Descendant[] = [
    { type: "paragraph", children: [{ text: "outside" }] },
  ];
  editor.children = value;
  editor.selection = null;

  Transforms.select(editor, { path: [0, 0], offset: 0 });
  const moved = moveListItemUp(editor);
  expect(moved).toBe(false);
  expect(Editor.string(editor, [0])).toBe("outside");
});
