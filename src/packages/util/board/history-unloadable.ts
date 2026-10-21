/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A board whose edit history cannot be loaded (bounded history plan H1b-4):
// its host rebuilds the history from the saved .board.json, or answers why
// not, with a way to the board's content that does not depend on the
// rebuild.  Shared by the host (project-host/board) and the browser.

export const BOARD_FILE_RESET_REASON = "board-file";

// The docs page for every document whose history cannot be loaded.
export const HISTORY_UNLOADABLE_DOCS = "files/history-unloadable";

export type BoardHistoryCause =
  // the file, or what it becomes as records, is over the host's limits
  | "file-too-large"
  // the file is not JSON, or not a board
  | "file-invalid"
  | "file-missing"
  // a rebuild of this board is already running
  | "busy"
  // the rebuild did not finish in time; nothing was reset
  | "deadline"
  | "failed"
  // a reset was sent, and whether it applied is not known yet
  | "reset-unknown";

// What the user can do.  Links to the board's own path, never content:
// - "open-as-text": open the .board.json in the JSON (text) editor;
// - "download": the project's streaming download of the .board.json, at
//   any size;
// - "restore": bring the file back (snapshots, TimeTravel), then retry;
// - "retry": open the board again.
export type BoardHistoryAction =
  | "open-as-text"
  | "download"
  | "restore"
  | "retry";

export function boardHistoryActions(
  cause: BoardHistoryCause,
): BoardHistoryAction[] {
  switch (cause) {
    case "busy":
      return ["retry"];
    case "file-missing":
      return ["restore", "retry"];
    case "file-too-large":
    case "file-invalid":
    case "deadline":
    case "failed":
    case "reset-unknown":
      return ["open-as-text", "download", "retry"];
  }
}

// What the board shows once after its history was rebuilt.
export function boardRebuiltNotice(path: string): string {
  return `The edit history of ${path} could not be loaded. It was archived, and the board was rebuilt from its saved file; edits not yet saved to the file may be missing.`;
}
