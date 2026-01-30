import "../elements/types";

import { Descendant } from "slate";

import { diffBlockSignatures } from "../sync/block-diff";

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
});
