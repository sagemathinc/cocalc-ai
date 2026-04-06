/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { redux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "../webapp-client";
import * as misc from "@cocalc/util/misc";
import { Actions } from "../app-framework";
import { isChatPath } from "@cocalc/frontend/chat/paths";
import { publishDocumentPresence } from "@cocalc/frontend/document-presence/service";

const DEFAULT_CHAT_TTL_S = 5;
const DEFAULT_FILE_TTL_S = 45;

export class FileUseActions extends Actions<any> {
  private mark_file_lock: { [key: string]: Date | true } = {};

  _init() {}

  async mark_file(
    project_id: string,
    path: string,
    action: string,
    ttl: number | "default" = "default",
    fix_path: boolean = true,
    timestamp: Date | undefined = undefined,
    force: boolean = false,
  ): Promise<void> {
    if (
      !force &&
      !isChatPath(path) &&
      !redux.getProjectStore(project_id)?.getIn(["open_files", path])
    ) {
      return;
    }
    if (fix_path) {
      path = misc.original_path(path);
    }
    const account_id = this.redux.getStore("account")?.get_account_id?.();
    if (account_id == null) {
      return;
    }
    const project_map = this.redux.getStore("projects")?.get("project_map");
    if (!project_map?.has?.(project_id)) {
      return;
    }
    const ts =
      timestamp == null ? webapp_client.server_time() : new Date(timestamp);
    if (ttl) {
      if (ttl === "default") {
        ttl =
          action.slice(0, 4) === "chat"
            ? DEFAULT_CHAT_TTL_S * 1000
            : DEFAULT_FILE_TTL_S * 1000;
      }
      const key = `${project_id}-${path}-${action}`;
      if (this.mark_file_lock[key] && ts != null) {
        this.mark_file_lock[key] = ts;
        return;
      }
      this.mark_file_lock[key] = true;
      setTimeout(() => {
        const deferredTs = this.mark_file_lock[key];
        if (deferredTs && deferredTs !== true) {
          void this.do_mark_file(
            account_id,
            action,
            project_id,
            path,
            deferredTs,
          );
        }
        delete this.mark_file_lock[key];
      }, ttl);
    }
    await this.do_mark_file(account_id, action, project_id, path, ts);
  }

  private async do_mark_file(
    account_id: string,
    action: string,
    project_id: string,
    path: string,
    timestamp: Date,
  ): Promise<void> {
    const ts = timestamp.valueOf();
    if (action === "edit") {
      publishDocumentPresence({
        account_id,
        project_id,
        path,
        mode: "edit",
        ts,
      });
    } else if (action === "open" || action === "chat") {
      publishDocumentPresence({
        account_id,
        project_id,
        path,
        mode: "open",
        ts,
      });
    }
    if (action !== "open" && action !== "edit" && action !== "chat") {
      return;
    }
    await Promise.all([
      webapp_client.conat_client.hub.db.touch({
        project_id,
      }),
      (webapp_client.conat_client.hub.db as any).logFileAccess({
        project_id,
        path,
      }),
    ]);
  }
}
