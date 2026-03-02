import "../elements/types";

import { createEditor, Descendant, Editor, Text } from "slate";

import { withReact } from "../slate-react";
import { withAutoFormat } from "../format";
import { withNormalize } from "../normalize";
import { withIsInline, withIsVoid } from "../plugins";
import { markdown_to_slate } from "../markdown-to-slate";
import { slate_to_markdown } from "../slate-to-markdown";
import { withCodeLineInsertBreak } from "../elements/code-block/with-code-line-insert-break";

function makeEditor() {
  return withNormalize(
    withAutoFormat(
      withIsInline(withIsVoid(withCodeLineInsertBreak(withReact(createEditor())))),
    ),
  );
}

function findFirstTextPath(editor: Editor, value: string): number[] {
  const it = Editor.nodes(editor, {
    at: [],
    match: (node) => Text.isText(node) && node.text.includes(value),
  });
  const next = it.next().value as [Text, number[]] | undefined;
  if (!next) throw new Error(`missing text node containing '${value}'`);
  return next[1];
}

test("backspace before x after multiline quote appends to final quoted line", () => {
  const editor: any = makeEditor();
  editor.preserveBlankLines = false;
  editor.children = markdown_to_slate("> foo\n>\n> bar\n\nx", false, {}) as Descendant[];
  Editor.normalize(editor, { force: true });

  const xPath = findFirstTextPath(editor, "x");
  editor.selection = {
    anchor: { path: xPath, offset: 0 },
    focus: { path: xPath, offset: 0 },
  };

  editor.deleteBackward();

  const markdown = slate_to_markdown(editor.children, {
    preserveBlankLines: false,
  });
  expect(markdown).toContain("> barx");
  expect(markdown).not.toContain("> foox");
});

test("backspace before x after multiline quote with preserveBlankLines=true appends to final quoted line", () => {
  const editor: any = makeEditor();
  editor.preserveBlankLines = true;
  editor.children = markdown_to_slate("> foo\n>\n> bar\n\nx", false, {}) as Descendant[];
  Editor.normalize(editor, { force: true });

  const xPath = findFirstTextPath(editor, "x");
  editor.selection = {
    anchor: { path: xPath, offset: 0 },
    focus: { path: xPath, offset: 0 },
  };
  editor.deleteBackward();

  const markdown = slate_to_markdown(editor.children, {
    preserveBlankLines: true,
  });
  expect(markdown).toContain("> barx");
  expect(markdown).not.toContain("> foox");
});

test("backspace before x with two quoted paragraphs appends to second paragraph", () => {
  const editor: any = makeEditor();
  editor.preserveBlankLines = false;
  editor.children = [
    {
      type: "blockquote",
      children: [
        { type: "paragraph", children: [{ text: "foo" }] },
        { type: "paragraph", children: [{ text: "bar" }] },
      ],
    },
    { type: "paragraph", children: [{ text: "x" }] },
  ] as Descendant[];
  Editor.normalize(editor, { force: true });

  const xPath = findFirstTextPath(editor, "x");
  editor.selection = {
    anchor: { path: xPath, offset: 0 },
    focus: { path: xPath, offset: 0 },
  };
  editor.deleteBackward();

  const markdown = slate_to_markdown(editor.children, {
    preserveBlankLines: false,
  });
  expect(markdown).toContain("> barx");
  expect(markdown).not.toContain("> foox");
});

test("backspace before x with softbreak quote lines appends to last line", () => {
  const editor: any = makeEditor();
  editor.preserveBlankLines = false;
  editor.children = [
    {
      type: "blockquote",
      children: [
        {
          type: "paragraph",
          children: [
            { text: "foo" },
            { type: "softbreak", isInline: true, isVoid: true, children: [{ text: "" }] },
            { type: "softbreak", isInline: true, isVoid: true, children: [{ text: "" }] },
            { text: "bar" },
          ],
        },
      ],
    },
    { type: "paragraph", children: [{ text: "x" }] },
  ] as Descendant[];
  Editor.normalize(editor, { force: true });

  const xPath = findFirstTextPath(editor, "x");
  editor.selection = {
    anchor: { path: xPath, offset: 0 },
    focus: { path: xPath, offset: 0 },
  };
  editor.deleteBackward();

  const markdown = slate_to_markdown(editor.children, {
    preserveBlankLines: false,
  });
  expect(markdown).toContain("> barx");
  expect(markdown).not.toContain("> foox");
});

test("backspace before x with nested quote child does not collapse to first paragraph", () => {
  const editor: any = makeEditor();
  editor.preserveBlankLines = false;
  editor.children = [
    {
      type: "blockquote",
      children: [
        { type: "paragraph", children: [{ text: "foo" }] },
        {
          type: "blockquote",
          children: [{ type: "paragraph", children: [{ text: "bar" }] }],
        },
      ],
    },
    { type: "paragraph", children: [{ text: "x" }] },
  ] as Descendant[];
  Editor.normalize(editor, { force: true });

  const xPath = findFirstTextPath(editor, "x");
  editor.selection = {
    anchor: { path: xPath, offset: 0 },
    focus: { path: xPath, offset: 0 },
  };
  editor.deleteBackward();

  const markdown = slate_to_markdown(editor.children, {
    preserveBlankLines: false,
  });
  expect(markdown).not.toContain("> foox");
});
