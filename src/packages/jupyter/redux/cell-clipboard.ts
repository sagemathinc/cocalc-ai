/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The clipboard for copied notebook cells (Copy Cells / Paste Cells).

There is one clipboard for all notebooks, so cells can be copied between
notebooks. In a browser it is shared between tabs and windows through
localStorage, which holds a single record describing the latest clipboard
event of any tab:

- a copy: its cells, its revision and the account that copied them;
- a tombstone (no cells): the clipboard was cleared, or the latest copy was
  too large to share, so no other tab may paste an older copy.

Every copy or clear writes a new record with a unique revision (time and
nonce). A tab keeps its own latest copy in memory and pastes it only while
that copy is still the latest record; otherwise it reads the record on each
paste and never keeps another tab's cells. Since the record can hold notebook
content on a shared computer, it is only pasted by the account that copied
it, expires after a day, and is cleared when the session ends.
*/

import { fromJS, type List } from "immutable";

const STORAGE_KEY = "cocalc-jupyter-cell-clipboard";
export const CELL_CLIPBOARD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// localStorage typically allows about 5 MB per site.
export const CELL_CLIPBOARD_MAX_STORED_CHARS = 2_000_000;

interface Revision {
  time: number;
  nonce: string;
}

interface StoredRecord extends Revision {
  account?: string;
  cells?: unknown[]; // absent in a tombstone
}

let local: (Revision & { cells: List<any> }) | undefined = undefined;
let account: string | undefined = undefined;

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

function newRevision(now: number): Revision {
  const nonce =
    globalThis.crypto?.randomUUID?.() ??
    `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  return { time: now, nonce };
}

function write(ls: Storage, record: StoredRecord): boolean {
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

function read(ls: Storage): StoredRecord | undefined | null {
  // undefined: nothing was ever shared; null: unreadable
  try {
    const raw = ls.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const record = JSON.parse(raw);
    if (
      !Number.isFinite(record?.time) ||
      typeof record?.nonce !== "string" ||
      (record.cells != null && !Array.isArray(record.cells))
    ) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

function isLocal(record: Revision): boolean {
  return (
    local != null && record.time === local.time && record.nonce === local.nonce
  );
}

// The account whose copies this tab may paste. Changing it forgets this
// tab's own copy.
export function setCellClipboardAccount(account_id?: string): void {
  const next = account_id || undefined;
  if (next !== account) {
    account = next;
    local = undefined;
  }
}

export function setCellClipboard(
  clipboard: List<any>,
  now: number = Date.now(),
): void {
  const revision = newRevision(now);
  local = { ...revision, cells: clipboard };
  const ls = storage();
  if (ls == null) return;
  let value: string | undefined = undefined;
  try {
    value = JSON.stringify({ ...revision, account, cells: clipboard.toJS() });
  } catch {}
  if (value != null && value.length <= CELL_CLIPBOARD_MAX_STORED_CHARS) {
    try {
      ls.setItem(STORAGE_KEY, value);
      return;
    } catch {}
  }
  // Too large to share (or storage is full): this tab keeps its copy, and the
  // tombstone stops other tabs from pasting an older one.
  write(ls, revision);
}

// The latest copied cells this tab may paste, if any.
export function getCellClipboard(
  now: number = Date.now(),
): List<any> | undefined {
  if (local != null && now - local.time > CELL_CLIPBOARD_MAX_AGE_MS) {
    local = undefined;
  }
  const ls = storage();
  if (ls == null) return local?.cells;
  const record = read(ls);
  if (record === undefined) return local?.cells;
  if (record === null) return undefined;
  if (isLocal(record)) return local?.cells;
  if (
    record.cells == null ||
    now - record.time > CELL_CLIPBOARD_MAX_AGE_MS ||
    record.account !== account
  ) {
    return undefined;
  }
  return fromJS(record.cells) as List<any>;
}

// Forget copied cells in this tab and, through a tombstone, in all others.
export function clearCellClipboard(now: number = Date.now()): void {
  local = undefined;
  const ls = storage();
  if (ls != null) write(ls, newRevision(now));
}
