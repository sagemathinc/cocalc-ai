import "../elements/types";

import { createEditor, Descendant, Editor, Text } from "slate";

import { pointAtPath } from "../slate-util";

test("pointAtPath falls back to first text node for list at document start", () => {
  const editor = createEditor();
  const value: Descendant[] = [
    {
      type: "bullet_list",
      children: [
        {
          type: "list_item",
          children: [
            { type: "paragraph", children: [{ text: "bar" }] },
          ],
        },
      ],
    },
  ];
  editor.children = value;

  const point = pointAtPath(editor, [999]);
  const [node] = Editor.node(editor, point);
  expect(Text.isText(node)).toBe(true);
  expect(point.path).toEqual([0, 0, 0, 0]);
});
