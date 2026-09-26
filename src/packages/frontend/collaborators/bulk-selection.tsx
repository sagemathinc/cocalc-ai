/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Bulk selection controls for collaborator search results.

"Select all" only adds exact email matches (email-only invitees and accounts
found by an exact email address search).  Name-search matches can be
ambiguous, so they must still be reviewed and selected individually.
*/

import { Button } from "antd";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { plural } from "@cocalc/util/misc";

// Keys (in display order) of the current results that "Select all" may add.
export function bulkSelectableCollaboratorKeys(
  orderedKeys: string[],
  exactMatchKeys: ReadonlySet<string>,
): string[] {
  return Array.from(
    new Set(orderedKeys.filter((key) => !!key && exactMatchKeys.has(key))),
  );
}

// Appends keys to the current selection, keeping existing order and
// dropping duplicates.
export function selectAllCollaboratorEntries(
  selectedEntries: string[],
  keys: string[],
): string[] {
  return Array.from(
    new Set([...selectedEntries, ...keys].filter((key) => !!key)),
  );
}

interface Props {
  // keys of current results eligible for "Select all"
  bulkKeys: string[];
  // number of current selectable results that are name-search matches only
  nameMatchCount: number;
  selectedEntries: string[];
  onChange: (selectedEntries: string[]) => void;
}

export function CollaboratorBulkSelection({
  bulkKeys,
  nameMatchCount,
  selectedEntries,
  onChange,
}: Props) {
  const selected = new Set(selectedEntries);
  const unselectedBulkCount = bulkKeys.filter(
    (key) => !selected.has(key),
  ).length;
  const numSelected = selectedEntries.length;
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          alignItems: "center",
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <Button
          size="small"
          disabled={unselectedBulkCount === 0}
          onClick={() =>
            onChange(selectAllCollaboratorEntries(selectedEntries, bulkKeys))
          }
        >
          Select all {bulkKeys.length} email{" "}
          {plural(bulkKeys.length, "match", "matches")}
        </Button>
        <Button
          size="small"
          disabled={numSelected === 0}
          onClick={() => onChange([])}
        >
          Clear selection
        </Button>
        <span
          aria-live="polite"
          role="status"
          style={{ color: UI_COLORS.secondary, fontSize: 12 }}
        >
          {numSelected} selected
        </span>
      </div>
      {nameMatchCount > 0 && (
        <div style={{ color: UI_COLORS.secondary, fontSize: 12, marginTop: 6 }}>
          {nameMatchCount} name-search{" "}
          {plural(nameMatchCount, "match is", "matches are")} not included in
          Select all; review and select {plural(nameMatchCount, "it", "them")}{" "}
          individually.
        </div>
      )}
    </div>
  );
}
