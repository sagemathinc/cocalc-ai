/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Sagebrush boards (.board.json): the file is the only representation on
// disk, canonical pretty JSON. While a board is open, its live document is a
// syncdb of the board's records, kept on an auxiliary path (as a notebook's
// is), whose history lives in the database and is never written to disk.

import { meta_file, original_path } from "@cocalc/util/misc";

export const BOARD_JSON_EXTENSION = ".board.json";
// meta_file's postfix: a.board.json -> .a.board.json.sage-board
export const BOARD_SYNCDB_POSTFIX = "board";
export const BOARD_SYNCDB_EXTENSION = `sage-${BOARD_SYNCDB_POSTFIX}`;

// The records of a board (Sagebrush's web/board/history.ts SCHEMA): keyed
// by type, page and id; the text fields merge character by character.
export const BOARD_PRIMARY_KEYS = ["type", "page", "id"];
export const BOARD_STRING_COLS = [
  "title",
  "text",
  "code",
  "detail",
  "label",
  "intro",
];

// A board larger than this is not edited in a card (Sagebrush's
// board-host protocol): it is shown read-only.
export const BOARD_EDITABLE_LIMIT = 8 * 1024 * 1024;
// Nor is a board with more records than this (the same protocol).
export const BOARD_RECORD_LIMIT = 100_000;
// What a project host edits for now: patchflow 0.13 applies a patch of n
// new records in O(n^2), and one commit of a board this size takes about
// 170 ms (measured Oct 19 2026; 1,500 records take 300 ms). A board with
// more records opens read-only. Raise to BOARD_RECORD_LIMIT once a
// patchflow with linear patch application is pinned.
export const BOARD_HOST_RECORD_LIMIT = 1_000;

export function isBoardJsonPath(path: string): boolean {
  return `${path ?? ""}`.toLowerCase().endsWith(BOARD_JSON_EXTENSION);
}

export function isBoardSyncdbPath(path: string): boolean {
  return `${path ?? ""}`.endsWith(`.${BOARD_SYNCDB_EXTENSION}`);
}

// a.board.json or .a.board.json.sage-board -> .a.board.json.sage-board
export function boardSyncdbPath(path: string): string {
  if (isBoardSyncdbPath(path)) return path;
  if (!isBoardJsonPath(path)) {
    throw Error(`must end with ${BOARD_JSON_EXTENSION} but it is "${path}"`);
  }
  return meta_file(path, BOARD_SYNCDB_POSTFIX);
}

// a.board.json or .a.board.json.sage-board -> a.board.json
export function boardJsonPath(path: string): string {
  if (isBoardJsonPath(path)) return path;
  return original_path(path);
}
