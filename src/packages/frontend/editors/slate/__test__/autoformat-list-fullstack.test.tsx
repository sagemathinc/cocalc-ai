import "../elements/types";

import { createEditor, Descendant, Transforms } from "slate";

import { withReact } from "../slate-react";
import { withAutoFormat } from "../format";
import { withNormalize } from "../normalize";
import { withIsInline, withIsVoid } from "../plugins";
import { withInsertBreakHack } from "../elements/link/editable";
import { withCodeLineInsertBreak } from "../elements/code-block/with-code-line-insert-break";
import { withNonfatalRange, withSelectionSafety } from "../patches";
import { slate_to_markdown } from "../slate-to-markdown";

function makeProdLikeEditor(): any {
  return withSelectionSafety(
    withNonfatalRange(
      withInsertBreakHack(
        withNormalize(
          withAutoFormat(
            withIsInline(
              withIsVoid(withCodeLineInsertBreak(withReact(createEditor()))),
            ),
          ),
        ),
      ),
    ),
  );
}

test("full stack: '> -x' then space keeps x", () => {
  const editor = makeProdLikeEditor();
  editor.children = [
    {
      type: "blockquote",
      children: [{ type: "paragraph", children: [{ text: "-x" }] }],
    },
  ] as Descendant[];
  editor.selection = null;

  Transforms.select(editor, { path: [0, 0, 0], offset: 1 });
  // @ts-ignore custom second arg is supported by withAutoFormat
  editor.insertText(" ", true);

  const md = slate_to_markdown(editor.children, { preserveBlankLines: false });
  expect(md).toContain("> - x");
  expect(md).toContain("x");
});

test("full stack: '-x' then space keeps x", () => {
  const editor = makeProdLikeEditor();
  editor.children = [{ type: "paragraph", children: [{ text: "-x" }] }] as Descendant[];
  editor.selection = null;

  Transforms.select(editor, { path: [0, 0], offset: 1 });
  // @ts-ignore custom second arg is supported by withAutoFormat
  editor.insertText(" ", true);

  const md = slate_to_markdown(editor.children, { preserveBlankLines: false });
  expect(md).toContain("- x");
  expect(md).toContain("x");
});

test("full stack: '1.x' then space keeps x", () => {
  const editor = makeProdLikeEditor();
  editor.children = [{ type: "paragraph", children: [{ text: "1.x" }] }] as Descendant[];
  editor.selection = null;

  Transforms.select(editor, { path: [0, 0], offset: 2 });
  // @ts-ignore custom second arg is supported by withAutoFormat
  editor.insertText(" ", true);

  const md = slate_to_markdown(editor.children, { preserveBlankLines: false });
  expect(md).toContain("1. x");
  expect(md).toContain("x");
});

test("full stack: typing '- ' at start of top-level text keeps trailing text", () => {
  const editor = makeProdLikeEditor();
  editor.children = [{ type: "paragraph", children: [{ text: "foo" }] }] as Descendant[];
  editor.selection = null;

  Transforms.select(editor, { path: [0, 0], offset: 0 });
  // @ts-ignore custom second arg is supported by withAutoFormat
  editor.insertText("-", true);
  // @ts-ignore custom second arg is supported by withAutoFormat
  editor.insertText(" ", true);

  const md = slate_to_markdown(editor.children, { preserveBlankLines: false });
  expect(md).toContain("- foo");
});

test("full stack: typing '1. ' at start of top-level text keeps trailing text", () => {
  const editor = makeProdLikeEditor();
  editor.children = [{ type: "paragraph", children: [{ text: "foo" }] }] as Descendant[];
  editor.selection = null;

  Transforms.select(editor, { path: [0, 0], offset: 0 });
  // @ts-ignore custom second arg is supported by withAutoFormat
  editor.insertText("1", true);
  // @ts-ignore custom second arg is supported by withAutoFormat
  editor.insertText(".", true);
  // @ts-ignore custom second arg is supported by withAutoFormat
  editor.insertText(" ", true);

  const md = slate_to_markdown(editor.children, { preserveBlankLines: false });
  expect(md).toContain("1. foo");
});

test("full stack: typing '- ' at start of quoted text keeps trailing text", () => {
  const editor = makeProdLikeEditor();
  editor.children = [
    { type: "blockquote", children: [{ type: "paragraph", children: [{ text: "foo" }] }] },
  ] as Descendant[];
  editor.selection = null;

  Transforms.select(editor, { path: [0, 0, 0], offset: 0 });
  // @ts-ignore custom second arg is supported by withAutoFormat
  editor.insertText("-", true);
  // @ts-ignore custom second arg is supported by withAutoFormat
  editor.insertText(" ", true);

  const md = slate_to_markdown(editor.children, { preserveBlankLines: false });
  expect(md).toContain("> - foo");
});

test("full stack: typing '1. ' at start of quoted text keeps trailing text", () => {
  const editor = makeProdLikeEditor();
  editor.children = [
    { type: "blockquote", children: [{ type: "paragraph", children: [{ text: "foo" }] }] },
  ] as Descendant[];
  editor.selection = null;

  Transforms.select(editor, { path: [0, 0, 0], offset: 0 });
  // @ts-ignore custom second arg is supported by withAutoFormat
  editor.insertText("1", true);
  // @ts-ignore custom second arg is supported by withAutoFormat
  editor.insertText(".", true);
  // @ts-ignore custom second arg is supported by withAutoFormat
  editor.insertText(" ", true);

  const md = slate_to_markdown(editor.children, { preserveBlankLines: false });
  expect(md).toContain("> 1. foo");
});

test("full stack: unsafe paragraph selection still preserves quoted trailing text", () => {
  const editor = makeProdLikeEditor();
  editor.children = [
    { type: "blockquote", children: [{ type: "paragraph", children: [{ text: "foo" }] }] },
  ] as Descendant[];
  editor.selection = {
    anchor: { path: [0, 0] as any, offset: 0 },
    focus: { path: [0, 0] as any, offset: 0 },
  } as any;

  // @ts-ignore custom second arg is supported by withAutoFormat
  editor.insertText("-", true);
  // @ts-ignore custom second arg is supported by withAutoFormat
  editor.insertText(" ", true);

  const md = slate_to_markdown(editor.children, { preserveBlankLines: false });
  expect(md).toContain("> - foo");
});

test("full stack: unsafe paragraph selection still preserves top-level trailing text", () => {
  const editor = makeProdLikeEditor();
  editor.children = [{ type: "paragraph", children: [{ text: "foo" }] }] as Descendant[];
  editor.selection = {
    anchor: { path: [0] as any, offset: 0 },
    focus: { path: [0] as any, offset: 0 },
  } as any;

  // @ts-ignore custom second arg is supported by withAutoFormat
  editor.insertText("-", true);
  // @ts-ignore custom second arg is supported by withAutoFormat
  editor.insertText(" ", true);

  const md = slate_to_markdown(editor.children, { preserveBlankLines: false });
  expect(md).toContain("- foo");
});
