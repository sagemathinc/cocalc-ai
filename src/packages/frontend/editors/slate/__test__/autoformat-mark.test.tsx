import "../elements/types";

import { createEditor, Descendant, Editor, Transforms } from "slate";

import { withReact, ReactEditor } from "../slate-react";
import { withAutoFormat } from "../format";

function setupEditor(text: string) {
  const editor = withAutoFormat(withReact(createEditor()));
  const value: Descendant[] = [
    { type: "paragraph", children: [{ text }] },
  ];
  editor.children = value;
  editor.selection = null;
  return editor;
}

test("autoformat bold with **", () => {
  const editor = setupEditor("**bold**");
  const focusSpy = jest
    .spyOn(ReactEditor, "focus")
    .mockImplementation(() => undefined);

  const textLength = "**bold**".length;
  Transforms.select(editor, { path: [0, 0], offset: textLength });
  editor.insertText(" ", true);

  const leaf = editor.children[0]?.["children"]?.[0];
  expect(leaf?.["bold"]).toBe(true);
  expect(Editor.string(editor, [0])).toBe("bold ");

  focusSpy.mockRestore();
});

test("autoformat italic with _", () => {
  const editor = setupEditor("_ital_");
  const focusSpy = jest
    .spyOn(ReactEditor, "focus")
    .mockImplementation(() => undefined);

  const textLength = "_ital_".length;
  Transforms.select(editor, { path: [0, 0], offset: textLength });
  editor.insertText(" ", true);

  const leaf = editor.children[0]?.["children"]?.[0];
  expect(leaf?.["italic"]).toBe(true);
  expect(Editor.string(editor, [0])).toBe("ital ");

  focusSpy.mockRestore();
});

test("autoformat strikethrough with ~~", () => {
  const editor = setupEditor("~~gone~~");
  const focusSpy = jest
    .spyOn(ReactEditor, "focus")
    .mockImplementation(() => undefined);

  const textLength = "~~gone~~".length;
  Transforms.select(editor, { path: [0, 0], offset: textLength });
  editor.insertText(" ", true);

  const leaf = editor.children[0]?.["children"]?.[0];
  expect(leaf?.["strikethrough"]).toBe(true);
  expect(Editor.string(editor, [0])).toBe("gone ");

  focusSpy.mockRestore();
});
