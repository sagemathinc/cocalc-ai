import "../elements/types";

import { createEditor, Descendant, Editor, Element, Transforms } from "slate";

import { withReact, ReactEditor } from "../slate-react";
import { withAutoFormat } from "../format";
import { withNormalize } from "../normalize";

const isSpacerParagraph = (node: Descendant): boolean =>
  Element.isElement(node) &&
  node.type === "paragraph" &&
  (node as any).spacer === true;

const findFirstList = (editor: Editor) => {
  const entry = Editor.nodes(editor, {
    at: [],
    match: (node) =>
      Element.isElement(node) &&
      (node.type === "bullet_list" || node.type === "ordered_list"),
  }).next().value as [Element, number[]] | undefined;
  return entry ?? null;
};

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
  const nonSpacer = editor.children.filter((node) => !isSpacerParagraph(node));
  expect(nonSpacer.length).toBe(2);
  expect(nonSpacer[0]?.["type"]).toBe("paragraph");
  expect(nonSpacer[1]?.["type"]).toBe("bullet_list");
  expect(
    editor.children.some(
      (node) => node["type"] === "paragraph" && node["blank"] === true,
    ),
  ).toBe(false);
  expect(editor.selection).not.toBeNull();
  if (editor.selection) {
    const listEntry = findFirstList(editor);
    expect(listEntry).not.toBeNull();
  }

  focusSpy.mockRestore();
});

test("autoformat list keeps selection in first list item", () => {
  const editor = withAutoFormat(withReact(createEditor()));
  editor.children = [
    { type: "paragraph", children: [{ text: "-" }] },
  ] as Descendant[];
  editor.selection = null;

  const focusSpy = jest
    .spyOn(ReactEditor, "focus")
    .mockImplementation(() => undefined);

  Transforms.select(editor, { path: [0, 0], offset: 1 });
  editor.insertText(" ", true);

  const selection = editor.selection;
  expect(selection).not.toBeNull();
  if (selection) {
    const listEntry = Editor.above(editor, {
      at: selection.focus,
      match: (node) =>
        Element.isElement(node) &&
        (node.type === "list_item" ||
          node.type === "bullet_list" ||
          node.type === "ordered_list"),
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
  const nonSpacer = editor.children.filter((node) => !isSpacerParagraph(node));
  expect(nonSpacer.length).toBe(2);
  expect(nonSpacer[0]?.["type"]).toBe("paragraph");
  expect(nonSpacer[1]?.["type"]).toBe("bullet_list");

  const listEntry = findFirstList(editor);
  expect(listEntry).not.toBeNull();
  const listPath = listEntry ? listEntry[1] : [1];
  const listText = Editor.string(editor, listPath);
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

  const listEntries = Array.from(
    Editor.nodes(editor, {
      at: [],
      match: (node) =>
        Element.isElement(node) &&
        (node.type === "bullet_list" || node.type === "ordered_list"),
    }),
  ) as [Element, number[]][];
  expect(listEntries.length).toBe(2);
  const listTexts = listEntries.map((entry) => Editor.string(editor, entry[1]));
  expect(listTexts.some((text) => text.includes("existing"))).toBe(true);

  focusSpy.mockRestore();
});
