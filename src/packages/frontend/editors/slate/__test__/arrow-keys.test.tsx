/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import "../elements/types";

import { createEditor, Descendant, Editor, Transforms } from "slate";

import type { SlateEditor } from "../types";
import { escapeMarkedTextBoundaryOnArrowRight } from "../keyboard/arrow-keys";

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
});
