/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
A project's edit history and logs (its persist streams), as its users manage
them: what they take, and deleting or trimming them to free space.  The
project-host does it (project-host persist-storage.ts), through the hub
(server conat/api/project-persist-storage.ts), which checks who may.
*/

// What a stream is, from where the persist server keeps it.
export type PersistStreamKind =
  // a document's edit history (TimeTravel): patchflow/<path>
  | "edit-history"
  // a chat's agent activity logs: acp-log/<path>
  | "agent-log"
  // a notebook's runtime state: jupyter/<path>
  | "notebook"
  // the project's own logs and state (e.g., its project log)
  | "project"
  | "other";

export interface PersistStreamInfo {
  // the stream's name, e.g., "patchflow/home/user/a.md"
  name: string;
  kind: PersistStreamKind;
  // the document it belongs to, e.g., "/home/user/a.md"
  document?: string;
  // whether that document still exists; undefined if that can't be told
  document_exists?: boolean;
  // on disk: the database and its write-ahead log
  bytes: number;
  // of those, free pages a compaction would give back
  reclaimable: number;
  // when it was last written (ms)
  modified: number;
}

export interface PersistStorageTotals {
  count: number;
  bytes: number;
}

export interface PersistStorageList {
  // false if the project's history is in its home (no volume of its own):
  // then its users manage those files like any others
  supported: boolean;
  // the largest first, at most the limit asked for
  streams: PersistStreamInfo[];
  // over every stream (not only those listed)
  total: PersistStorageTotals;
  by_kind: Partial<Record<PersistStreamKind, PersistStorageTotals>>;
  // there were more streams than could be looked at
  truncated?: boolean;
  // whether the account asking may delete or trim (hub)
  can_manage?: boolean;
}

export type PersistStorageAction =
  // the whole stream, e.g., the history of a deleted document
  | { op: "delete"; name: string }
  // keep what's recent: entries written before `before` (ms) and, for edit
  // history, the archived history (H1b) are removed
  | { op: "trim"; name: string; before?: number; archived?: boolean };

export interface PersistStorageActionResult {
  name: string;
  op: PersistStorageAction["op"];
  ok: boolean;
  // bytes on disk it gave back
  freed: number;
  // entries removed (trim)
  removed?: number;
  error?: string;
}

export interface PersistStorageApplyResult {
  results: PersistStorageActionResult[];
  freed: number;
}

// At most this many actions in one request (they run while the project's
// streams are closed).
export const MAX_PERSIST_STORAGE_ACTIONS = 1000;

// How long a client waits for a request to apply actions: a trim compacts the
// database, which takes a while for a large log.  (The hub gives the
// project-host a minute less, so it can answer first.)
export const PERSIST_STORAGE_APPLY_TIMEOUT_MS = 15 * 60_000;

// Applies `actions` in requests of at most MAX_PERSIST_STORAGE_ACTIONS, one
// after another, with one result for them all.
export async function applyPersistStorageInChunks(
  actions: PersistStorageAction[],
  apply: (chunk: PersistStorageAction[]) => Promise<PersistStorageApplyResult>,
): Promise<PersistStorageApplyResult> {
  const result: PersistStorageApplyResult = { results: [], freed: 0 };
  for (let i = 0; i < actions.length; i += MAX_PERSIST_STORAGE_ACTIONS) {
    const chunk = await apply(
      actions.slice(i, i + MAX_PERSIST_STORAGE_ACTIONS),
    );
    result.results.push(...chunk.results);
    result.freed += chunk.freed;
  }
  return result;
}
