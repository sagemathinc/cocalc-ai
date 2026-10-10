/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The clipboard for copied notebook cells (Copy Cells / Paste Cells).

There is one clipboard for all notebooks, so cells can be copied between
notebooks. In a browser it is also kept in localStorage, so cells copied in one
tab or window can be pasted into a notebook in another. The stored copy can
hold notebook content on a shared computer, so it expires after a day and is
cleared on sign-out.
*/

import { fromJS, type List } from "immutable";

const STORAGE_KEY = "cocalc-jupyter-cell-clipboard";
export const CELL_CLIPBOARD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// localStorage typically allows about 5 MB per site.
export const CELL_CLIPBOARD_MAX_STORED_CHARS = 2_000_000;

let cells: List<any> | undefined = undefined;
let copiedAt = 0;

function storage(): Storage | undefined {
  try {
    return typeof window === "undefined"
      ? undefined
      : (window.localStorage ?? undefined);
  } catch {
    // e.g., storage disabled by the browser
    return undefined;
  }
}

function removeStored(ls: Storage): void {
  try {
    ls.removeItem(STORAGE_KEY);
  } catch {}
}

export function setCellClipboard(
  clipboard: List<any>,
  now: number = Date.now(),
): void {
  cells = clipboard;
  copiedAt = now;
  const ls = storage();
  if (ls == null) return;
  try {
    const value = JSON.stringify({ time: now, cells: clipboard.toJS() });
    if (value.length > CELL_CLIPBOARD_MAX_STORED_CHARS) {
      throw Error("copied cells are too large to share between tabs");
    }
    ls.setItem(STORAGE_KEY, value);
  } catch {
    // Too large, or storage is full: this copy stays in this tab, and other
    // tabs must not paste an older copy instead.
    removeStored(ls);
  }
}

// The most recently copied cells, from this tab or another one.
export function getCellClipboard(
  now: number = Date.now(),
): List<any> | undefined {
  const ls = storage();
  if (ls != null) {
    try {
      const raw = ls.getItem(STORAGE_KEY);
      if (raw) {
        const stored = JSON.parse(raw);
        const time = Number(stored?.time);
        if (
          !Number.isFinite(time) ||
          now - time > CELL_CLIPBOARD_MAX_AGE_MS ||
          !Array.isArray(stored?.cells)
        ) {
          removeStored(ls);
        } else if (time > copiedAt) {
          cells = fromJS(stored.cells) as List<any>;
          copiedAt = time;
        }
      }
    } catch {
      removeStored(ls);
    }
  }
  return cells;
}

export function clearCellClipboard(): void {
  cells = undefined;
  copiedAt = 0;
  const ls = storage();
  if (ls != null) removeStored(ls);
}
