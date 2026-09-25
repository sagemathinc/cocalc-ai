/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { renderHook } from "@testing-library/react";
import { createEditor } from "slate";

import { useCursorDecorate } from "../cursors/other-users";
import type { SlateEditor } from "../editable-markdown";

test("ignores a decoration entry removed by an external update", () => {
  const editor = createEditor() as SlateEditor;
  editor.children = [{ type: "paragraph", children: [{ text: "current" }] }];
  const staleText = { text: "removed" };
  const search = {
    decorate: () => [],
    search: "",
  } as any;
  const { result } = renderHook(() =>
    useCursorDecorate({ editor, value: "current", search }),
  );

  expect(result.current([staleText, [2]])).toEqual([]);
});
