import "../elements/types";

import { createEditor, Descendant, Editor, Text, Transforms } from "slate";

import { withReact, ReactEditor } from "../slate-react";
import { withIsInline, withIsVoid } from "../plugins";
import { withAutoFormat } from "../format";

test("autoformat inline math at cursor", () => {
  const editor = withAutoFormat(
    withIsInline(withIsVoid(withReact(createEditor()))),
  );
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

test("autoformat inline math moves selection after math", () => {
  const editor = withAutoFormat(
    withIsInline(withIsVoid(withReact(createEditor()))),
  );
  const value: Descendant[] = [
    { type: "paragraph", children: [{ text: "$x$" }] },
  ];
  editor.children = value;
  editor.selection = null;

  const focusSpy = jest
    .spyOn(ReactEditor, "focus")
    .mockImplementation(() => undefined);

  const textLength = "$x$".length;
  Transforms.select(editor, { path: [0, 0], offset: textLength });
  editor.insertText(" ", true);

  const paragraph = editor.children[0] as any;
  const mathIndex = paragraph?.children?.findIndex(
    (child) => child?.["type"] === "math_inline",
  );
  const trailingIndex =
    typeof mathIndex === "number" && mathIndex >= 0 ? mathIndex + 1 : -1;
  const trailing = paragraph?.children?.[trailingIndex];

  expect(editor.selection).not.toBeNull();
  if (editor.selection && trailingIndex >= 0) {
    expect(editor.selection.focus.path).toEqual([0, trailingIndex]);
    expect(editor.selection.focus.offset).toBe(trailing?.text?.length ?? 0);
  }

  focusSpy.mockRestore();
});

test("autoformat inline math preserves trailing text in the same paragraph", () => {
  const editor = withAutoFormat(
    withIsInline(withIsVoid(withReact(createEditor()))),
  );
  const value: Descendant[] = [
    { type: "paragraph", children: [{ text: "$x$y" }] },
  ];
  editor.children = value;
  editor.selection = null;

  const focusSpy = jest
    .spyOn(ReactEditor, "focus")
    .mockImplementation(() => undefined);

  Transforms.select(editor, { path: [0, 0], offset: "$x$".length });
  editor.insertText(" ", true);

  const paragraph = editor.children[0] as any;
  const mathIndex = paragraph?.children?.findIndex(
    (child) => child?.["type"] === "math_inline",
  );
  expect(mathIndex).toBeGreaterThanOrEqual(0);
  expect(paragraph?.children?.some((child) => child?.text?.includes("y"))).toBe(true);

  focusSpy.mockRestore();
});

test("autoformat inline math keeps caret before existing trailing words", () => {
  const editor = withAutoFormat(
    withIsInline(withIsVoid(withReact(createEditor()))),
  );
  const value: Descendant[] = [
    { type: "paragraph", children: [{ text: "$x$ foo bar" }] },
  ];
  editor.children = value;
  editor.selection = null;

  const focusSpy = jest
    .spyOn(ReactEditor, "focus")
    .mockImplementation(() => undefined);

  Transforms.select(editor, { path: [0, 0], offset: "$x$".length });
  editor.insertText(" ", true);

  expect(editor.selection).not.toBeNull();
  if (editor.selection) {
    const focus = editor.selection.focus;
    const [focusNode] = Editor.node(editor, focus.path);
    expect(Text.isText(focusNode)).toBe(true);
    if (Text.isText(focusNode)) {
      const text = focusNode.text;
      const fooIndex = text.indexOf("foo");
      expect(fooIndex).toBeGreaterThanOrEqual(0);
      expect(focus.offset).toBeLessThanOrEqual(fooIndex);
    }
  }

  focusSpy.mockRestore();
});
