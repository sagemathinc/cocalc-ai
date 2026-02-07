import { createEditor, Descendant, Point } from "slate";

import { markdown_to_slate } from "../markdown-to-slate";
import {
  findSlatePointNearMarkdownPosition,
  markdownPositionToSlatePoint,
  nearestMarkdownPositionForSlatePoint,
} from "../sync";
import type { SlateEditor } from "../editable-markdown";

function createEditorFromMarkdown(markdown: string): SlateEditor {
  const editor = createEditor() as SlateEditor;
  editor.children = markdown_to_slate(markdown, false) as Descendant[];
  return editor;
}

function findInlineMathPoint(value: Descendant[]): Point {
  const stack: { node: any; path: number[] }[] = value.map((node, i) => ({
    node,
    path: [i],
  }));
  while (stack.length) {
    const { node, path } = stack.pop()!;
    if (node?.type === "math_inline" && Array.isArray(node.children)) {
      const childIndex = node.children.findIndex(
        (child: any) => child?.text != null,
      );
      const textIndex = childIndex >= 0 ? childIndex : 0;
      const text = node.children?.[textIndex]?.text ?? "";
      return { path: [...path, textIndex], offset: Math.min(1, text.length) };
    }
    if (Array.isArray(node?.children)) {
      node.children.forEach((child: any, idx: number) => {
        stack.push({ node: child, path: [...path, idx] });
      });
    }
  }
  throw new Error("Inline math node not found");
}

test("markdown->slate fallback stays within block", () => {
  const markdown = "laskdjf\n\n# foo\n\nconsider $x^3$ laksdj flajsd fasdfja";
  const lines = markdown.split("\n");
  const line = lines.findIndex((l) => l.includes("consider"));
  expect(line).toBeGreaterThan(-1);
  const ch = lines[line].indexOf("$x^3$") + 1;
  expect(ch).toBeGreaterThan(0);

  const editor = createEditorFromMarkdown(markdown);

  const expected = markdownPositionToSlatePoint({
    markdown,
    pos: { line, ch: 0 },
    editor,
  });
  expect(expected).toBeDefined();

  const actual = findSlatePointNearMarkdownPosition({
    markdown,
    pos: { line, ch },
    editor,
  });
  expect(actual).toBeDefined();
  expect(expected).toBeDefined();
  if (actual && expected) {
    expect(actual.path[0]).toBe(expected.path[0]);
    expect(actual.offset).toBe(0);
  }
});

test("slate->markdown fallback returns block start", () => {
  const markdown = "laskdjf\n\n# foo\n\nconsider $x^3$ laksdj flajsd fasdfja";
  const lines = markdown.split("\n");
  const line = lines.findIndex((l) => l.includes("consider"));
  expect(line).toBeGreaterThan(-1);

  const editor = createEditorFromMarkdown(markdown);
  const point = findInlineMathPoint(editor.children as Descendant[]);
  const pos = nearestMarkdownPositionForSlatePoint(editor, point);
  expect(pos).toEqual({ line, ch: 0 });
});
