import "../elements/types";

import { createEditor, Descendant, Transforms } from "slate";

import { withReact, ReactEditor } from "../slate-react";
import { withAutoFormat } from "../format";

test("autoformat inline math at cursor", () => {
  const editor = withAutoFormat(withReact(createEditor()));
  const value: Descendant[] = [
    { type: "paragraph", children: [{ text: "$x^2$" }] },
  ];
  editor.children = value;
  editor.selection = null;

  const focusSpy = jest
    .spyOn(ReactEditor, "focus")
    .mockImplementation(() => undefined);

  const textLength = "$x^2$".length;
  Transforms.select(editor, { path: [0, 0], offset: textLength });
  editor.insertText(" ", true);

  const children = editor.children[0]?.["children"] ?? [];
  const mathNode = children.find((child) => child?.["type"] === "math_inline");
  expect(mathNode?.["value"]).toBe("x^2");

  focusSpy.mockRestore();
});
