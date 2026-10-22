/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
 * license
 */

// A Patch is an entry in the patches table, as represented in memory locally here.

import type {
  HistoryInclusion,
  ResetHistoryOptions,
  ResetHistoryResult,
} from "@cocalc/conat/persist/storage";
import type { HistoryResetState, SavedFileRead } from "./history-restart";
import { SyncTable } from "@cocalc/sync/table/synctable";
import { type CompressedPatch } from "@cocalc/util/dmp";
export { type CompressedPatch };
import type { Document as PFDocument } from "patchflow";
import type { ExecuteCodeOptionsWithCallback } from "@cocalc/util/types/execute-code";
import type {
  CallConatServiceFunction,
  CreateConatServiceFunction,
} from "@cocalc/conat/service";
import type { JSONValue } from "@cocalc/util/types";

export interface Patch {
  // time = PatchId (opaque logical id) of when patch was made.
  // Historically this was a number (ms since epoch-ish). In patchflow@0.5.0+ it is a
  // string of the form "<time36>_<client>", where time36 is a fixed-width base36
  // timestamp prefix (lex-sortable) and client is a per-session random suffix to
  // avoid collisions when the same user commits concurrently from multiple clients.
  time: PatchId;
  // wall = wallclock time of when patch made; plays no role at all in the algorithm and
  // is purely to **display to the user**.  For backward compat and display, if wall is
  // not defined in then this should fall back to the time field.
  wall?: number;
  patch?: CompressedPatch /* compressed format patch -- an array/object (not JSON string) */;
  user_id: number /* 0-based integer "id" of user
                     syncstring table has id-->account_id map) */;
  size: number; // size of the patch (by defn length of string representation)

  // Hash of the document value right after this patch, as its author
  // computed it (patchflow's Patch.hash); every client checks its own value
  // against it. A snapshot carries the hash of the patch it is of.
  hash?: string;

  // A merge commit (several parents) records the merged value of its parents,
  // as its author computed it: merge_patch applied to the value of
  // merge_parent, one of the parents (patchflow's Patch.mergeParent and
  // Patch.mergePatch). Then its value never depends on how a later version
  // merges.
  merge_parent?: PatchId;
  merge_patch?: CompressedPatch;

  // Committed without the exact value of its parents (patchflow's
  // Patch.inexact): such a patch has no hash, and a merge commit marked this
  // way is read with merge3 rather than as a history written by patchflow 0.8.
  inexact?: boolean;

  is_snapshot?: boolean;
  snapshot?: string; // to_str() applied to the document at this point in time
  seq_info?: {
    // seq = sequence number of the message with the patch/timestamp of the snapshot.
    // Load with start_seq = seq to get all patch info back to this snapshot.
    seq: number;
    // prev_seq = sequence numbrer of *previous* snapshot patch.
    // Load with start_seq = prev_seq to get all info about timetravel
    // back to previous snapshot.  That previous snapshot will itself
    // have a prev_seq, etc., making it possible to incremental load
    // patches back in time.
    prev_seq?: number;
    // The snapshotted patch was a clean cut for its writer: every patch the
    // writer had loaded was an ancestor or a descendant of it. A client that
    // loads from such a snapshot can ignore older snapshot records (see
    // isSnapshotRecordBeforeLoadedRange in sync-doc.ts).
    cut?: boolean;
  };

  // The set of all patches forms a directed acyclic graph.
  // There is an edge from the patch to its parents, which were all source
  // vertices that were *known* when the patch was made.
  // Right now, creating a new patch always
  // involves merging all parents known to this client.  However, that's not
  // required by this data structure: instead parents could just be the branches
  // that we are merging.  I.e., we might only add something when
  // the user wants to manually do a merge.  That's for later...
  parents?: PatchId[];

  version?: number;

  // if true, this patch puts the document into a state where it
  // just read the file from disk.
  file?: boolean;

  // metadata
  meta?: { [key: string]: JSONValue };
}

export interface Document extends PFDocument {
  applyPatch(patch: any): Document;
  applyPatchBatch(patches: any[]): Document;
  makePatch(doc: any): any;
  isEqual(doc?: any): boolean;
  set(value: any): Document;
  get(key?: any): any;
  delete(key?: any): Document;
  changes?(prev?: any): any;
  count(): number;
  apply_patch(patch: any): Document;
  apply_patch_batch(patches: any[]): Document;
  make_patch(doc: any): any;
  is_equal(doc?: any): boolean;
  to_str(): string;
  get_one?(query?: any): any;
}

export interface FileWatcher {
  on: (event: string, handler: Function) => void;
  close: () => void;
}

/* This is what we need from the "client".
There's actually a completely separate client
that runs in the browser and one on the project,
but anything that has the following interface
might work... */
import { EventEmitter } from "events";

export interface ProjectClient extends EventEmitter {
  server_time: () => Date;
  is_project: () => boolean;
  is_browser: () => boolean;
  is_connected: () => boolean;
  is_signed_in: () => boolean;
  dbg: (desc: string) => Function;
  alert_message?: (opts: any) => void;

  query: (opts: { query: any; cb: Function }) => void;

  // Only required to work on project client.
  path_access: (opts: { path: string; mode: string; cb: Function }) => void;

  path_exists?: (opts: { path: string; cb: Function }) => void;

  path_stat: (opts: { path: string; cb: Function }) => void;

  path_read: (opts: {
    path: string;
    maxsize_MB?: number;
    cb: Function;
  }) => Promise<void>;

  write_file: (opts: {
    path: string;
    data: string;
    cb: Function;
  }) => Promise<void>;

  watch_file: (opts: { path: string }) => FileWatcher;

  synctable_ephemeral?: (
    project_id: string,
    query: any,
    options: any,
    throttle_changes?: number,
    id?: string,
  ) => Promise<SyncTable>;

  synctable_conat: (query: any, obj?) => Promise<any>;
  pubsub_conat: (query: any, obj?) => Promise<any>;
  callConatService?: CallConatServiceFunction;
  createConatService?: CreateConatServiceFunction;

  // account_id or project_id (encoded as a UUID - use decodeUUIDtoNum to decode)
  client_id: () => string;
  raw_client_id?: () => string | undefined;

  is_deleted: (
    filename: string,
    project_id?: string,
  ) => boolean | undefined | null;
  set_deleted: (filename: string, project_id?: string) => void;
}

export interface Client extends ProjectClient {
  log_error?: (opts: {
    project_id: string;
    path: string;
    string_id: string;
    error: any;
  }) => void;

  mark_file?: (opts: {
    project_id: string;
    path: string;
    action: string;
    ttl: number;
  }) => void;

  shell: (opts: ExecuteCodeOptionsWithCallback) => void;

  sage_session: (opts: { path: string }) => any;

  touch_project?: (path: string) => void;

  ipywidgetsGetBuffer?: (opts: {
    project_id: string;
    path: string;
    model_id: string;
    buffer_path: string | string[];
  }) => Promise<ArrayBuffer>;

  // Reset a document's edit history because it holds the patch oversized_seq,
  // which is too large to load, keeping the old history aside.  Only resets
  // if that patch is still there.  Used by SyncDoc when it cannot open.
  resetOversizedHistory?: (opts: {
    project_id: string;
    path: string;
    oversized_seq: number;
    // How the document's patches are written (SyncDoc's patchesPersist): a
    // board's go through the board write service, and so must its reset.
    persist?: { service: string; persistUser: Record<string, never> };
  }) => Promise<{ history_epoch: number; reset: boolean }>;

  // What restarting a history from its saved file judges: the history's
  // newest seq, message count and epoch, and the saved file proof.
  historyResetState?: (opts: {
    project_id: string;
    path: string;
    persist?: { service: string; persistUser: Record<string, never> };
  }) => Promise<HistoryResetState>;

  // Read at most maxBytes of a file in the project; never more.
  readFileBounded?: (opts: {
    project_id: string;
    path: string;
    maxBytes: number;
  }) => Promise<SavedFileRead>;

  // Which of these msg ids the server accepted in history epoch `epoch`, and
  // whether the current history includes them (PersistentStream.
  // historyInclusion).
  historyInclusion?: (opts: {
    project_id: string;
    path: string;
    persist?: { service: string; persistUser: Record<string, never> };
    epoch: number;
    ids: string[];
  }) => Promise<HistoryInclusion>;

  // The seeded, conditional reset of a document's history (see
  // PersistentStream.resetHistory).
  resetHistory?: (opts: {
    project_id: string;
    path: string;
    persist?: { service: string; persistUser: Record<string, never> };
    options: ResetHistoryOptions;
    busyAttempts?: number;
  }) => Promise<ResetHistoryResult>;

  // Ask the project's live writer of this document (a notebook's backend) to
  // seed a new history from its live value (bounded history plan H1b-3,
  // option A).  Answers {seeded: false, reason} rather than throwing for any
  // refusal; a timeout or error means "no answer".
  askLiveWriterToSeed?: (opts: {
    project_id: string;
    path: string;
    epoch: number;
    oversizedSeq: number;
  }) => Promise<LiveSeedResult>;
}

export type LiveSeedRefusal =
  | "not-running"
  | "not-ready"
  | "epoch"
  | "not-caught-up"
  | "busy"
  | "too-large"
  | "moved"
  | "deadline"
  | "invalid"
  | "failed";

export type LiveSeedResult =
  | { seeded: true; history_epoch: number; repeated?: boolean }
  | { seeded: false; reason: LiveSeedRefusal; message?: string };

export interface DocType {
  type: string;
  patch_format?: number; // 0=string or 1=dbdoc, if given
  opts?: { [key: string]: any };
}
// Opaque logical patch identifier (PatchFlow-style "<time36>_<client>" string).
export type PatchId = string;
