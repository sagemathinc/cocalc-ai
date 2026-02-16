import { createEditor, Descendant, Editor, Transforms } from "slate";

import { unindentListItem } from "../format/indent";
import type { BulletList } from "../elements/list";
import type { ListItem } from "../elements/list/list-item";
import type { Paragraph } from "../elements/paragraph";

const paragraph = (text: string): Paragraph => ({
  type: "paragraph",
  blank: false,
  children: [{ text }],
});

const listItem = (text: string, children: Descendant[] = []): ListItem => ({
  type: "list_item",
  children: [paragraph(text), ...children],
});

const bulletList = (items: Descendant[]): BulletList => ({
  type: "bullet_list",
  tight: true,
  children: items,
});

const selectPath = (editor: Editor, path: number[]) => {
  Transforms.select(editor, { path, offset: 0 });
};

test("unindent moves first nested item out and carries remaining siblings", () => {
  const editor = createEditor();
  editor.children = [
    bulletList([
      listItem("foo", [
        bulletList([listItem("xxx"), listItem("bar")]),
      ]),
    ]),
  ];

  selectPath(editor, [0, 0, 1, 0, 0, 0]);
  expect(unindentListItem(editor)).toBe(true);

  expect(editor.children).toEqual([
    bulletList([
      listItem("foo"),
      listItem("xxx", [bulletList([listItem("bar")])]),
    ]),
  ]);
});

test("unindent last nested item keeps earlier siblings nested", () => {
  const editor = createEditor();
  editor.children = [
    bulletList([
      listItem("foo", [
        bulletList([listItem("xxx"), listItem("bar")]),
      ]),
    ]),
  ];

  selectPath(editor, [0, 0, 1, 1, 0, 0]);
  expect(unindentListItem(editor)).toBe(true);

  expect(editor.children).toEqual([
    bulletList([
      listItem("foo", [bulletList([listItem("xxx")])]),
      listItem("bar"),
    ]),
  ]);
});
