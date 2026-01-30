import "../elements/types";

import { createEditor, Descendant, Editor, Transforms } from "slate";

import { applyBlockDiffPatch, diffBlockSignatures } from "../sync/block-diff";

function applyAndExpect(prev: Descendant[], next: Descendant[]) {
  const editor = createEditor();
  editor.children = prev;
  Editor.withoutNormalizing(editor, () => {
    const result = applyBlockDiffPatch(editor, prev, next);
    expect(result.applied).toBe(true);
  });
  expect(editor.children).toEqual(next);
}

function getSelectedBlockText(editor: Editor): string | null {
  if (!editor.selection) return null;
  const entry = Editor.above(editor, {
    at: editor.selection.anchor,
    match: (node) => Editor.isBlock(editor, node),
  });
  if (!entry) return null;
  return Editor.string(editor, entry[1]);
}

describe("block diff signatures", () => {
  test("detects simple replace", () => {
    const prev: Descendant[] = [
      { type: "paragraph", children: [{ text: "a" }] },
      { type: "paragraph", children: [{ text: "b" }] },
      { type: "paragraph", children: [{ text: "c" }] },
    ];
    const next: Descendant[] = [
      { type: "paragraph", children: [{ text: "a" }] },
      { type: "paragraph", children: [{ text: "x" }] },
      { type: "paragraph", children: [{ text: "c" }] },
    ];

    const chunks = diffBlockSignatures(prev, next);
    expect(chunks).toEqual([
      { op: "equal", prevIndex: 0, nextIndex: 0, count: 1 },
      { op: "delete", prevIndex: 1, nextIndex: 1, count: 1 },
      { op: "insert", prevIndex: 2, nextIndex: 1, count: 1 },
      { op: "equal", prevIndex: 2, nextIndex: 2, count: 1 },
    ]);
  });

  test("handles duplicate signatures", () => {
    const prev: Descendant[] = [
      { type: "paragraph", children: [{ text: "same" }] },
      { type: "paragraph", children: [{ text: "same" }] },
      { type: "paragraph", children: [{ text: "tail" }] },
    ];
    const next: Descendant[] = [
      { type: "paragraph", children: [{ text: "same" }] },
      { type: "paragraph", children: [{ text: "tail" }] },
    ];

    const chunks = diffBlockSignatures(prev, next);
    const prevCount = chunks
      .filter((chunk) => chunk.op !== "insert")
      .reduce((sum, chunk) => sum + chunk.count, 0);
    const nextCount = chunks
      .filter((chunk) => chunk.op !== "delete")
      .reduce((sum, chunk) => sum + chunk.count, 0);
    const deleteCount = chunks
      .filter((chunk) => chunk.op === "delete")
      .reduce((sum, chunk) => sum + chunk.count, 0);

    expect(prevCount).toBe(prev.length);
    expect(nextCount).toBe(next.length);
    expect(deleteCount).toBe(1);
  });

  test("applyBlockDiffPatch mutates editor to next blocks", () => {
    const prev: Descendant[] = [
      { type: "paragraph", children: [{ text: "alpha" }] },
      { type: "paragraph", children: [{ text: "beta" }] },
      { type: "paragraph", children: [{ text: "gamma" }] },
    ];
    const next: Descendant[] = [
      { type: "paragraph", children: [{ text: "alpha" }] },
      { type: "paragraph", children: [{ text: "delta" }] },
      { type: "paragraph", children: [{ text: "gamma" }] },
      { type: "paragraph", children: [{ text: "epsilon" }] },
    ];
    applyAndExpect(prev, next);
  });

  test("applyBlockDiffPatch handles insert at start", () => {
    const prev: Descendant[] = [
      { type: "paragraph", children: [{ text: "b" }] },
      { type: "paragraph", children: [{ text: "c" }] },
    ];
    const next: Descendant[] = [
      { type: "paragraph", children: [{ text: "a" }] },
      { type: "paragraph", children: [{ text: "b" }] },
      { type: "paragraph", children: [{ text: "c" }] },
    ];
    applyAndExpect(prev, next);
  });

  test("applyBlockDiffPatch handles insert at end", () => {
    const prev: Descendant[] = [
      { type: "paragraph", children: [{ text: "a" }] },
      { type: "paragraph", children: [{ text: "b" }] },
    ];
    const next: Descendant[] = [
      { type: "paragraph", children: [{ text: "a" }] },
      { type: "paragraph", children: [{ text: "b" }] },
      { type: "paragraph", children: [{ text: "c" }] },
    ];
    applyAndExpect(prev, next);
  });

  test("applyBlockDiffPatch handles delete at start", () => {
    const prev: Descendant[] = [
      { type: "paragraph", children: [{ text: "a" }] },
      { type: "paragraph", children: [{ text: "b" }] },
      { type: "paragraph", children: [{ text: "c" }] },
    ];
    const next: Descendant[] = [
      { type: "paragraph", children: [{ text: "b" }] },
      { type: "paragraph", children: [{ text: "c" }] },
    ];
    applyAndExpect(prev, next);
  });

  test("applyBlockDiffPatch handles delete at end", () => {
    const prev: Descendant[] = [
      { type: "paragraph", children: [{ text: "a" }] },
      { type: "paragraph", children: [{ text: "b" }] },
      { type: "paragraph", children: [{ text: "c" }] },
    ];
    const next: Descendant[] = [
      { type: "paragraph", children: [{ text: "a" }] },
      { type: "paragraph", children: [{ text: "b" }] },
    ];
    applyAndExpect(prev, next);
  });

  test("applyBlockDiffPatch handles multiple inserts and deletes", () => {
    const prev: Descendant[] = [
      { type: "paragraph", children: [{ text: "a" }] },
      { type: "paragraph", children: [{ text: "b" }] },
      { type: "paragraph", children: [{ text: "c" }] },
      { type: "paragraph", children: [{ text: "d" }] },
    ];
    const next: Descendant[] = [
      { type: "paragraph", children: [{ text: "a" }] },
      { type: "paragraph", children: [{ text: "x" }] },
      { type: "paragraph", children: [{ text: "c" }] },
      { type: "paragraph", children: [{ text: "y" }] },
      { type: "paragraph", children: [{ text: "z" }] },
    ];
    applyAndExpect(prev, next);
  });

  test("applyBlockDiffPatch handles list/code block mix", () => {
    const prev: Descendant[] = [
      { type: "paragraph", children: [{ text: "intro" }] },
      {
        type: "code_block",
        info: "js",
        children: [{ type: "code_line", children: [{ text: "console.log(1);" }] }],
      },
      {
        type: "bullet_list",
        children: [
          {
            type: "list_item",
            children: [{ type: "paragraph", children: [{ text: "item" }] }],
          },
        ],
      },
    ];
    const next: Descendant[] = [
      { type: "paragraph", children: [{ text: "intro" }] },
      {
        type: "code_block",
        info: "js",
        children: [{ type: "code_line", children: [{ text: "console.log(2);" }] }],
      },
      {
        type: "bullet_list",
        children: [
          {
            type: "list_item",
            children: [{ type: "paragraph", children: [{ text: "item" }] }],
          },
          {
            type: "list_item",
            children: [{ type: "paragraph", children: [{ text: "item2" }] }],
          },
        ],
      },
    ];
    applyAndExpect(prev, next);
  });

  test("selection remains in unchanged block when inserts happen after", () => {
    const prev: Descendant[] = [
      { type: "paragraph", children: [{ text: "keep" }] },
      { type: "paragraph", children: [{ text: "tail" }] },
    ];
    const next: Descendant[] = [
      { type: "paragraph", children: [{ text: "keep" }] },
      { type: "paragraph", children: [{ text: "tail" }] },
      { type: "paragraph", children: [{ text: "new" }] },
    ];
    const editor = createEditor();
    editor.children = prev;
    Transforms.select(editor, { path: [0, 0], offset: 2 });
    Editor.withoutNormalizing(editor, () => {
      applyBlockDiffPatch(editor, prev, next);
    });
    expect(getSelectedBlockText(editor)).toBe("keep");
  });

  test("selection remains in unchanged block when inserts happen before", () => {
    const prev: Descendant[] = [
      { type: "paragraph", children: [{ text: "keep" }] },
      { type: "paragraph", children: [{ text: "tail" }] },
    ];
    const next: Descendant[] = [
      { type: "paragraph", children: [{ text: "new" }] },
      { type: "paragraph", children: [{ text: "keep" }] },
      { type: "paragraph", children: [{ text: "tail" }] },
    ];
    const editor = createEditor();
    editor.children = prev;
    Transforms.select(editor, { path: [0, 0], offset: 1 });
    Editor.withoutNormalizing(editor, () => {
      applyBlockDiffPatch(editor, prev, next);
    });
    expect(getSelectedBlockText(editor)).toBe("keep");
  });

  test("selection remains in unchanged block when deletes happen before", () => {
    const prev: Descendant[] = [
      { type: "paragraph", children: [{ text: "drop" }] },
      { type: "paragraph", children: [{ text: "keep" }] },
      { type: "paragraph", children: [{ text: "tail" }] },
    ];
    const next: Descendant[] = [
      { type: "paragraph", children: [{ text: "keep" }] },
      { type: "paragraph", children: [{ text: "tail" }] },
    ];
    const editor = createEditor();
    editor.children = prev;
    Transforms.select(editor, { path: [1, 0], offset: 2 });
    Editor.withoutNormalizing(editor, () => {
      applyBlockDiffPatch(editor, prev, next);
    });
    expect(getSelectedBlockText(editor)).toBe("keep");
  });

  test("selection remains in unchanged block when other blocks are replaced", () => {
    const prev: Descendant[] = [
      { type: "paragraph", children: [{ text: "keep" }] },
      { type: "paragraph", children: [{ text: "old" }] },
      { type: "paragraph", children: [{ text: "tail" }] },
    ];
    const next: Descendant[] = [
      { type: "paragraph", children: [{ text: "keep" }] },
      { type: "paragraph", children: [{ text: "new" }] },
      { type: "paragraph", children: [{ text: "tail" }] },
    ];
    const editor = createEditor();
    editor.children = prev;
    Transforms.select(editor, { path: [0, 0], offset: 3 });
    Editor.withoutNormalizing(editor, () => {
      applyBlockDiffPatch(editor, prev, next);
    });
    expect(getSelectedBlockText(editor)).toBe("keep");
  });

  test("selection moves to next block when selected block is deleted", () => {
    const prev: Descendant[] = [
      { type: "paragraph", children: [{ text: "A" }] },
      { type: "paragraph", children: [{ text: "B" }] },
      { type: "paragraph", children: [{ text: "C" }] },
    ];
    const next: Descendant[] = [
      { type: "paragraph", children: [{ text: "A" }] },
      { type: "paragraph", children: [{ text: "C" }] },
    ];
    const editor = createEditor();
    editor.children = prev;
    Transforms.select(editor, { path: [1, 0], offset: 0 });
    Editor.withoutNormalizing(editor, () => {
      applyBlockDiffPatch(editor, prev, next);
    });
    expect(getSelectedBlockText(editor)).toBe("C");
  });

  test("selection sticks to index when blocks are swapped", () => {
    const prev: Descendant[] = [
      { type: "paragraph", children: [{ text: "A" }] },
      { type: "paragraph", children: [{ text: "B" }] },
      { type: "paragraph", children: [{ text: "C" }] },
    ];
    const next: Descendant[] = [
      { type: "paragraph", children: [{ text: "C" }] },
      { type: "paragraph", children: [{ text: "B" }] },
      { type: "paragraph", children: [{ text: "A" }] },
    ];
    const editor = createEditor();
    editor.children = prev;
    Transforms.select(editor, { path: [0, 0], offset: 0 });
    Editor.withoutNormalizing(editor, () => {
      applyBlockDiffPatch(editor, prev, next);
    });
    expect(getSelectedBlockText(editor)).toBe("C");
  });
});
