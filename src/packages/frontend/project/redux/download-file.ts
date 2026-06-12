/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { alert_message } from "@cocalc/frontend/alerts";
import { download_href, url_href } from "@cocalc/frontend/project/utils";

interface DownloadProjectFileOptions {
  project_id: string;
  path: string;
  log?: boolean | string[];
  auto?: boolean;
  print?: boolean;
  showError?: boolean;
  deleteAfterDownload?: boolean;
  downloadFilename?: string;
  logAction: (opts: {
    event: "file_action";
    action: "downloaded";
    files: string[];
  }) => void;
  routeProjectHostHttpUrl: (opts: {
    project_id: string;
    url: string;
  }) => Promise<string>;
  ensureProjectHostBrowserSessionForProject: (opts: {
    project_id: string;
  }) => Promise<void>;
  downloadFile: (
    url: string,
    opts: { onAuthFailure: () => Promise<string> },
  ) => Promise<void>;
  openNewTab: (url: string) => Window | null | undefined;
}

export async function downloadProjectFile({
  project_id,
  path,
  log = false,
  auto = true,
  print = false,
  showError = true,
  deleteAfterDownload,
  downloadFilename,
  logAction,
  routeProjectHostHttpUrl,
  ensureProjectHostBrowserSessionForProject,
  downloadFile,
  openNewTab,
}: DownloadProjectFileOptions): Promise<void> {
  // log could also be an array of strings to record all the files that were downloaded in a zip file
  if (log) {
    const files = Array.isArray(log) ? log : [path];
    logAction({
      event: "file_action",
      action: "downloaded",
      files,
    });
  }

  if (auto && !print) {
    const hubUrl = download_href(project_id, path, {
      deleteAfterDownload,
      downloadFilename,
    });
    const url = await routeProjectHostHttpUrl({
      project_id,
      url: hubUrl,
    });
    try {
      await downloadFile(url, {
        onAuthFailure: async () => {
          await ensureProjectHostBrowserSessionForProject({
            project_id,
          });
          return await routeProjectHostHttpUrl({
            project_id,
            url: hubUrl,
          });
        },
      });
    } catch (err) {
      if (showError) {
        alert_message({
          type: "error",
          title: "Download blocked",
          message: err,
          timeout: 15,
        });
        return;
      }
      throw err;
    }
  } else {
    const url = url_href(project_id, path);
    const tab = openNewTab(url);
    if (tab != null && print) {
      // "?" since there might be no print method -- could depend on browser API
      tab.print?.();
    }
  }
}
