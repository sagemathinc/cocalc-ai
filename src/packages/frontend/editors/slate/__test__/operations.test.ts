/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import "../elements/types";

import { cloneDeep } from "lodash";
import { createEditor, type Descendant, type Operation } from "slate";

import { applyOperations } from "../operations";
import type { SlateEditor } from "../types";

test("preflight rejects a heterogeneous merge without changing the editor", () => {
  const editor = createEditor() as SlateEditor;
  editor.children = [
    {
      type: "paragraph",
      children: [
        { type: "code_line", children: [{ text: "code" }] },
        { text: "plain" },
      ],
    },
  ] as Descendant[];
  const before = cloneDeep(editor.children);
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const operation = {
    type: "merge_node",
    path: [0, 1],
    position: 1,
    properties: {},
  } as Operation;

  try {
    expect(applyOperations(editor, [operation])).toBe(false);
  } finally {
    warn.mockRestore();
  }
  expect(editor.children).toEqual(before);
  expect(editor.operations).toEqual([]);
});

test("a valid batch is applied after preflight", () => {
  const editor = createEditor() as SlateEditor;
  editor.children = [
    {
      type: "paragraph",
      children: [{ text: "a" }, { text: "b" }],
    },
  ] as Descendant[];
  const operation = {
    type: "merge_node",
    path: [0, 1],
    position: 1,
    properties: {},
  } as Operation;

  expect(applyOperations(editor, [operation])).toBe(true);
  expect(editor.children).toEqual([
    { type: "paragraph", children: [{ text: "ab" }] },
  ]);
});

test("ordinary text operations stay on the fast path", () => {
  const editor = createEditor() as SlateEditor;
  editor.children = [
    { type: "paragraph", children: [{ text: "a" }] },
  ] as Descendant[];
  const operation = {
    type: "insert_text",
    path: [0, 0],
    offset: 1,
    text: "b",
  } as Operation;

  expect(applyOperations(editor, [operation])).toBe(true);
  expect(editor.children).toEqual([
    { type: "paragraph", children: [{ text: "ab" }] },
  ]);
});
