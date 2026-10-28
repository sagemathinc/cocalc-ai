/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
What a board shows when its edit history could not be loaded (bounded
history plan H1b-4), from the host's boardOpen result:

- rebuilt from its saved file (state "ok", recovered): a notice, once per
  history epoch in this browser;
- not rebuilt (state "history-unloadable"), or not editable at all (the
  file missing, too large, or not a board): why, and the ways to the board's
  content that do not depend on the host: open the .board.json as text,
  download it (the project's streaming download, at any size), restore it,
  retry, and the docs page.

Every action is a link to the board's own path; the result carries no
content.
*/

import type { BoardOpenResult } from "@cocalc/conat/files/fs";
import {
  boardHistoryActions,
  boardRebuiltNotice,
  boardStateActions,
  HISTORY_UNLOADABLE_DOCS,
  type BoardHistoryAction,
} from "@cocalc/util/board/history-unloadable";
import { joinUrlPath } from "@cocalc/util/url-path";

export interface BoardHistoryLink {
  action: BoardHistoryAction;
  label: string;
  // "download": the streaming download URL
  href?: string;
  // "open-as-text": open path with the editor of this extension
  open?: { path: string; ext: string };
}

export interface BoardHistoryView {
  title: string;
  message: string;
  links: BoardHistoryLink[];
  docsHref: string;
}

const LABELS: { [action in BoardHistoryAction]: string } = {
  "open-as-text": "Open the saved file as text",
  download: "Download the file",
  restore: "Restore the file",
  retry: "Retry",
};

export function boardHistoryView({
  project_id,
  result,
  downloadHref,
  basePath,
}: {
  project_id: string;
  result: BoardOpenResult;
  // the project's download URL of a path (project/utils download_href)
  downloadHref: (project_id: string, path: string) => string;
  // the app's base path
  basePath: string;
}): BoardHistoryView | undefined {
  if (result.state == "ok") return;
  const actions =
    result.actions ??
    (result.state == "history-unloadable"
      ? boardHistoryActions(result.cause ?? "failed")
      : boardStateActions(result.state));
  const links = actions.map((action): BoardHistoryLink => {
    const link: BoardHistoryLink = { action, label: LABELS[action] };
    if (action == "download") {
      link.href = downloadHref(project_id, result.path);
    } else if (action == "open-as-text") {
      link.open = { path: result.path, ext: "json" };
    }
    return link;
  });
  return {
    title: titleOf(result),
    message: result.message ?? "",
    links,
    docsHref: joinUrlPath(
      basePath,
      "docs",
      result.docs ?? HISTORY_UNLOADABLE_DOCS,
    ),
  };
}

function titleOf(result: BoardOpenResult): string {
  switch (result.state) {
    case "missing":
      return "The board's file is missing";
    case "too-large":
      return "The board is too large to edit here";
    case "invalid":
      return "The saved file is not a board that can be edited";
    default:
      return result.cause == "reset-unknown"
        ? "The board's history may already have been rebuilt"
        : result.cause == "trash-pending"
          ? "The board's history is still being cleaned up"
          : "The board's edit history can't be loaded";
  }
}

export interface SeenStore {
  get(key: string): unknown;
  set(key: string, value: string): void;
}

// The notice of a rebuilt board, if this browser has not shown it for this
// history epoch yet; marks it shown.
export function takeRebuiltNotice({
  project_id,
  result,
  seen,
}: {
  project_id: string;
  result: BoardOpenResult;
  seen: SeenStore;
}): string | undefined {
  const recovered = result.recovered;
  if (result.state != "ok" || recovered == null) return;
  const key = `board-history-rebuilt:${project_id}:${result.path}`;
  const epoch = `${recovered.history_epoch}`;
  if (seen.get(key) === epoch) return;
  seen.set(key, epoch);
  return boardRebuiltNotice(result.path);
}
