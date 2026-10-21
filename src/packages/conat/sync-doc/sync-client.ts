/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EventEmitter } from "events";
import { Client as Client0 } from "@cocalc/sync/editor/generic/types";
import { parseQueryWithOptions } from "@cocalc/sync/table/util";
import { PubSub } from "@cocalc/conat/sync/pubsub";
import { type Client as ConatClient } from "@cocalc/conat/core/client";
import { type ConatSyncTable } from "@cocalc/conat/sync/synctable";
import { projectApiClient } from "@cocalc/conat/project/api";
import { base64ToBuffer } from "@cocalc/util/base64";
import callHub from "@cocalc/conat/hub/call-hub";
import { getLogger } from "@cocalc/conat/logger";
import { patchesStreamName } from "@cocalc/conat/sync/synctable-stream";
import { readFile } from "@cocalc/conat/files/read";
import { retryWhileResetBusy } from "@cocalc/conat/persist/reset-busy";
import type {
  HistoryInclusion,
  ResetHistoryOptions,
  ResetHistoryResult,
} from "@cocalc/conat/persist/storage";
import type {
  HistoryResetState,
  SavedFileRead,
} from "@cocalc/sync/editor/generic/history-restart";
import { SAVED_FILE_CHECKPOINT } from "@cocalc/sync/editor/generic/file-proof";

const logger = getLogger("conat:sync-doc:sync-client");

// The browser app registers how to tell the user something (a toast) at
// startup; other clients (projects, backends) leave it unset.
export interface SyncClientHooks {
  alert_message?: (opts: any) => void;
}

let hooks: SyncClientHooks = {};

export function setSyncClientHooks(next: SyncClientHooks): void {
  hooks = { ...hooks, ...next };
}

export class SyncClient extends EventEmitter implements Client0 {
  private client: ConatClient;
  constructor(client: ConatClient) {
    super();
    if (client == null) {
      throw Error("client must be specified");
    }
    this.client = client;
    this.client.once("closed", this.close);
  }

  close = () => {
    this.client?.removeListener("closed", this.close);
    this.emit("closed");
    // @ts-ignore
    delete this.client;
  };

  // Each document gets its own SyncClient, but the conat client outlives
  // them; stop listening to it once the document using this one closes.
  release = () => {
    this.client?.removeListener("closed", this.close);
  };

  is_project = (): boolean => false;
  is_browser = (): boolean => true;

  dbg = (_f: string) => {
    return (..._) => {};
  };

  is_connected = (): boolean => {
    return this.client.isConnected();
  };

  is_signed_in = (): boolean => {
    return this.client.isSignedIn();
  };

  private accountId = (): string | undefined => {
    const user = this.client.info?.user;
    return user?.account_id ?? user?.project_id ?? user?.hub_id;
  };

  touch_project = async (project_id): Promise<void> => {
    const client = this.client;
    const account_id = this.accountId();
    if (client == null || !client.isConnected()) {
      return;
    }
    if (!account_id) {
      return;
    }
    try {
      await callHub({
        client,
        account_id,
        name: "db.touch",
        args: [{ account_id }],
      });
    } catch (err) {
      const code = (err as any)?.code;
      const message = err instanceof Error ? err.message : `${err ?? ""}`;
      const disconnected =
        !client.isConnected() ||
        /socket has been disconnected|socket is disconnected|connection closed/i.test(
          message,
        );
      if (!disconnected && code != 503) {
        // 503 when hub not running yet
        logger.warn("issue touching account activity", {
          project_id,
          account_id,
          err,
        });
      }
    }
  };

  is_deleted = (_filename: string, _project_id?: string): boolean => {
    return false;
  };

  set_deleted = (_filename: string, _project_id?: string): void => {};

  synctable_conat = async (query0, options?): Promise<ConatSyncTable> => {
    const { query } = parseQueryWithOptions(query0, options);
    return await this.client.sync.synctable({
      ...options,
      query,
    });
  };

  pubsub_conat = async (opts): Promise<PubSub> => {
    const channel = new PubSub({ client: this.client, ...opts });
    // A denied subscription is a failed open (the channel closes itself),
    // not a channel that looks open and later goes dead.
    await channel.ready;
    return channel;
  };

  // account_id or project_id for this signed-in conat client.
  client_id = (): string => {
    return this.accountId() ?? this.client.id;
  };

  raw_client_id = (): string => {
    return this.client.id;
  };

  server_time = (): Date => {
    return new Date();
  };

  // The document's history holds the patch oversized_seq, too large to load
  // (413), so it cannot be opened: reset its history through the patch stream
  // this client already writes to, keeping the old history aside.  The persist
  // server only resets if that patch is still there, all in one transaction.
  resetOversizedHistory = async ({
    project_id,
    path,
    oversized_seq,
    persist,
  }: {
    project_id: string;
    path: string;
    oversized_seq: number;
    // The route the document's patches are written by (a board's: the
    // board write service, as the hub).
    persist?: { service: string; persistUser: Record<string, never> };
  }): Promise<{ history_epoch: number; reset: boolean }> => {
    const stream = this.client.sync.astream({
      project_id,
      name: patchesStreamName({ path }),
      noInventory: true,
      ...(persist ?? {}),
    });
    try {
      // while another reset of this history is in progress, wait for it
      const { history_epoch, reset } = await retryWhileResetBusy(() =>
        stream.resetHistory({
          ifOversizedSeq: oversized_seq,
          archive: true,
          settings: {
            history_purged_at: Date.now(),
            history_purged_by: this.accountId() ?? null,
          },
        }),
      );
      return { history_epoch, reset };
    } finally {
      stream.close();
    }
  };

  // see Client.historyResetState
  historyResetState = async ({
    project_id,
    path,
    persist,
  }: {
    project_id: string;
    path: string;
    persist?: { service: string; persistUser: Record<string, never> };
  }): Promise<HistoryResetState> => {
    const stream = this.client.sync.astream({
      project_id,
      name: patchesStreamName({ path }),
      noInventory: true,
      ...(persist ?? {}),
    });
    try {
      const [inventory, checkpoints, metadata] = await Promise.all([
        stream.inventory(),
        stream.getCheckpoints(),
        stream.getMetadata(),
      ]);
      const epoch = (metadata as any)?.settings?.history_epoch;
      const reset = (metadata as any)?.settings?.history_reset;
      return {
        seq: inventory.seq,
        count: inventory.count,
        epoch: typeof epoch === "number" && Number.isFinite(epoch) ? epoch : 0,
        proof: checkpoints?.[SAVED_FILE_CHECKPOINT],
        // what the last reset recorded (its reason), from the persist
        // server's metadata
        ...(reset != null && typeof reset === "object"
          ? {
              reset: {
                reason:
                  typeof reset.reason === "string" ? reset.reason : undefined,
                time: typeof reset.time === "number" ? reset.time : undefined,
              },
            }
          : {}),
      };
    } finally {
      stream.close();
    }
  };

  // see Client.readFileBounded: the project's read stream, asked for at most
  // maxBytes + 1 bytes, so a larger file is detected without reading it
  readFileBounded = async ({
    project_id,
    path,
    maxBytes,
  }: {
    project_id: string;
    path: string;
    maxBytes: number;
  }): Promise<SavedFileRead> => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for await (const chunk of readFile({
        client: this.client,
        project_id,
        path,
        start: 0,
        end: maxBytes,
      })) {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          return { status: "too-large" };
        }
        chunks.push(chunk);
      }
    } catch (err) {
      if ((err as any)?.code == "ENOENT") {
        return { status: "missing" };
      }
      return { status: "unavailable", error: `${err}` };
    }
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    return { status: "ok", data };
  };

  // see Client.historyInclusion
  historyInclusion = async ({
    project_id,
    path,
    persist,
    epoch,
    ids,
  }: {
    project_id: string;
    path: string;
    persist?: { service: string; persistUser: Record<string, never> };
    epoch: number;
    ids: string[];
  }): Promise<HistoryInclusion> => {
    const stream = this.client.sync.astream({
      project_id,
      name: patchesStreamName({ path }),
      noInventory: true,
      ...(persist ?? {}),
    });
    try {
      return await stream.historyInclusion({ epoch, ids });
    } finally {
      stream.close();
    }
  };

  // see Client.resetHistory
  resetHistory = async ({
    project_id,
    path,
    persist,
    options,
    busyAttempts,
  }: {
    project_id: string;
    path: string;
    persist?: { service: string; persistUser: Record<string, never> };
    options: ResetHistoryOptions;
    // how many times to ask while another reset of this history is in
    // progress (default: about the server's old 30 s wait); a caller with its
    // own deadline passes fewer
    busyAttempts?: number;
  }): Promise<ResetHistoryResult> => {
    const stream = this.client.sync.astream({
      project_id,
      name: patchesStreamName({ path }),
      noInventory: true,
      ...(persist ?? {}),
    });
    try {
      // while another reset of this history is in progress, wait for it
      return await retryWhileResetBusy(() => stream.resetHistory(options), {
        attempts: busyAttempts,
      });
    } finally {
      stream.close();
    }
  };

  ipywidgetsGetBuffer = async ({
    project_id,
    path,
    model_id,
    buffer_path,
  }: {
    project_id: string;
    path: string;
    model_id: string;
    buffer_path: string;
  }): Promise<ArrayBuffer> => {
    const api = projectApiClient({ project_id, client: this.client });
    const { buffer64 } = await api.jupyter.ipywidgetsGetBuffer({
      path,
      model_id,
      buffer_path,
    });
    return base64ToBuffer(buffer64);
  };

  /////////////////////////////////
  // EVERYTHING BELOW: TO REMOVE?
  mark_file = (_): void => {};

  alert_message = (opts): void => {
    hooks.alert_message?.(opts);
  };

  sage_session = (_): void => {};

  shell = (_): void => {};

  path_access = (opts): void => {
    opts.cb(true);
  };
  path_stat = (opts): void => {
    console.log("path_state", opts.path);
    opts.cb(true);
  };

  async path_read(opts): Promise<void> {
    opts.cb(true);
  }
  async write_file(opts): Promise<void> {
    opts.cb(true);
  }
  watch_file(_): any {}

  log_error = (_): void => {};

  query = (_): void => {
    throw Error("not implemented");
  };
  query_cancel = (_): void => {};
}
