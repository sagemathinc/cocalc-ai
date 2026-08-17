/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { AccountProjectListWindowRow } from "@cocalc/conat/hub/api/projects";

import { EMPTY_PROJECT_WINDOW, updateProjectWindow } from "./window";

function row(project_id: string, title = project_id) {
  return { project_id, title } as AccountProjectListWindowRow;
}

test("appends pages and deduplicates project updates", () => {
  const first = updateProjectWindow({
    state: EMPTY_PROJECT_WINDOW,
    page: [row("a"), row("b", "old")],
    pageSize: 2,
    replace: true,
  });
  const second = updateProjectWindow({
    state: first,
    page: [row("b", "new"), row("c")],
    pageSize: 2,
    replace: false,
  });
  assert.deepEqual(
    second.rows.map(({ project_id, title }) => ({ project_id, title })),
    [
      { project_id: "a", title: "a" },
      { project_id: "b", title: "new" },
      { project_id: "c", title: "c" },
    ],
  );
  assert.equal(second.offset, 4);
  assert.equal(second.hasMore, true);
});

test("replaces a window for a new search", () => {
  const result = updateProjectWindow({
    state: { rows: [row("old")], offset: 1, hasMore: true },
    page: [row("match")],
    pageSize: 20,
    replace: true,
  });
  assert.deepEqual(
    result.rows.map(({ project_id }) => project_id),
    ["match"],
  );
  assert.equal(result.offset, 1);
  assert.equal(result.hasMore, false);
});
