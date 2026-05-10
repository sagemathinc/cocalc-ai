/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import "../elements/types";

import { createEditor, Descendant, Editor, Transforms } from "slate";

import type { SlateEditor } from "../types";
import {
  escapeMarkedTextBoundaryOnArrowLeft,
  escapeMarkedTextBoundaryOnArrowRight,
} from "../keyboard/arrow-keys";
import { withAutoFormat } from "../format";
import { withReact } from "../slate-react";

function createSlateEditor(value: Descendant[]): SlateEditor {
  const editor = createEditor() as unknown as SlateEditor;
  editor.children = value;
  editor.selection = null;
  return editor;
}

describe("ArrowRight mark boundary escape", () => {
  it("inserts a plain trailing space after a final inline code leaf", () => {
    const editor = createSlateEditor([
      {
        type: "paragraph",
        children: [{ text: "consider " }, { text: "2+2", code: true }],
      },
    ]);

    Transforms.select(editor, { path: [0, 1], offset: "2+2".length });

    expect(escapeMarkedTextBoundaryOnArrowRight(editor)).toBe(true);
    expect(editor.children[0]?.["children"]).toEqual([
      { text: "consider " },
      { text: "2+2", code: true },
      { text: " " },
    ]);
    expect(editor.selection?.focus).toEqual({ path: [0, 2], offset: 1 });
    expect(Editor.marks(editor)?.code).not.toBe(true);
  });

  it("escapes dynamic color and font marks", () => {
    const editor = createSlateEditor([
      {
        type: "paragraph",
        children: [
          {
            text: "styled",
            "color:#ff0000": true,
            "font-family:monospace": true,
          },
        ],
      } as any,
    ]);

    Transforms.select(editor, { path: [0, 0], offset: "styled".length });

    expect(escapeMarkedTextBoundaryOnArrowRight(editor)).toBe(true);
    expect(editor.children[0]?.["children"]).toEqual([
      {
        text: "styled",
        "color:#ff0000": true,
        "font-family:monospace": true,
      },
      { text: " " },
    ]);
    expect(editor.selection?.focus).toEqual({ path: [0, 1], offset: 1 });
  });

  it("moves into an existing plain next text node without inserting", () => {
    const editor = createSlateEditor([
      {
        type: "paragraph",
        children: [
          { text: "code", code: true },
          { text: " after", search: true },
        ],
      },
    ]);

    Transforms.select(editor, { path: [0, 0], offset: "code".length });

    expect(escapeMarkedTextBoundaryOnArrowRight(editor)).toBe(true);
    expect(editor.children[0]?.["children"]).toEqual([
      { text: "code", code: true },
      { text: " after", search: true },
    ]);
    expect(editor.selection?.focus).toEqual({ path: [0, 1], offset: 1 });
  });

  it("replaces an empty plain next text node after marked text", () => {
    const editor = createSlateEditor([
      {
        type: "paragraph",
        children: [{ text: "code", code: true }, { text: "" }],
      },
    ]);

    Transforms.select(editor, { path: [0, 0], offset: "code".length });

    expect(escapeMarkedTextBoundaryOnArrowRight(editor)).toBe(true);
    expect(editor.children[0]?.["children"]).toEqual([
      { text: "code", code: true },
      { text: " " },
    ]);
    expect(editor.selection?.focus).toEqual({ path: [0, 1], offset: 1 });
  });

  it("inserts plain text before the next marked sibling", () => {
    const editor = createSlateEditor([
      {
        type: "paragraph",
        children: [
          { text: "code", code: true },
          { text: "bold", bold: true },
        ],
      },
    ]);

    Transforms.select(editor, { path: [0, 0], offset: "code".length });

    expect(escapeMarkedTextBoundaryOnArrowRight(editor)).toBe(true);
    expect(editor.children[0]?.["children"]).toEqual([
      { text: "code", code: true },
      { text: " " },
      { text: "bold", bold: true },
    ]);
    expect(editor.selection?.focus).toEqual({ path: [0, 1], offset: 1 });
  });

  it("escapes from an empty plain leaf immediately after marked text", () => {
    const editor = createSlateEditor([
      {
        type: "paragraph",
        children: [{ text: "2+2", code: true }, { text: "" }],
      },
    ]);

    Transforms.select(editor, { path: [0, 1], offset: 0 });

    expect(escapeMarkedTextBoundaryOnArrowRight(editor)).toBe(true);
    expect(editor.children[0]?.["children"]).toEqual([
      { text: "2+2", code: true },
      { text: " " },
    ]);
    expect(editor.selection?.focus).toEqual({ path: [0, 1], offset: 1 });
  });

  it("does not rewrite empty plain leaves after unmarked text", () => {
    const editor = createSlateEditor([
      {
        type: "paragraph",
        children: [{ text: "plain" }, { text: "" }],
      },
    ]);

    Transforms.select(editor, { path: [0, 1], offset: 0 });

    expect(escapeMarkedTextBoundaryOnArrowRight(editor)).toBe(false);
    expect(editor.children[0]?.["children"]).toEqual([
      { text: "plain" },
      { text: "" },
    ]);
  });

  it("does not handle unmarked text or non-boundary selections", () => {
    const editor = createSlateEditor([
      {
        type: "paragraph",
        children: [{ text: "plain" }, { text: "code", code: true }],
      },
    ]);

    Transforms.select(editor, { path: [0, 0], offset: "plain".length });
    expect(escapeMarkedTextBoundaryOnArrowRight(editor)).toBe(false);

    Transforms.select(editor, { path: [0, 1], offset: 2 });
    expect(escapeMarkedTextBoundaryOnArrowRight(editor)).toBe(false);
  });

  it("escapes after autoformatting inline code then deleting the trailing space", () => {
    const editor = withAutoFormat(withReact(createEditor()));
    editor.children = [
      {
        type: "paragraph",
        children: [{ text: "`2+2`" }],
      },
    ];
    editor.selection = null;

    Transforms.select(editor, { path: [0, 0], offset: "`2+2`".length });
    editor.insertText(" ", true);
    editor.deleteBackward();

    expect(Editor.string(editor, [0])).toBe("2+2");
    expect(escapeMarkedTextBoundaryOnArrowRight(editor as any)).toBe(true);
    expect(editor.children[0]?.["children"]).toEqual([
      { text: "2+2", code: true },
      { text: " " },
    ]);
    expect(editor.selection?.focus).toEqual({ path: [0, 1], offset: 1 });
  });
});

describe("ArrowLeft mark boundary escape", () => {
  it("clears active marks before an initial inline code leaf", () => {
    const editor = createSlateEditor([
      {
        type: "paragraph",
        children: [{ text: "2+3", code: true }],
      },
    ]);

    Transforms.select(editor, { path: [0, 0], offset: 0 });

    expect(escapeMarkedTextBoundaryOnArrowLeft(editor)).toBe(true);
    expect(editor.children[0]?.["children"]).toEqual([
      { text: "2+3", code: true },
    ]);
    expect(editor.selection?.focus).toEqual({ path: [0, 0], offset: 0 });
    editor.insertText("x");
    expect(editor.children[0]?.["children"]).toEqual([
      { text: "x" },
      { text: "2+3", code: true },
    ]);
  });

  it("moves into an existing plain previous text node without inserting", () => {
    const editor = createSlateEditor([
      {
        type: "paragraph",
        children: [{ text: "before " }, { text: "code", code: true }],
      },
    ]);

    Transforms.select(editor, { path: [0, 1], offset: 0 });

    expect(escapeMarkedTextBoundaryOnArrowLeft(editor)).toBe(true);
    expect(editor.children[0]?.["children"]).toEqual([
      { text: "before " },
      { text: "code", code: true },
    ]);
    expect(editor.selection?.focus).toEqual({ path: [0, 0], offset: 7 });
  });

  it("escapes from an empty plain leaf immediately before marked text", () => {
    const editor = createSlateEditor([
      {
        type: "paragraph",
        children: [{ text: "" }, { text: "2+3", code: true }],
      },
    ]);

    Transforms.select(editor, { path: [0, 0], offset: 0 });

    expect(escapeMarkedTextBoundaryOnArrowLeft(editor)).toBe(true);
    expect(editor.children[0]?.["children"]).toEqual([
      { text: "" },
      { text: "2+3", code: true },
    ]);
    expect(editor.selection?.focus).toEqual({ path: [0, 0], offset: 0 });
    editor.insertText("x");
    expect(editor.children[0]?.["children"]).toEqual([
      { text: "x" },
      { text: "2+3", code: true },
    ]);
  });

  it("does not handle unmarked text or non-boundary selections", () => {
    const editor = createSlateEditor([
      {
        type: "paragraph",
        children: [{ text: "plain" }, { text: "code", code: true }],
      },
    ]);

    Transforms.select(editor, { path: [0, 0], offset: 0 });
    expect(escapeMarkedTextBoundaryOnArrowLeft(editor)).toBe(false);

    Transforms.select(editor, { path: [0, 1], offset: 2 });
    expect(escapeMarkedTextBoundaryOnArrowLeft(editor)).toBe(false);
  });
});
