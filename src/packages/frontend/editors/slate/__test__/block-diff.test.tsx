import "../elements/types";

import { createEditor, Descendant, Editor } from "slate";

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
});
