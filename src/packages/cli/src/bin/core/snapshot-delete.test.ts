import assert from "node:assert/strict";
import { test } from "node:test";
import { selectSnapshotsToDelete } from "./snapshot-delete";

const existing = [
  "2026-09-08T01:36:38.856Z",
  "2026-10-07T19:59:39.136Z",
  "support-cleanup-2026-10-07",
];

test("deletes explicitly named snapshots, deduplicated", () => {
  assert.deepEqual(
    selectSnapshotsToDelete({
      existing,
      names: ["2026-09-08T01:36:38.856Z", "2026-09-08T01:36:38.856Z"],
    }),
    ["2026-09-08T01:36:38.856Z"],
  );
});

test("all-except keeps only the named snapshots", () => {
  assert.deepEqual(
    selectSnapshotsToDelete({
      existing,
      allExcept: ["support-cleanup-2026-10-07"],
    }),
    ["2026-09-08T01:36:38.856Z", "2026-10-07T19:59:39.136Z"],
  );
});

test("refuses unknown names, a mistyped kept name, and ambiguous selectors", () => {
  assert.throws(
    () => selectSnapshotsToDelete({ existing, names: ["nope"] }),
    /no such snapshot: nope/,
  );
  assert.throws(
    () => selectSnapshotsToDelete({ existing, allExcept: ["typo"] }),
    /snapshot to keep does not exist/,
  );
  assert.throws(
    () =>
      selectSnapshotsToDelete({
        existing,
        names: [existing[0]],
        allExcept: [existing[2]],
      }),
    /either --name or --all-except/,
  );
  assert.throws(() => selectSnapshotsToDelete({ existing }), /specify --name/);
});
