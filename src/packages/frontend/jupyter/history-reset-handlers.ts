/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
What a notebook tab does when its edit history is reset or cannot be loaded
(bounded history plan H1b-3, §3 and §4; H1b-2 for the hand-off).

- history-unloadable (restart: "ipynb"): the history holds an entry too large
  to load.  Nothing is reset automatically.  The user may confirm restarting
  the history from the saved notebook (option B), which the project does as
  one seeded reset conditional on exactly the history state the user saw.
  If that state changed meanwhile, the user is asked again; nothing is ever
  retried silently.
- history-reset: the history was reset (by this tab, another, or the project)
  and everything this tab had is in the new history or in recovery copies:
  reopen the notebook.
- history-reset-unsaved: this tab's edits could not be saved anywhere (NOT
  SAVED): offer a download.
*/

import { alert_message } from "@cocalc/frontend/alerts";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { syncdbPath } from "@cocalc/util/jupyter/names";
import { path_split } from "@cocalc/util/misc";

interface NotebookTab {
  project_id: string;
  path: string; // the .ipynb
  syncdb: any;
  redux: any;
  isClosed: () => boolean;
}

export function attachHistoryResetHandlers(tab: NotebookTab): void {
  const { syncdb } = tab;
  syncdb.on("history-unloadable", ({ restart }: { restart?: string } = {}) => {
    if (restart == "ipynb") {
      void confirmRestartFromIpynb(tab);
    } else {
      alert_message({
        type: "error",
        title: "The edit history cannot be loaded",
        message: `The edit history of ${tab.path} contains an entry too large to load.`,
        block: true,
      });
    }
  });
  syncdb.on("history-reset", ({ copies }: { copies?: string[] } = {}) => {
    alert_message({
      type: copies?.length ? "warning" : "info",
      title: "Edit history was reset",
      message: copies?.length
        ? `The edit history of ${tab.path} was reset, which removed edits made in this tab. They are saved in ${copies.join(", ")}. The notebook is opening again; its kernel was restarted.`
        : `The edit history of ${tab.path} was reset; the notebook is opening again and its kernel was restarted.`,
      block: !!copies?.length,
    });
    reopen(tab);
  });
  syncdb.on("history-reset-unsaved", ({ reason }: { reason?: string } = {}) => {
    void handleUnsaved(tab, reason);
  });
}

function reopen(tab: NotebookTab) {
  const projectActions = tab.redux?.getProjectActions?.(tab.project_id);
  if (projectActions == null) return;
  projectActions.close_file?.(tab.path);
  setTimeout(() => {
    projectActions.open_file?.({ path: tab.path, foreground: true });
  }, 0);
}

function closeTab(tab: NotebookTab) {
  tab.redux?.getProjectActions?.(tab.project_id)?.close_file?.(tab.path);
}

// The history state the user is asked about: what the restart is bound to.
async function historyState(tab: NotebookTab) {
  return await tab.syncdb.client.historyResetState({
    project_id: tab.project_id,
    path: syncdbPath(tab.path),
  });
}

const asking = new Set<string>();

export async function confirmRestartFromIpynb(tab: NotebookTab): Promise<void> {
  const key = `${tab.project_id}/${tab.path}`;
  if (asking.has(key)) return;
  asking.add(key);
  try {
    const page = tab.redux.getActions("page");
    // Asked again, never retried silently, when the history moved meanwhile.
    for (;;) {
      if (tab.isClosed()) return;
      let state;
      try {
        state = await historyState(tab);
      } catch (err) {
        alert_message({
          type: "error",
          title: "The edit history cannot be loaded",
          message: `${tab.path}: ${err}`,
        });
        return;
      }
      const restart = await page.popconfirm({
        title: `The edit history of ${tab.path} cannot be loaded`,
        description:
          "Its edit history (TimeTravel) contains an entry too large to load, most likely a huge output. You can restart the edit history from the saved notebook (.ipynb), or close the notebook and download the .ipynb from the file explorer first.",
        okText: "Restart history from the saved notebook…",
        cancelText: "Close the notebook",
      });
      if (!restart) {
        closeTab(tab);
        return;
      }
      const confirmed = await page.popconfirm({
        title: "Restart the edit history from the saved notebook?",
        description:
          "Edits made since the notebook was last saved are removed from the notebook. They are moved to the archived history, which is limited in size, so some of them may not be recoverable. The running kernel restarts: its variables, and anything it is running, are lost.",
        okText: "Restart history",
        cancelText: "Cancel and close the notebook",
      });
      if (!confirmed) {
        closeTab(tab);
        return;
      }
      if (tab.isClosed()) return;
      // A timeout earlier may have an unknown outcome: if the history was
      // reset meanwhile (another tab, or the project), there is nothing to do.
      const now = await historyState(tab);
      if (now.epoch != state.epoch) {
        alert_message({
          type: "info",
          title: "The edit history was already restarted",
          message: `${tab.path} is opening with its new edit history.`,
        });
        return;
      }
      if (now.seq != state.seq || now.count != state.count) {
        alert_message({
          type: "warning",
          title: "The notebook changed",
          message:
            "Edits arrived after you were asked; please confirm the restart again.",
        });
        continue;
      }
      const api = webapp_client.project_client.conatApi(tab.project_id);
      let result;
      try {
        result = await api.jupyter.restartHistoryFromIpynb({
          path: tab.path,
          epoch: state.epoch,
          revision: { seq: state.seq, count: state.count },
        });
      } catch (err) {
        alert_message({
          type: "error",
          title: "The edit history was not restarted",
          message: `The project could not restart it (is the project running?): ${err}`,
        });
        return;
      }
      if (result.restarted) {
        alert_message({
          type: "info",
          title: "Edit history restarted",
          message: `The edit history of ${tab.path} was restarted from the saved notebook, which is opening now. Newer edits were moved to the archived history. The kernel was restarted.`,
          block: true,
        });
        return;
      }
      if (result.reason == "moved") {
        alert_message({
          type: "warning",
          title: "The notebook changed",
          message:
            "Edits arrived after you confirmed; please confirm the restart again.",
        });
        continue;
      }
      if (result.reason == "epoch") {
        alert_message({
          type: "info",
          title: "The edit history was already restarted",
          message: `${tab.path} is opening with its new edit history.`,
        });
        return;
      }
      alert_message({
        type: "error",
        title: "The edit history was not restarted",
        message:
          result.reason == "busy"
            ? "A restart of this notebook's history is already in progress; try again in a moment."
            : result.reason == "trash-pending"
              ? "An earlier restart of this notebook's history is still being cleaned up; try again in a minute. Meanwhile you can download the .ipynb from the file explorer (see /docs/files/history-unloadable)."
              : result.reason == "too-large"
                ? `The saved notebook is too large to restart from${result.message ? ` (${result.message})` : ""}.`
                : `${result.reason}${result.message ? `: ${result.message}` : ""}`,
      });
      return;
    }
  } finally {
    asking.delete(key);
  }
}

async function handleUnsaved(tab: NotebookTab, reason?: string) {
  const page = tab.redux.getActions("page");
  const download = await page.popconfirm({
    title: `NOT SAVED: edits to ${tab.path}`,
    description: `The edit history of ${tab.path} was reset in another session, and edits made in this tab could not be saved to a recovery copy (${reason ?? "unknown"}). Download them before reloading, or try again.`,
    okText: "Download a copy",
    cancelText: "Try again",
  });
  if (tab.isClosed()) return;
  if (!download) {
    tab.syncdb.retryHistoryTransition?.();
    return;
  }
  const { value, generation } = tab.syncdb.valueForDownload();
  const url = URL.createObjectURL(new Blob([value], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${path_split(tab.path).tail}.unsaved.jsonl`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  const reload = await page.popconfirm({
    title: `Reload ${tab.path}?`,
    description:
      "Reload only after the download has finished. Edits made here after the download are not in it; then the notebook stays open and nothing is reloaded.",
    okText: "Reload",
    cancelText: "Keep this tab",
  });
  if (tab.isClosed()) return;
  if (!reload || !tab.syncdb.reloadAfterDownload(generation)) {
    tab.syncdb.retryHistoryTransition?.();
  }
}
