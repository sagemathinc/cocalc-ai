import "../elements/types";

import { createEditor, Descendant, Element, Transforms } from "slate";

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

  const nonSpacer = editor.children.filter(
    (node) =>
      !(
        Element.isElement(node) &&
        node.type === "paragraph" &&
        (node as any).spacer
      ),
  );
  expect(nonSpacer).toHaveLength(1);
  expect(nonSpacer[0]?.["type"]).toBe("math_block");

  focusSpy.mockRestore();
});

test("autoformat block math with content moves selection after block", () => {
  const editor = withAutoFormat(withReact(createEditor()));
  const value: Descendant[] = [
    { type: "paragraph", children: [{ text: "$$x$$" }] },
  ];
  editor.children = value;
  editor.selection = null;

  const focusSpy = jest
    .spyOn(ReactEditor, "focus")
    .mockImplementation(() => undefined);

  const textLength = "$$x$$".length;
  Transforms.select(editor, { path: [0, 0], offset: textLength });
  editor.insertText(" ", true);

  const nonSpacer = editor.children.filter(
    (node) =>
      !(
        Element.isElement(node) &&
        node.type === "paragraph" &&
        (node as any).spacer
      ),
  );
  expect(nonSpacer).toHaveLength(1);
  expect(nonSpacer[0]?.["type"]).toBe("math_block");

  expect(editor.selection).not.toBeNull();
  if (editor.selection) {
    const focusPath = editor.selection.focus.path;
    expect(focusPath).toEqual([1, 0]);
  }

  focusSpy.mockRestore();
});
