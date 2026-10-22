/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
SyncDoc -- the core class for editing with a synchronized document.

This code supports both string-doc and db-doc, for editing both
strings and small database tables efficiently, with history,
undo, save to disk, etc.

This code is run *both* in browser clients and under node.js
in projects, and behaves slightly differently in each case.

EVENTS:

*/

// How big of files we allow users to open using syncstrings.
const MAX_FILE_SIZE_MB = 32;

// This parameter determines throttling when broadcasting cursor position
// updates.   Make this larger to reduce bandwidth at the expense of making
// cursors less responsive.
const CURSOR_THROTTLE_MS = 150;

// Reserved slot/user for backend filesystem-originated patches.
const FILESYSTEM_USER_ID = 0;
const FILESYSTEM_CLIENT_ID = "__filesystem__";

// If file does not exist for this long, then syncdoc emits a 'deleted' event.
export const DELETED_THRESHOLD = 2000;
export const DELETED_CHECK_INTERVAL = 750;

const STAT_DEBOUNCE = 10000;

import { DEFAULT_SNAPSHOT_INTERVAL } from "@cocalc/util/db-schema/syncstring-schema";

import { reuseInFlight } from "@cocalc/util/reuse-in-flight";
import { SyncTable } from "@cocalc/sync/table/synctable";
import { cancel_scheduled, once, until } from "@cocalc/util/async-utils";
import { wait } from "@cocalc/util/async-wait";
import { close, hash_string, minutes_ago } from "@cocalc/util/misc";
import * as schema from "@cocalc/util/schema";
import { delay } from "awaiting";
import { EventEmitter } from "events";
import { Map, fromJS, is as immutableIs } from "immutable";
import { debounce, throttle } from "lodash";
import { HistoryEntry, HistoryExportOptions, export_history } from "./export";
import { IpywidgetsState } from "./ipywidgets-state";
import {
  Session as PatchflowSession,
  type DocCodec,
  type PatchId,
  comparePatchId,
  decodePatchId,
  legacyPatchId,
  type PatchEnvelope,
  type Inconsistency,
  type PatchStore as PatchflowPatchStore,
  type PresenceAdapter as PatchflowPresenceAdapter,
  MemoryPresenceAdapter as PatchflowMemoryPresenceAdapter,
} from "patchflow";
import type { RecoveryState } from "@cocalc/conat/sync/core-stream";
import { stringMerge3 } from "./string-merge3";
import { dbMerge3 } from "../db/merge3";
import type {
  Client,
  CompressedPatch,
  DocType,
  Document,
  LiveSeedResult,
  Patch,
} from "./types";
import { sha256Utf8 } from "@cocalc/util/sha256-utf8";
import { isTestClient, patch_cmp } from "./util";
import mergeDeep from "@cocalc/util/immutable-deep-merge";
import { type Filesystem, type Stats } from "@cocalc/conat/files/fs";
import { getLogger } from "@cocalc/conat/logger";
import * as remote from "./remote";
import type { JSONValue } from "@cocalc/util/types";
import { rebaseLocalDocument } from "./rebase-local-document";
import {
  FILE_PROOF_MAX_BYTES,
  type FileProof,
  SAVED_FILE_CHECKPOINT,
  fileProof,
} from "./file-proof";
import {
  TRANSITION_MAX_PENDING,
  TRANSITION_MAX_PENDING_BYTES,
  TRANSITION_MAX_VALUE_BYTES,
  canDropAll,
  recoveryCopyName,
  valueBytesCapped,
} from "./history-transition";
import {
  ProofReads,
  type SavedFile,
  proofCoversHistory,
  resetOptions,
  savedFileOf,
  historyRestartKind,
  savesThroughWriteFile,
  seedFor,
  seedOfValue,
  validProof,
} from "./history-restart";
import type { ResetHistoryResult } from "@cocalc/conat/persist/storage";

const fallbackCursorPresence = new PatchflowMemoryPresenceAdapter();

const DEBUG = false;
const BACKEND_FS_WATCH_DISABLED_EXTENSIONS = new Set(["chat", "sage-chat"]);
const DEFAULT_BACKEND_FS_WATCH_TIMEOUT_MS = 20_000;

export type State = "init" | "ready" | "closed";
export type DataServer = "project" | "database";
type SyncDocTableRecoverOptions = {
  epoch?: number;
  force?: boolean;
  priority?: "foreground" | "background";
  reason?: string;
};
type RecoverableSyncTable = SyncTable & {
  recoverNow: (opts?: SyncDocTableRecoverOptions) => Promise<void>;
  getRecoveryState: () => RecoveryState;
};
export type SyncDocOpenPhase =
  | "open_start"
  | "canonicalize_identity_start"
  | "canonicalize_identity_done"
  | "syncstring_table_start"
  | "syncstring_table_done"
  | "backend_fs_watch_start"
  | "backend_fs_watch_done"
  | "backend_fs_reconcile_start"
  | "backend_fs_reconcile_done"
  | "patchflow_init_start"
  | "patchflow_init_done"
  | "patches_table_start"
  | "patches_table_done"
  | "patchflow_session_start"
  | "patchflow_session_done"
  | "cursor_presence_start"
  | "cursor_presence_done"
  | "cursors_start"
  | "cursors_done"
  | "sync_ready";

function isRecoverableSyncTable(
  table: SyncTable,
): table is RecoverableSyncTable {
  const candidate = table as unknown as Partial<RecoverableSyncTable>;
  return (
    typeof candidate.recoverNow === "function" &&
    typeof candidate.getRecoveryState === "function"
  );
}

export interface SyncOpts0 {
  project_id: string;
  path: string;
  client: Client;
  fs: Filesystem;

  patch_interval?: number;

  // document_activity_interval defaults to 60000.
  // Specify 0 to disable.
  document_activity_interval?: number;

  string_id?: string;
  // The caller already resolved path with canonicalSyncIdentityPath. This is
  // only a latency optimization; callers that cannot prove this must omit it.
  syncIdentityPathIsCanonical?: boolean;
  cursors?: boolean;
  change_throttle?: number;

  // persistent backend session in project, so only close
  // backend when explicitly requested:
  persistent?: boolean;

  // If true, entire sync-doc is assumed ephemeral, in the
  // sense that no edit history gets saved via patches to
  // the database.  The one syncstring record for coordinating
  // users does get created in the database.
  ephemeral?: boolean;

  // which data/changefeed server to use
  data_server?: DataServer;

  // if true, do not implicitly save to permanent storage on commit.
  // This is useful for unit testing to easily simulate offline state.
  // (This is not related to writing a file to disk.)
  noAutosave?: boolean;

  // if true, never saves to disk or loads from disk -- this is NOT
  // ephemeral -- the history is tracked in the conat database!
  noSaveToDisk?: boolean;
  // Where the patches stream is written: a persist service, and the identity
  // to ask it as. A board's manager writes its board stream through the host's
  // board write service, as the hub (conat/persist/board-policy.ts).
  patchesPersist?: { service: string; persistUser: Record<string, never> };

  // if true, do not register backend sync-fs watching for this document.
  // This still allows explicit save_to_disk writes.
  noBackendFsWatch?: boolean;

  // optional timeout for how long to wait from when a file is
  // deleted until emitting a 'deleted' event.
  deletedThreshold?: number;
  deletedCheckInterval?: number;

  watchDebounce?: number;
  // Filesystem reconciliation is auxiliary to live document sync and must not
  // keep the editor in its initial read-only state indefinitely.
  backendFsWatchTimeoutMs?: number;
  firstReadLockTimeout?: number;

  // if not set (the default), right when the document is 'ready',
  // there will be a change event with (for db's) an argument that
  // is the Set of all values.  If true, that initial big
  // change event happens, but the Set is empty.
  ignoreInitialChanges?: boolean;

  // Backend-only identity for a server-owned SyncDoc that commits on behalf
  // of an already authenticated account.  This is intentionally not exposed
  // by the browser sync-doc factories.
  trustedAccountId?: string;
}

export interface SyncOpts extends SyncOpts0 {
  from_str: (str: string) => Document;
  doctype: DocType;
}

// NOTE: Do not make multiple SyncDoc's for the same document, especially
// not on the frontend.

const logger = getLogger("sync-doc");

// Debugging aid (see SimpleInputMerge): set
// globalThis.__simpleInputMergeDebug to a function to receive events; the
// data is only computed when it is set.
function syncDebug(event: string, data: () => Record<string, unknown>): void {
  const hook = (globalThis as any).__simpleInputMergeDebug;
  if (typeof hook === "function") hook(event, data());
}
logger.debug("init");

// What snapshotCandidateFromHistory needs from a patchflow history entry.
type SnapshotHistoryEntry = {
  time: PatchId;
  isSnapshot?: boolean;
  size?: number;
};

// Where to make the next snapshot, if anywhere: about every `interval`
// patches after the last snapshot (or once the patches since it exceed
// maxSize), never at the newest patch.
export function snapshotCandidateFromHistory({
  history,
  interval: interval0,
  maxSize,
  isCut,
}: {
  history: SnapshotHistoryEntry[];
  interval: number;
  maxSize: number;
  isCut?: (time: PatchId) => boolean;
}): PatchId | undefined {
  if (history.length === 0) return;
  const interval = Math.max(1, Math.floor(interval0) || 1);
  const snapshots = history.filter((p) => p.isSnapshot);
  const lastSnapshotTime =
    snapshots.length > 0 ? snapshots[snapshots.length - 1].time : undefined;
  const window = history.filter((p) =>
    lastSnapshotTime != null
      ? comparePatchId(p.time, lastSnapshotTime) >= 0
      : true,
  );
  if (window.length === 0) return;
  // Prefer a patch that every other loaded patch is an ancestor or a
  // descendant of (a clean cut), near the chosen one: a client that loads
  // from a snapshot there needs no older history. Patches concurrent with
  // the snapshotted patch but appended before it are in neither the snapshot
  // nor the patches after it (see loadHistoryIfNeeded). If there is no clean
  // cut (constant concurrent editing), snapshot anyway once the window is
  // large, rather than never.
  const nearestCut = (idx: number): PatchId | undefined => {
    if (isCut == null) return window[idx].time;
    // Each check walks the loaded history, so only look nearby.
    for (let d = 0; d < Math.min(window.length, 200); d++) {
      for (const i of [idx - d, idx + d]) {
        if (i >= 1 && i < window.length - 1 && isCut(window[i].time)) {
          return window[i].time;
        }
      }
    }
    return window.length >= 4 * interval ? window[idx].time : undefined;
  };
  // Rule 1: interval count.  Far behind (snapshots stalled, or none for a
  // long time), snapshot one interval before the newest patch in one step,
  // so the next client to open the document loads about one interval, not
  // the whole backlog.
  if (window.length >= 2 * interval) {
    const idx =
      window.length >= 4 * interval
        ? window.length - interval - 1
        : Math.min(interval, window.length - 1);
    return nearestCut(idx);
  }
  // Rule 2: size threshold
  let totalSize = 0;
  for (const p of window) {
    if (!p.isSnapshot) {
      totalSize += p.size ?? 0;
    }
  }
  if (totalSize > maxSize) {
    let running = 0;
    for (let i = 0; i < window.length; i++) {
      running += window[i].size ?? 0;
      if (running > maxSize) {
        return nearestCut(i) ?? window[i].time;
      }
    }
  }
  return;
}

// Max later patches snapshotTimeAvoidingMismatch checks.
const SNAPSHOT_MISMATCH_SCAN = 200;

// snapshot() refuses a patch whose value differs from the hash its author
// recorded, and every client picks the same candidate, so one such patch used
// to stop snapshots for good (history then grows without bound, and every
// open loads all of it).  Use the nearest later patch whose value is not known
// to differ instead, preferring a clean cut.  Leaves the newest patch alone.
export function snapshotTimeAvoidingMismatch(
  session: any,
  candidate: PatchId,
  maxScan: number = SNAPSHOT_MISMATCH_SCAN,
): PatchId | undefined {
  if (
    typeof session?.verifyValue !== "function" ||
    session.verifyValue(candidate) !== "mismatch"
  ) {
    return candidate;
  }
  const later = (
    session.history({ includeSnapshots: false }) as SnapshotHistoryEntry[]
  )
    .filter((p) => comparePatchId(p.time, candidate) > 0)
    .slice(0, -1);
  let firstUsable: PatchId | undefined;
  for (let i = 0; i < Math.min(later.length, maxScan); i++) {
    const time = later[i].time;
    if (session.verifyValue(time) === "mismatch") {
      continue;
    }
    if (typeof session.isCut !== "function" || session.isCut(time)) {
      return time;
    }
    firstUsable ??= time;
  }
  return firstUsable;
}

// Where to load more history from: the stream position of the patch of the
// previous snapshot. Given where the loaded history starts (firstLoadedSeq),
// step back to the nearest snapshot before it: the latest prev_seq below it.
// The loaded range also holds the records of older snapshots (a snapshot is
// written about one interval after its patch), and taking the oldest one's
// prev_seq jumped back two snapshots at a time, or over the whole history
// after a long gap between snapshots.
export function prevSeqForMoreHistoryFromHistory(
  history: {
    time: PatchId;
    isSnapshot?: boolean;
    seqInfo?: { prevSeq?: number; prev_seq?: number };
  }[],
  firstLoadedSeq?: number,
): number | undefined {
  if (history.length == 0) return undefined;
  // SyncDoc passes its seq_info (snake case) through to patchflow.
  const prevSeqOf = (p: (typeof history)[number]) =>
    p.seqInfo?.prevSeq ?? p.seqInfo?.prev_seq;
  if (firstLoadedSeq != null) {
    let best: number | undefined;
    for (const p of history) {
      if (!p.isSnapshot) continue;
      const prevSeq = prevSeqOf(p);
      if (
        prevSeq != null &&
        prevSeq < firstLoadedSeq &&
        (best == null || prevSeq > best)
      ) {
        best = prevSeq;
      }
    }
    return best ?? 0;
  }
  let oldest: { prevSeq?: number } | undefined;
  let oldestTimeMs: number | undefined;
  for (const p of history) {
    if (!p.isSnapshot) continue;
    const timeMs = decodePatchId(p.time).timeMs;
    if (oldestTimeMs == null || timeMs < oldestTimeMs) {
      oldestTimeMs = timeMs;
      oldest = { prevSeq: prevSeqOf(p) };
    }
  }
  return oldest?.prevSeq ?? 0;
}

// A snapshot record of a patch before the loaded range (seq_info.seq <
// firstLoadedSeq). Each snapshot record is written about one interval after
// its patch, so it usually lands just after the next snapshot's patch: the
// range loaded from the latest snapshot holds the previous snapshot's record
// without its patch. Taken as a patch, it is a head with no exact value, so
// the client loaded more history; a step back to the previous snapshot then
// held the next older record, and so on, until a prod agent chat replayed
// its whole history (43,623 versions) on every open. Its patch is an
// ancestor of the loaded snapshot's patch, so it says nothing the loaded
// snapshot does not. Once more history loads its patch, it is used again.
// (A restarted history's seed has seq 0: it is the start, with no patch.)
export function isSnapshotRecordBeforeLoadedRange(
  patch: { is_snapshot?: boolean; seq_info?: { seq?: number } | null },
  firstLoadedSeq: number | undefined,
): boolean {
  const seq = patch.seq_info?.seq;
  return (
    !!patch.is_snapshot &&
    typeof seq === "number" &&
    seq > 0 &&
    typeof firstLoadedSeq === "number" &&
    seq < firstLoadedSeq
  );
}

// Whether the loaded patches are the whole history. Loading starts at the
// latest snapshot: at the stream position of the patch it is of
// (seq_info.seq), so there is older history unless that is the start of the
// stream. (Not whether there is an earlier snapshot: the first snapshot of a
// document has no prev_seq, but the patches before it exist.)
export function patchesHaveFullHistoryFromPatches(
  patches: {
    is_snapshot?: boolean;
    parents?: PatchId[];
    seq_info?: { seq?: number; prev_seq?: number };
  }[],
): boolean {
  const first = patches[0];
  if (first == null) return true;
  if (first.is_snapshot) {
    const seq = first.seq_info?.seq;
    if (seq != null) return seq <= 1;
    const prevSeq = first.seq_info?.prev_seq;
    return prevSeq == null || prevSeq <= 1;
  }
  return (first.parents?.length ?? 0) === 0;
}

const PATCH_DOC_METADATA_VERSION = 1;
const LATEST_SNAPSHOT_CHECKPOINT = "latest_snapshot";

interface PatchDocMetadataV1 {
  version: 1;
  users?: string[];
  snapshot_interval?: number;
  settings?: JSONValue;
}

// The live-writer seed's encoded size (bounded history plan H1b-3, §2 step 6).
const LIVE_SEED_MAX_BYTES = 40 * 1024 * 1024;
// how long an opener waits for the live writer's answer, in all (the
// writer's own deadline is shorter), and how often it looks for another
// opener's seed when the writer is busy with it
const LIVE_SEED_WAIT_MS = 60_000;
const LIVE_SEED_POLL_MS = 2_000;

class DeadlineExpired extends Error {}

function withDeadlineAt<T>(
  deadlineAt: number,
  p: Promise<T>,
  now: () => number,
): Promise<T> {
  const ms = deadlineAt - now();
  if (ms <= 0) {
    p.catch(() => {});
    return Promise.reject(new DeadlineExpired());
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new DeadlineExpired()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// True once cond holds, false after ms (checked every 25 ms).
async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + Math.max(0, ms);
  for (;;) {
    if (cond()) return true;
    if (Date.now() >= end) return false;
    await delay(25);
  }
}

export class SyncDoc extends EventEmitter {
  static events = new EventEmitter();
  static lite = false;
  private static testInstances: Set<SyncDoc> = new Set();

  public readonly opts: SyncOpts;
  public readonly project_id: string; // project_id that contains the doc
  public readonly path: string; // path of the file corresponding to the doc
  // Canonical document identity used for sync tables and patch streams.
  private syncPath: string;
  private string_id: string;
  private my_user_id: number;
  private readonly trustedAccountId?: string;

  private client: Client;
  private _from_str: (str: string) => Document; // creates a doc from a string.

  // Throttling of incoming upstream patches from project to client.
  private patch_interval: number = 250;

  // throttling of change events -- e.g., is useful for course
  // editor where we have hundreds of changes and the UI gets
  // overloaded unless we throttle and group them.
  private change_throttle: number = 0;

  // document_activity_interval throttle: default is 60s for everything
  private document_activity_interval: number;
  private throttled_document_activity?: Function;

  private cursors: boolean = false; // if true, also provide cursor tracking functionality
  private cursor_map: Map<string, any> = Map();
  private cursor_last_time: Date = new Date(0);

  // doctype: object describing document constructor
  // (used by project to open file)
  public doctype: DocType;

  private state: State = "init";
  private liveConnected = false;

  private syncstring_table?: SyncTable;
  public patches_table: SyncTable;
  private syncMetadata: Map<string, any> = Map();
  private readonly patchMetadataChanged = () => {
    void this.refreshPatchMetadataFromDStream();
  };

  public ipywidgets_state?: IpywidgetsState;

  private patchflowSession?: PatchflowSession;
  private updateHasUnsavedChangesDebounced?: ReturnType<typeof debounce>;
  private patchflowStore?: PatchflowPatchStore;
  private patchflowCodec?: DocCodec;
  // One cursor channel per document, closed with it. Its subscription is
  // shared by every document on this path in the process, so an unclosed
  // channel keeps this closed document (and its patch history) alive.
  private cursorPresenceAdapter?: Promise<PatchflowPresenceAdapter | undefined>;
  private cursorPubSub?: { close: () => void };

  private last: Document;
  private doc: Document;
  private before_change?: Document;
  // The value a local draft set with from_str(value, { base }) was derived
  // from, e.g. what an editor showed when its user typed. The draft's changes
  // are relative to it rather than to this.last, which can be newer: a remote
  // change can reach this document before the editor shows it, and diffing
  // the editor's value against this.last would delete that change.
  private draftBase?: Document;
  private cursorSnapshots: any[] = [];

  private last_user_change: Date = minutes_ago(60);
  private last_save_to_disk_time: Date = new Date(0);

  private last_snapshot?: PatchId;
  private last_seq?: number;
  private snapshot_interval: number;
  private history_epoch?: number;

  private users: string[];

  private settings: Map<string, any> = Map();

  // patches that this client made during this editing session.
  private my_patches: { [time: PatchId]: any } = {};

  private undo_mode = false;

  private persistent: boolean = false;

  private last_has_unsaved_changes?: boolean = undefined;
  private localEditsSinceDiskBaseline = false;
  private diskMissingOnLoad = false;
  private diskBaselineRequestId = 0;

  private ephemeral: boolean = false;

  private useConat: boolean;

  public readonly fs: Filesystem;

  private noAutosave?: boolean;
  private backendFsWatchTimer?: NodeJS.Timeout;
  private readonly openStartedAtMs: number = Date.now();

  private emitOpenPhase = (
    phase: SyncDocOpenPhase | string,
    details?: { [key: string]: string | number | boolean | undefined },
  ): void => {
    const payload = {
      phase,
      elapsed_ms: Math.max(0, Date.now() - this.openStartedAtMs),
      project_id: this.project_id,
      path: this.path,
      string_id: this.string_id,
      ...(details ?? {}),
    };
    this.emit("open-phase", payload);
  };

  private makeConatInitPhaseReporter = (prefix: string) => {
    return (
      phase: string,
      details?: { [key: string]: string | number | boolean | undefined },
    ) => {
      this.emitOpenPhase(`${prefix}.${phase}`, details);
    };
  };

  // The isDeleted flag is set to true if the file existed and then
  // was actively deleted after the session started. It would
  // then only be set back to false if the file appears again.
  public isDeleted: boolean = false;

  private emitDeleted = (): void => {
    if (!this.isDeleted) {
      this.isDeleted = true;
      this.emit("deleted");
    }
  };

  private markLocalUnsavedChange = (): void => {
    // every local change, including during a history transition (see
    // runHistoryTransition): a later generation is never released by a copy
    // of an earlier one
    this.localGeneration += 1;
    if (this.state !== "ready") {
      return;
    }
    this.localEditsSinceDiskBaseline = true;
  };

  private emitUserChange = (): void => {
    this.markLocalUnsavedChange();
    this.emit("user-change");
  };

  constructor(opts: SyncOpts) {
    super();
    if (process.env.COCALC_TEST_MODE) {
      SyncDoc.testInstances.add(this);
    }
    this.opts = opts;

    if (opts.string_id === undefined) {
      this.string_id = schema.client_db.sha1(opts.project_id, opts.path);
    } else {
      this.string_id = opts.string_id;
    }

    // TODO: it might be better to just use this.opts.field everywhere...?
    for (const field of [
      "project_id",
      "path",
      "client",
      "patch_interval",
      "document_activity_interval",
      "change_throttle",
      "cursors",
      "doctype",
      "from_patch_str",
      "persistent",
      "data_server",
      "ephemeral",
      "fs",
      "noAutosave",
    ]) {
      if (opts[field] != undefined) {
        this[field] = opts[field];
      }
    }
    this.syncPath = this.path;

    this.client.once("closed", this.close);

    // NOTE: Do not use conat in test mode, since there we use a minimal
    // "fake" client that does all communication internally and doesn't
    // use conat.  We also use this for the messages composer.
    this.useConat = !isTestClient(opts.client);
    if (this.ephemeral) {
      // So the doctype written to the database reflects the
      // ephemeral state.  Here ephemeral determines whether
      // or not patches are written to the database by the
      // project.
      this.doctype.opts = { ...this.doctype.opts, ephemeral: true };
    }
    if (this.cursors) {
      // similarly to ephemeral, but for cursors.   We track them
      // on the backend since they can also be very useful, e.g.,
      // with jupyter they are used for connecting remote compute,
      // and **should** also be used for broadcasting load and other
      // status information (TODO).
      this.doctype.opts = { ...this.doctype.opts, cursors: true };
    }
    this._from_str = opts.from_str;
    this.trustedAccountId = opts.trustedAccountId;

    // Initialize to creation time, so we don't
    // see our own cursor when we refresh the browser (before we move
    // to update this).
    this.cursor_last_time = this.client?.server_time();

    if (this.change_throttle) {
      this.emit_change = throttle(this.emit_change, this.change_throttle);
    }

    this.setMaxListeners(100);
    this.emitOpenPhase("open_start");

    this.init();
    // This makes it possible for other parts of the app to react to
    // creation of new synchronized docs.
    SyncDoc.events.emit("new", this);
  }

  /*
  Initialize everything.
  This should be called *exactly* once by the constructor,
  and no other time.  It tries to set everything up.  If
  the browser isn't connected to the network, it'll wait
  until it is (however long, etc.).  If this fails, it closes
  this SyncDoc.
  */
  private initialized = false;
  init = reuseInFlight(async () => {
    if (this.initialized) {
      throw Error("init can only be called once");
    }
    // const start = Date.now();
    this.assert_not_closed("init");
    const log = this.dbg("init");
    let attempt = 0;
    await until(
      async () => {
        if (this.state != "init") {
          return true;
        }
        attempt += 1;
        this.emitOpenPhase("init_attempt_start", { attempt });
        try {
          log("initializing all tables...");
          await this.initAll();
          log("initAll succeeded");
          this.emitOpenPhase("init_attempt_done", { attempt });
          return true;
        } catch (err) {
          this.emitOpenPhase("init_attempt_failed", {
            attempt,
            error_code:
              typeof (err as any)?.code === "string"
                ? (err as any).code.slice(0, 80)
                : undefined,
            error_name:
              typeof (err as any)?.name === "string"
                ? (err as any).name.slice(0, 80)
                : undefined,
          });
          if (this.isClosed()) {
            return true;
          }
          if (await this.resetOversizedHistory(err)) {
            // the history was reset, so open again right away
            try {
              await this.initAll();
              this.emitOpenPhase("init_attempt_done", { attempt });
              return true;
            } catch (retryErr) {
              err = retryErr;
            }
          }
          const m = `WARNING: problem initializing ${this.path} -- ${err}`;
          log(m);
          if (DEBUG || true) {
            console.trace(err);
          }
          // log always
          console.log(m);
        }
        log("wait then try again");
        return false;
      },
      { start: 3000, max: 15000, decay: 1.3 },
    );
    if (this.isClosed()) return;
    // Before showing the document, so it never shows an incomplete value.
    await this.loadHistoryForExactValue();
    if (this.isClosed()) return;
    this.set_state("ready");
    this.emitOpenPhase("sync_ready");

    // Success -- everything initialized with no issues.
    if (this.opts.ignoreInitialChanges) {
      // clear all changes up to this point
      this.before_change = this.doc;
    }
    this.emit_change(); // from nothing to something.
  });

  // A patch too large to load (e.g., a runaway notebook output saved as one
  // 500 MB patch) makes every open of this document fail with 413.  A
  // document saved with writeFile may be reset from its saved file, but only
  // when its proof covers every accepted edit (resetOversizedHistoryFromFile);
  // nothing else is reset automatically.  The user is told instead
  // (history-unloadable) and can choose a restart.  At most once per SyncDoc.
  private oversizedHistoryReset = false;
  private resetOversizedHistory = async (err: unknown): Promise<boolean> => {
    const oversized_seq = (err as any)?.oversizedHistorySeq;
    if (typeof oversized_seq != "number" || this.oversizedHistoryReset) {
      return false;
    }
    if (savesThroughWriteFile(this.syncPath)) {
      // saved with writeFile, so with a proof of what the file covers
      return await this.resetOversizedHistoryFromFile();
    }
    // Documents whose file is written elsewhere (a notebook's .ipynb, a
    // board's file) have no proof.  They are never reset automatically: that
    // would silently drop every edit since the file was saved (bounded
    // history plan H1b-3).  A notebook asks its live writer, the project's
    // backend, to seed a new history from its live value (A), once; failing
    // that, the user is told, and can confirm restarting from the saved
    // .ipynb (B, restartHistoryFromIpynb); the open keeps retrying meanwhile.
    if (
      historyRestartKind(this.syncPath) == "ipynb" &&
      (await this.askLiveWriterToSeed(oversized_seq))
    ) {
      return true;
    }
    this.reportUnloadableHistory((err as any)?.oversizedHistoryEpoch);
    return false;
  };

  // (A), asked at most once per SyncDoc.  True if the history now has a new
  // epoch seeded with the live value (from this request, or one before it).
  // No answer, a refusal, or an error is never a rollback: false.
  private liveSeedAsked = false;
  // One deadline for the whole request: every await below, the writer's
  // answer and each poll included (the tests shorten them).
  private liveSeedWaitMs = LIVE_SEED_WAIT_MS;
  private liveSeedPollMs = LIVE_SEED_POLL_MS;
  private askLiveWriterToSeed = async (
    oversizedSeq: number,
  ): Promise<boolean> => {
    const client = this.client;
    if (
      this.liveSeedAsked ||
      typeof client.askLiveWriterToSeed != "function" ||
      typeof client.historyResetState != "function"
    ) {
      return false;
    }
    this.liveSeedAsked = true;
    const end = Date.now() + this.liveSeedWaitMs;
    const bounded = <T>(p: Promise<T>) => withDeadlineAt(end, p, Date.now);
    try {
      const state = await bounded(
        client.historyResetState({
          project_id: this.project_id,
          path: this.syncPath,
          ...this.patchesPersistOpts(),
        }),
      );
      const result = await bounded(
        client.askLiveWriterToSeed({
          project_id: this.project_id,
          path: this.syncPath,
          epoch: state.epoch,
          oversizedSeq,
        }),
      );
      if (!result?.seeded) {
        this.dbg("askLiveWriterToSeed")(
          `not seeded -- ${result?.reason} ${result?.message ?? ""}`,
        );
        // busy: another opener's request is seeding it right now; if its
        // epoch moves within this request's time, open with it
        if (result?.reason == "busy") {
          while (Date.now() < end && !this.isClosed()) {
            await delay(Math.min(this.liveSeedPollMs, end - Date.now()));
            const now = await bounded(
              client.historyResetState({
                project_id: this.project_id,
                path: this.syncPath,
                ...this.patchesPersistOpts(),
              }),
            );
            if (now.epoch > state.epoch) {
              this.oversizedHistoryReset = true;
              this.history_epoch = now.epoch;
              return true;
            }
          }
        }
        return false;
      }
      this.oversizedHistoryReset = true;
      this.history_epoch = result.history_epoch;
      if (!result.repeated) {
        this.client.alert_message?.({
          type: "info",
          title: "Edit history archived and restarted",
          message: `The edit history (TimeTravel) of ${this.path} had an entry too large to load, most likely a huge output. It was archived and restarted from the running notebook, which includes every edit, and the notebook opened normally. Its kernel was restarted: variables and anything it was running are lost.`,
          block: true,
        });
      }
      return true;
    } catch (err) {
      this.dbg("askLiveWriterToSeed")(`no answer -- ${err}`);
      return false;
    }
  };

  // (A) The live-writer seed (bounded history plan H1b-3 r4, §2).  This
  // document, open and ready, seeds a new history from its live value when
  // that value covers exactly the history's revision N: caught up to N, with
  // nothing of its own pending, captured in one synchronous step, then reset
  // with ifRevision N and ifInitEpoch, coveredSeq N.  Anything accepted after
  // N refuses the reset (moved): at most 3 rounds.  Everything is bounded by
  // deadlineAt.  The caller's gate (gate.beforeReset) admits the one reset
  // mutation; gate.answered is called with its opId whenever its answer
  // arrives, also after the deadline.  Never a rollback: any doubt refuses.
  seedHistoryFromLiveValue = async ({
    epoch,
    deadlineAt,
    gate,
    now = Date.now,
    limits = {},
    track = (p) => p,
  }: {
    epoch: number;
    deadlineAt: number;
    // every RPC this starts, so the caller can wait for them to settle after
    // a deadline before it lets another run start (LIMIT-H1B3B-1)
    track?: <T>(p: Promise<T>) => Promise<T>;
    // for tests
    limits?: { stepMs?: number; reserveMs?: number; valueBytes?: number };
    gate?: {
      beforeReset: (reset: {
        opId: string;
        epoch: number;
        revision: { seq: number; count: number };
      }) => boolean;
      answered: (opId: string) => void;
    };
    now?: () => number;
  }): Promise<LiveSeedResult> => {
    const client = this.client;
    if (
      typeof client.historyResetState != "function" ||
      typeof client.resetHistory != "function"
    ) {
      return { seeded: false, reason: "failed", message: "not supported" };
    }
    // kept for the reset itself
    const RESERVE_MS = limits.reserveMs ?? 10_000;
    const STEP_MS = limits.stepMs ?? 10_000;
    const VALUE_BYTES = limits.valueBytes ?? TRANSITION_MAX_VALUE_BYTES;
    const remaining = () => deadlineAt - now();
    const notReady = () => !this.isReady() || this.historyTransition != null;
    const dstream = this.dstream();
    const caughtUpTo = (seq: number) =>
      dstream.receivedThroughSeq() >= seq &&
      !this.remotePatchesPending &&
      !(this.patchflowSession as any)?.needsMoreHistory?.();
    const quiet = () =>
      (dstream.pendingStats?.().count ?? 0) == 0 &&
      !this.remotePatchesPending &&
      this.doc != null &&
      this.last != null &&
      this.documentsEqual(this.doc, this.last);
    try {
      for (let round = 0; round < 3; round++) {
        if (notReady()) return { seeded: false, reason: "not-ready" };
        if ((this.history_epoch ?? 0) !== epoch) {
          return { seeded: false, reason: "epoch" };
        }
        if (remaining() < RESERVE_MS) {
          return { seeded: false, reason: "deadline" };
        }
        const state = await withDeadlineAt(
          deadlineAt,
          track(
            client.historyResetState({
              project_id: this.project_id,
              path: this.syncPath,
              ...this.patchesPersistOpts(),
            }),
          ),
          now,
        );
        if (state.epoch !== epoch) return { seeded: false, reason: "epoch" };
        const N = state.seq;
        // catch up to N
        if (
          !(await waitFor(
            () => notReady() || caughtUpTo(N),
            Math.min(STEP_MS, remaining() - RESERVE_MS),
          )) ||
          notReady()
        ) {
          return notReady()
            ? { seeded: false, reason: "not-ready" }
            : { seeded: false, reason: "not-caught-up" };
        }
        // quiesce: everything of ours acknowledged, so at a seq at most N
        if (
          this.doc != null &&
          this.last != null &&
          !this.documentsEqual(this.doc, this.last)
        ) {
          this.commit();
        }
        if (
          !(await waitFor(
            () => notReady() || quiet(),
            Math.min(STEP_MS, remaining() - RESERVE_MS),
          )) ||
          notReady()
        ) {
          return notReady()
            ? { seeded: false, reason: "not-ready" }
            : { seeded: false, reason: "busy" };
        }
        // capture, in one synchronous step
        if (dstream.receivedThroughSeq() !== N || !caughtUpTo(N) || !quiet()) {
          // something arrived meanwhile: another round
          continue;
        }
        if (valueBytesCapped(this.doc, VALUE_BYTES) == null) {
          return { seeded: false, reason: "too-large" };
        }
        const value = this.to_str();
        const seed = seedOfValue(value);
        if (seed.raw.length > LIVE_SEED_MAX_BYTES) {
          return { seeded: false, reason: "too-large" };
        }
        const revision = { seq: N, count: state.count };
        const opId = [
          "live-seed",
          epoch,
          N,
          state.count,
          sha256Utf8(value)?.sha256,
        ].join(":");
        if (remaining() <= 0) return { seeded: false, reason: "deadline" };
        if (gate != null && !gate.beforeReset({ opId, epoch, revision })) {
          return { seeded: false, reason: "busy" };
        }
        const time = now();
        const reset = client.resetHistory({
          project_id: this.project_id,
          path: this.syncPath,
          ...this.patchesPersistOpts(),
          busyAttempts: Math.max(1, Math.floor(remaining() / 1000) - 1),
          options: {
            ifRevision: revision,
            ifInitEpoch: epoch,
            coveredSeq: N,
            allowRollback: false,
            archive: true,
            seed,
            reason: "live-seed",
            opId,
            settings: {
              history_purged_at: time,
              history_reset: {
                reason: "live-seed",
                coverage: "proven",
                coveredSeq: N,
                time,
              },
            },
          } as any,
        });
        track(reset);
        reset.then(
          () => gate?.answered(opId),
          () => gate?.answered(opId),
        );
        const result = await withDeadlineAt(deadlineAt, reset, now);
        if (result.reset) {
          return {
            seeded: true,
            history_epoch: result.history_epoch,
            ...(result.repeated ? { repeated: true } : {}),
          };
        }
        if (result.refused == "moved") continue;
        return {
          seeded: false,
          reason:
            result.refused == "epoch"
              ? "epoch"
              : result.refused == "busy"
                ? "busy"
                : result.refused == "seed-too-large"
                  ? "too-large"
                  : "failed",
          message: result.refused,
        };
      }
      return { seeded: false, reason: "moved" };
    } catch (err) {
      if (err instanceof DeadlineExpired) {
        return { seeded: false, reason: "deadline" };
      }
      return { seeded: false, reason: "failed", message: `${err}` };
    }
  };

  // The history holds an entry too large to load (a 413).  Reset it from the
  // saved file only if nothing can be lost: the file's proof is valid for
  // its exact bytes and covers every accepted message (bounded history plan
  // r3, §2.3 case 1).  Otherwise nothing is reset automatically: the editor
  // is told ("history-unloadable") and the user can choose to restart the
  // history from the saved file (restartHistoryFromSavedFile).
  private proofReads = new ProofReads();
  private resetOversizedHistoryFromFile = async (): Promise<boolean> => {
    const client = this.client;
    if (
      typeof client.historyResetState != "function" ||
      typeof client.readFileBounded != "function" ||
      typeof client.resetHistory != "function"
    ) {
      this.reportUnloadableHistory();
      return false;
    }
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const state = await client.historyResetState({
          project_id: this.project_id,
          path: this.syncPath,
          ...this.patchesPersistOpts(),
        });
        if (!proofCoversHistory(state)) break;
        // Read the file only once per proof: if its bytes do not match,
        // reading it again on every retry of the open would not help.
        if (!this.proofReads.shouldRead(state)) break;
        const file = (await this.readSavedFile()).file;
        const proof = file != null ? validProof(state, file) : undefined;
        if (file == null || proof == null) {
          this.proofReads.reject(state);
          break;
        }
        const result = await client.resetHistory({
          project_id: this.project_id,
          path: this.syncPath,
          ...this.patchesPersistOpts(),
          options: resetOptions({
            mode: "oversized",
            state,
            file,
            proof,
            seed: this.seedOf(file.value),
          }),
        });
        if (result.reset) {
          this.oversizedHistoryReset = true;
          this.history_epoch = result.history_epoch;
          const lost =
            (result.dropped?.records ?? 0) +
            (result.droppedArchived?.records ?? 0);
          // only the client whose reset ran tells its user (another one that
          // made the same request got its result back, as repeated)
          if (result.repeated) return true;
          this.client.alert_message?.({
            type: "info",
            title: "Edit history archived and restarted",
            message: `The edit history (TimeTravel) of ${this.path} had an entry too large to load, most likely a huge output. It was archived and restarted from the saved file, which includes every edit, and the file opened normally.${lost > 0 ? ` ${lost} older history entries could not be kept in the archive.` : ""}`,
            block: true,
          });
          return true;
        }
        if (result.refused !== "moved" && result.refused !== "epoch") break;
      }
    } catch (err) {
      // e.g., no connection: the open retries, and so does this
      this.dbg("resetOversizedHistoryFromFile")(`failed -- ${err}`);
      return false;
    }
    this.reportUnloadableHistory();
    return false;
  };

  private patchesPersistOpts = () =>
    this.opts.patchesPersist ? { persist: this.opts.patchesPersist } : {};

  // the saved file, read with a bound (at most FILE_PROOF_MAX_BYTES)
  private readSavedFile = async (): Promise<{
    file?: SavedFile;
    problem?: string;
  }> => {
    const read = await this.client.readFileBounded!({
      project_id: this.project_id,
      path: this.path,
      maxBytes: FILE_PROOF_MAX_BYTES,
    });
    if (read.status != "ok") {
      return {
        problem:
          read.status == "missing"
            ? "the file does not exist"
            : read.status == "too-large"
              ? "the file is larger than 32 MiB"
              : `the file could not be read (${read.error ?? ""})`,
      };
    }
    const file = savedFileOf(read.data);
    return file == null ? { problem: "the file is not UTF-8 text" } : { file };
  };

  // The first message of a restarted history: a snapshot of value, by the
  // filesystem user (the first user of a document).
  private seedOf = (value: string) =>
    seedFor({
      value,
      time: legacyPatchId(Date.now()),
      wall: Date.now(),
      userId: 0,
    });

  private unloadableHistoryReported = false;
  // history_epoch: the epoch the persist server failed to load the history
  // in, when it said (so a later reset is recognized as a recovery, H1b-4).
  private reportUnloadableHistory = (history_epoch?: number): void => {
    if (this.unloadableHistoryReported) return;
    this.unloadableHistoryReported = true;
    this.emit("history-unloadable", {
      path: this.path,
      restart: historyRestartKind(this.syncPath),
      ...(typeof history_epoch == "number" ? { history_epoch } : {}),
    });
  };

  // The user's choice when the history cannot be loaded: restart it from the
  // saved file, removing newer edits from the live document (they are kept
  // in the archived history, as far as its limits allow).  With a valid
  // proof the file covers what it proves; without one, nothing.  Resolves to
  // the reset's result; the document then opens with the restarted history.
  restartHistoryFromSavedFile = async (): Promise<ResetHistoryResult> => {
    const client = this.client;
    if (
      typeof client.historyResetState != "function" ||
      typeof client.readFileBounded != "function" ||
      typeof client.resetHistory != "function"
    ) {
      throw Error("restarting the history is not supported here");
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = await client.historyResetState({
        project_id: this.project_id,
        path: this.syncPath,
        ...this.patchesPersistOpts(),
      });
      const { file, problem } = await this.readSavedFile();
      if (file == null) {
        throw Error(
          `cannot restart the history from the saved file: ${problem}`,
        );
      }
      const result = await client.resetHistory({
        project_id: this.project_id,
        path: this.syncPath,
        ...this.patchesPersistOpts(),
        options: resetOptions({
          mode: "user-restart-from-file",
          state,
          file,
          proof: validProof(state, file),
          seed: this.seedOf(file.value),
        }),
      });
      if (result.reset) {
        this.oversizedHistoryReset = true;
        this.history_epoch = result.history_epoch;
        return result;
      }
      if (result.refused !== "moved" && result.refused !== "epoch") {
        throw Error(`the history was not restarted (${result.refused})`);
      }
    }
    throw Error("the history kept changing; please try again");
  };

  // When the history is reset under this open copy (a new epoch), keep this
  // tab's edits (bounded history plan H1b-2): ask which pending patches the
  // new history already includes; if everything this tab has is included,
  // reload; otherwise first save the current value to a recovery copy beside
  // the file.  Nothing is reconstructed from the old history and nothing is
  // merged into the new one (H2).  Edits keep going into the live document
  // meanwhile; nothing more is written in the old epoch.
  private localGeneration = 0;
  private historyTransition?: {
    // the epoch this tab's pending patches were written in
    fromEpoch: number;
    toEpoch: number;
    // generation when the transition began: anything later is unsaved
    startGeneration: number;
    // copies written so far (kept and reported, never overwritten)
    copies: string[];
    // a newer reset arrived while this one ran: run again
    restart: boolean;
    // the value is resident but not saved anywhere (too large to copy, or
    // the copy failed): the editor shows NOT SAVED
    unsaved?: string;
  };

  private beginHistoryTransition = (
    toEpoch?: number,
    fromEpoch?: number,
  ): void => {
    const epoch = toEpoch ?? this.history_epoch ?? 0;
    const t = this.historyTransition;
    if (t != null) {
      // a duplicate is ignored; a newer reset restarts, keeping everything
      if (epoch <= t.toEpoch) return;
      t.toEpoch = epoch;
      t.restart = true;
      t.unsaved = undefined;
    } else {
      this.patchflowSession?.off?.("change", this.handlePatchflowChange);
      this.historyTransition = {
        // a document never reset has epoch 0; a wrong guess only means
        // nothing can be proven absent, so the value is copied
        fromEpoch: fromEpoch ?? 0,
        toEpoch: epoch,
        startGeneration: this.localGeneration,
        copies: [],
        restart: false,
      };
    }
    void this.runHistoryTransition();
  };

  // The editor's "Retry" while NOT SAVED.
  retryHistoryTransition = (): void => {
    const t = this.historyTransition;
    if (t == null || t.unsaved == null) return;
    t.unsaved = undefined;
    void this.runHistoryTransition();
  };

  // For the editor's "Download a copy" while NOT SAVED: the value and the
  // generation it represents.  reloadAfterDownload(generation) reloads only
  // if nothing changed since that download.
  valueForDownload = (): { value: string; generation: number } => ({
    value: this.to_str(),
    generation: this.localGeneration,
  });

  reloadAfterDownload = (generation: number): boolean => {
    const t = this.historyTransition;
    if (t == null || this.localGeneration !== generation) return false;
    this.finishHistoryTransition();
    return true;
  };

  // One run at a time; a newer reset during a run makes it run again.  The
  // flag is cleared in the same synchronous step as the last restart check,
  // so a restart is never lost between them.
  private historyTransitionRunning = false;
  private runHistoryTransition = async (): Promise<void> => {
    if (this.historyTransitionRunning) {
      if (this.historyTransition != null) this.historyTransition.restart = true;
      return;
    }
    this.historyTransitionRunning = true;
    try {
      for (;;) {
        const t = this.historyTransition;
        if (t == null || this.isClosed()) return;
        t.restart = false;
        await this.historyTransitionStep();
        if (!this.historyTransition?.restart) return;
      }
    } catch (err) {
      // never silently: the value stays in this tab, NOT SAVED
      this.dbg("runHistoryTransition")(`${err}`);
      this.reportUnsavedTransition("copy-failed");
    } finally {
      this.historyTransitionRunning = false;
    }
  };

  private historyTransitionStep = async (): Promise<void> => {
    const t = this.historyTransition!;
    const stillCurrent = () =>
      this.historyTransition === t && !t.restart && !this.isClosed();
    let dstream: any;
    try {
      dstream = this.dstream();
    } catch {
      dstream = undefined;
    }
    // admission, before anything is serialized (LIMIT-H1B-2, LIMIT-H1B2P-2)
    const stats = dstream?.pendingStats?.() ?? { count: 0, bytes: 0 };
    const admitted =
      stats.count <= TRANSITION_MAX_PENDING &&
      stats.bytes <= TRANSITION_MAX_PENDING_BYTES;
    // the value, measured capped before anything else touches the whole
    // document (pendingMessages, the query, is_equal): over the cap, or not
    // measurable, is NOT SAVED at once (plan r3 step 2, LIMIT-H1B2I-1)
    if (!this.admitValue()) return;
    const pending: { id: string }[] =
      admitted && dstream?.pendingMessages != null
        ? dstream.pendingMessages()
        : [];
    const ids = pending.map(({ id }) => id);
    let statuses: { [id: string]: { status: any } } | undefined;
    if (admitted && ids.length > 0) {
      statuses = await this.queryHistoryInclusion(t, ids);
      if (!stillCurrent()) return;
    }
    const hasDraft =
      this.doc != null && this.last != null && !this.doc.is_equal(this.last);
    if (
      admitted &&
      canDropAll({
        ids,
        statuses,
        hasDraft,
        hasLaterEdits: this.localGeneration !== t.startGeneration,
      })
    ) {
      // everything this tab has is in the new history
      this.finishHistoryTransition();
      return;
    }
    await this.copyThenFinishHistoryTransition(stillCurrent);
  };

  // One inclusion request, retried a few times; undefined if it keeps
  // failing (then the value is copied, never dropped).
  private queryHistoryInclusion = async (
    t: { fromEpoch: number },
    ids: string[],
  ): Promise<{ [id: string]: { status: any } } | undefined> => {
    if (typeof this.client.historyInclusion != "function") return undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await this.client.historyInclusion({
          project_id: this.project_id,
          path: this.syncPath,
          ...this.patchesPersistOpts(),
          // the epoch they were written in, so a missing id can be proven
          // absent (a newer reset keeps the first transition's epoch)
          epoch: t.fromEpoch,
          ids,
        });
        return result.ids;
      } catch (err) {
        this.dbg("queryHistoryInclusion")(`${err}`);
        if (attempt < 2) await delay(1000 * (attempt + 1));
      }
    }
    return undefined;
  };

  // Save the current value to a recovery copy, then reload.  Each copy is
  // an immutable value with the generation it represents; a successful copy
  // releases only that generation (astra's condition 2): if the document
  // changed while it was written, the later generation is copied again, up
  // to 3 times, then NOT SAVED.
  private copyThenFinishHistoryTransition = async (
    stillCurrent: () => boolean,
  ): Promise<void> => {
    const t = this.historyTransition!;
    for (let round = 0; round < 3; round++) {
      if (!this.admitValue()) return;
      const generation = this.localGeneration;
      const value = this.to_str();
      const path = await this.writeRecoveryCopy(value);
      if (path != null) t.copies.push(path);
      if (!stillCurrent()) return;
      if (path == null) {
        this.reportUnsavedTransition("copy-failed");
        return;
      }
      if (this.localGeneration === generation) {
        // in the same synchronous step as the check: no edit can fall
        // between them
        this.finishHistoryTransition();
        return;
      }
    }
    this.reportUnsavedTransition("still-changing");
  };

  // Write value to a new recovery copy beside the file; its path, or
  // undefined after 3 failed attempts.  Names are unique per client and
  // random; the existence check makes overwriting an earlier copy unlikely
  // but cannot rule it out (best effort: the fs API has no exclusive create).
  private writeRecoveryCopy = async (
    value: string,
  ): Promise<string | undefined> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const path = recoveryCopyName(this.path, {
        clientId: this.client.client_id?.() ?? "",
      });
      try {
        if (await this.fs.exists(path)) continue;
        await this.fs.writeFile(path, value);
        return path;
      } catch (err) {
        this.dbg("writeRecoveryCopy")(`${err}`);
        if (attempt < 2) await delay(1000 * (attempt + 1));
      }
    }
    return undefined;
  };

  // Whether the current value is within the 32 MiB cap, measured capped and
  // cached per document (documents are immutable, so the same object has the
  // same size); otherwise reports NOT SAVED.
  private admittedValueDoc?: Document;
  private admitValue = (): boolean => {
    if (this.doc != null && this.doc === this.admittedValueDoc) return true;
    if (valueBytesCapped(this.doc, TRANSITION_MAX_VALUE_BYTES) == null) {
      this.reportUnsavedTransition("too-large");
      return false;
    }
    this.admittedValueDoc = this.doc;
    return true;
  };

  // NOT SAVED: the tab keeps its value, which is saved nowhere; the editor
  // offers "Download a copy" and "Retry".
  private reportUnsavedTransition = (reason: string): void => {
    const t = this.historyTransition;
    if (t == null) return;
    t.unsaved = reason;
    this.emit("history-reset-unsaved", {
      history_epoch: t.toEpoch,
      reason,
      copies: [...t.copies],
    });
  };

  // Everything this tab had is in the new history or in a copy: hand off.
  // The editor reopens the file, which opens the new history.
  private finishHistoryTransition = (): void => {
    const t = this.historyTransition;
    if (t == null) return;
    this.emit("history-reset", {
      history_epoch: t.toEpoch,
      copies: [...t.copies],
    });
    this.close();
  };

  // A 413 while loading the patches means the edit history itself holds a
  // patch too large to load (see resetOversizedHistory), as opposed to some
  // other stream this document uses.
  private markOversizedHistory = (err: unknown): unknown => {
    const seq = (err as any)?.oversizedSeq;
    if ((err as any)?.code == 413 && typeof seq == "number") {
      (err as any).oversizedHistorySeq = seq;
      // the history epoch the persist server read it in
      const epoch = (err as any)?.oversizedEpoch;
      if (typeof epoch == "number") (err as any).oversizedHistoryEpoch = epoch;
    }
    return err;
  };

  private resolveCanonicalSyncIdentityPath = async (
    path: string,
  ): Promise<string> => {
    const fs = this.fs as any;
    if (typeof fs?.canonicalSyncIdentityPath === "function") {
      try {
        const canonical = await fs.canonicalSyncIdentityPath(path);
        if (typeof canonical === "string" && canonical.length > 0) {
          return canonical;
        }
      } catch {
        // Older file servers may not expose this helper yet.
      }
    }
    if (typeof fs?.realpath === "function") {
      try {
        const canonical = await fs.realpath(path);
        if (typeof canonical === "string" && canonical.length > 0) {
          return canonical;
        }
      } catch {
        // Keep the original path if the backend cannot canonicalize it.
      }
    }
    return path;
  };

  private canonicalizeFsIdentity = reuseInFlight(async (): Promise<void> => {
    if (
      this.opts.string_id !== undefined ||
      this.opts.syncIdentityPathIsCanonical
    ) {
      return;
    }
    const canonicalPath = await this.resolveCanonicalSyncIdentityPath(
      this.path,
    );
    if (canonicalPath === this.syncPath) {
      return;
    }
    this.syncPath = canonicalPath;
    this.string_id = schema.client_db.sha1(this.project_id, canonicalPath);
  });

  /* Set this user's cursors to the given locs. */
  setCursorLocsNoThrottle = async (
    // locs is 'any' and not any[] because of a codemirror syntax highlighting bug!
    locs: any,
    side_effect: boolean = false,
  ) => {
    if (!this.cursors) {
      // Cursor updates are transient presence hints. Editors may still emit a
      // final throttled update while a document is opening or closing without
      // cursor support, so there is nothing useful to fail here.
      return;
    }
    if (!this.isReady()) {
      return;
    }
    if (!this.patchflowReady()) {
      return;
    }
    void this.ensureCurrentClientIdentity();
    const now = this.client.server_time();
    if (!side_effect || now >= this.cursor_last_time) {
      this.cursor_last_time = now;
    }
    this.requirePatchflowSession().updateCursors(locs);
  };

  set_cursor_locs: typeof this.setCursorLocsNoThrottle = throttle(
    this.setCursorLocsNoThrottle,
    CURSOR_THROTTLE_MS,
    {
      leading: true,
      trailing: true,
    },
  );

  private init_document_activity_interval = (): void => {
    if (this.document_activity_interval == null) {
      this.document_activity_interval = 60 * 1000;
    }

    if (!this.document_activity_interval || !this.client.is_browser()) {
      // document_activity_interval has to be nonzero, and we only do
      // this for browser user.
      return;
    }

    const document_activity = async () => {
      await delay(100); // wait a little so my_patches and gets updated.
      // We ONLY count this and record that the file was
      // edited if there was an actual change record in the
      // patches log, by this user, since last time.
      let user_is_active: boolean = false;
      for (const patchId in this.my_patches) {
        if (new Date(this.patchTime(patchId)) > this.last_user_change) {
          user_is_active = true;
          break;
        }
      }
      if (!user_is_active) {
        return;
      }
      this.last_user_change = new Date();
      this.client.mark_file?.({
        project_id: this.project_id,
        path: this.path,
        action: "edit",
        ttl: this.document_activity_interval,
      });
    };
    this.throttled_document_activity = throttle(
      document_activity,
      this.document_activity_interval,
      {
        leading: true,
      },
    );

    this.on("user-change", this.throttled_document_activity as any);
  };

  isClosed = () => (this.state ?? "closed") == "closed";
  isReady = () => this.state == "ready";
  is_live_connected = () => this.liveConnected;

  debug_live_connection_state = () => {
    const tableState = (table: any) => ({
      table: table?.table,
      state: table?.get_state?.(),
      recoveryState: table?.getRecoveryState?.(),
      hasUncommittedChanges: table?.has_uncommitted_changes?.(),
      dstreamRecoveryState: table?.dstream?.getRecoveryState?.(),
      dkvRecoveryState: table?.dkv?.getRecoveryState?.(),
    });
    return {
      path: this.path,
      syncPath: this.syncPath,
      state: this.state,
      liveConnected: this.liveConnected,
      tables: this.connectedTables().map(tableState),
    };
  };

  private set_state = (state: State): void => {
    this.state = state;
    this.refreshLiveConnectionState();
    this.emit(state);
  };

  get_state = (): State => {
    return this.state;
  };

  get_project_id = (): string => {
    return this.project_id;
  };

  get_path = (): string => {
    return this.path;
  };

  get_string_id = (): string => {
    return this.string_id;
  };

  get_my_user_id = (): number => {
    return this.my_user_id != null ? this.my_user_id : 1;
  };

  private assert_not_closed(desc: string): void {
    if (this.state === "closed") {
      //console.trace();
      throw Error(`must not be closed -- ${desc}`);
    }
  }

  set_doc = (doc: Document, exit_undo_mode: boolean = true): void => {
    if (doc.is_equal(this.doc)) {
      // no change.
      return;
    }
    if (exit_undo_mode) this.exit_undo_mode();
    // console.log(`sync-doc.set_doc("${doc.to_str()}")`);
    this.markLocalUnsavedChange();
    this.doc = doc;

    // debounced, so don't immediately alert, in case there are many
    // more sets comming in the same loop:
    this.emit_change_debounced();
  };

  // Convenience function to avoid having to do
  // get_doc and set_doc constantly.
  set = (x: any): void => {
    this.assert_is_ready("set");
    this.set_doc(this.doc.set(x));
  };

  delete = (x?: any): void => {
    this.assert_is_ready("delete");
    this.set_doc(this.doc.delete(x));
  };

  get = (x?: any): any => {
    this.assert_is_ready("get");
    return this.doc.get(x);
  };

  get_one(x?: any): any {
    this.assert_is_ready("get_one");
    return this.doc.get_one?.(x);
  }

  // Return underlying document, or undefined if document
  // hasn't been set yet.
  get_doc = (): Document => {
    if (this.doc == null) {
      throw Error("doc must be set");
    }
    return this.doc;
  };

  // Set the document to the given string. If it is an editor's value, pass
  // the value it was derived from as base (see draftBase), so that only the
  // editor's own changes are applied: text that reached this document but not
  // the editor is then kept rather than deleted.
  from_str = (value: string, opts?: { base?: string }): void => {
    // console.log(`sync-doc.from_str("${value}")`);
    this.markLocalUnsavedChange();
    this.doc = this._from_str(value);
    this.draftBase = opts?.base != null ? this._from_str(opts.base) : undefined;
  };

  // The local draft rebased onto the committed document.
  private rebaseDraftOnto = (
    draft: Document,
    committed: Document,
  ): Document => {
    const draftBase = this.draftBase;
    if (draftBase == null) {
      return rebaseLocalDocument({ base: this.last, draft, committed });
    }
    if (draftBase.is_equal(draft)) return committed;
    const merge3 = this.patchflowCodec?.merge3;
    if (merge3 != null) {
      // Exact three-way merge from the draft's base: the draft's changes are
      // applied once, never relocated onto similar text.
      const result = merge3(draftBase as any, draft as any, committed as any);
      syncDebug("syncdoc:rebase", () => ({
        path: this.path,
        base: draftBase.to_str(),
        draft: draft.to_str(),
        committed: committed.to_str(),
        merged: (result as any).to_str(),
      }));
      return result as any;
    }
    return rebaseLocalDocument({ base: draftBase, draft, committed });
  };

  // Return string representation of this doc,
  // or exception if not yet ready.
  to_str = (): string => {
    if (this.doc == null) {
      throw Error("doc must be set");
    }
    return this.doc.to_str();
  };

  count = (): number => {
    return this.doc.count();
  };

  // Version of the document at a given point in time; if no
  // time specified, gives the version right now.
  // If not fully initialized, will throw exception.
  version = (time?: PatchId): Document => {
    return this.requirePatchflowSession().value({ time }) as Document;
  };

  /* Compute version of document if the patches at the given times
     were simply not included.  This is a building block that is
     used for implementing undo functionality for client editors. */
  version_without = (without_times: PatchId[]): Document => {
    return this.requirePatchflowSession().value({
      withoutTimes: without_times,
    }) as Document;
  };

  // Revert document to what it was at the given point in time.
  // There doesn't have to be a patch at exactly that point in
  // time -- if there isn't it just uses the patch before that
  // point in time.
  revert = (time: PatchId): void => {
    this.set_doc(this.version(time));
  };

  /* Undo/redo public api.
  Calling this.undo and this.redo returns the version of
  the document after the undo or redo operation, and records
  a commit changing to that.
  The first time calling this.undo switches into undo
  state in which additional
  calls to undo/redo move up and down the stack of changes made
  by this user during this session.

  Call this.exit_undo_mode() to exit undo/redo mode.

  Undo and redo *only* impact changes made by this user during
  this session.  Other users edits are unaffected, and work by
  this same user working from another browser tab or session is
  also unaffected.

  Finally, undo of a past patch by definition means "the state
  of the document" if that patch was not applied.  The impact
  of undo is NOT that the patch is removed from the patch history.
  Instead, it records a new patch that is what would have happened
  had we replayed history with the patches being undone not there.

  Doing any set_doc explicitly exits undo mode automatically.
  */
  undo = (): Document => {
    this.assert_is_ready("undo");
    // the old graph may hold the new epoch's seed (see handlePatchflowChange)
    if (this.historyTransition != null) return this.doc!;
    const session = this.requirePatchflowSession();
    this.ensurePatchflowLiveDocCommitted();
    this.undo_mode = true;
    const prev = session.getDocument() as Document;
    const next = session.undo() as Document;
    this.doc = next;
    this.last = next;
    if (!this.documentsEqual(prev, next)) {
      this.emitUserChange();
      this.emit_change();
    }
    return next;
  };

  redo = (): Document => {
    this.assert_is_ready("redo");
    if (this.historyTransition != null) return this.doc!;
    const session = this.requirePatchflowSession();
    this.undo_mode = true;
    const prev = session.getDocument() as Document;
    const next = session.redo() as Document;
    this.doc = next;
    this.last = next;
    if (!this.documentsEqual(prev, next)) {
      this.emitUserChange();
      this.emit_change();
    }
    return next;
  };

  in_undo_mode = (): boolean => {
    return this.undo_mode;
  };

  exit_undo_mode = (): void => {
    if (!this.undo_mode) {
      return;
    }
    this.undo_mode = false;
    if (this.patchflowReady()) {
      this.patchflowSession?.resetUndo();
    }
  };

  // If the live doc differs from patchflow's current doc, commit it so undo/redo
  // can step over the unsaved change.
  private ensurePatchflowLiveDocCommitted(): void {
    if (!this.patchflowReady() || this.patchflowSession == null) {
      return;
    }
    try {
      const committed =
        (this.patchflowSession as any).getCommittedDocument?.() ??
        this.patchflowSession.getDocument();
      if (!this.documentsEqual(committed as Document, this.doc)) {
        this.commitWithPatchflow({ allowDuplicate: false });
      }
    } catch {
      // ignore -- patchflow session not yet ready
    }
  }

  // account_id of the user who made the edit at
  // the given point in time.
  account_id = (time: PatchId): string | undefined => {
    this.assert_is_ready("account_id");
    const patch = this.patchflowPatch(time);
    if (patch?.file) {
      return this.project_id;
    }
    return this.users[this.user_id(time)];
  };

  // Integer index of user who made the edit at given
  // point in time.
  user_id = (time: PatchId): number => {
    const patch = this.patchflowPatch(time);
    if (patch == null) {
      throw new Error(`no patch at time ${time}`);
    }
    return patch.userId ?? 0;
  };

  private getDocumentMetadataState = (): Map<string, any> => {
    if (this.syncstring_table != null) {
      const t = this.syncstring_table.get_one();
      if (t != null) {
        return t;
      }
    }
    const dstream = (this.patches_table as any)?.dstream;
    if (
      typeof dstream?.getMetadata === "function" &&
      typeof dstream?.getCheckpoint === "function"
    ) {
      const rawMetadata = dstream.getMetadata();
      const metadata =
        rawMetadata != null &&
        typeof rawMetadata === "object" &&
        !Array.isArray(rawMetadata)
          ? (rawMetadata as PatchDocMetadataV1)
          : undefined;
      const checkpoint = dstream.getCheckpoint(LATEST_SNAPSHOT_CHECKPOINT) as
        | { seq: number; data?: { patchId?: string } }
        | undefined;
      this.setSyncMetadataState({ metadata, checkpoint });
    }
    return this.syncMetadata ?? Map();
  };

  // Compatibility shim for older tests and callers that still probe the
  // legacy syncstring state directly.
  private syncstring_table_get_one = (): Map<string, any> => {
    return this.getDocumentMetadataState();
  };

  private normalizedUsers = (users?: string[]): string[] => {
    const normalized = [FILESYSTEM_CLIENT_ID];
    for (const user of users ?? []) {
      if (user == null || user === FILESYSTEM_CLIENT_ID) {
        continue;
      }
      if (!normalized.includes(user)) {
        normalized.push(user);
      }
    }
    return normalized;
  };

  private rawClientId = (): string | undefined => {
    return this.client?.raw_client_id?.();
  };

  private ensureCurrentClientIdentity = async (): Promise<void> => {
    if (this.client == null) {
      this.my_user_id = 1;
      return;
    }
    const client_id = this.trustedAccountId ?? this.client_id();
    if (!client_id) {
      this.my_user_id = 1;
      return;
    }
    const raw_client_id = this.trustedAccountId
      ? undefined
      : this.rawClientId();
    let users = this.normalizedUsers(this.users);
    let changed = false;
    if (raw_client_id && raw_client_id !== client_id) {
      const rawIdx = users.indexOf(raw_client_id);
      const clientIdx = users.indexOf(client_id);
      if (rawIdx !== -1) {
        if (clientIdx === -1) {
          users[rawIdx] = client_id;
        } else if (rawIdx !== clientIdx) {
          users.splice(rawIdx, 1);
        }
        changed = true;
      }
    }
    let idx = users.indexOf(client_id);
    if (idx === -1) {
      users.push(client_id);
      idx = users.length - 1;
      changed = true;
    } else if (
      idx === FILESYSTEM_USER_ID &&
      users[idx] !== FILESYSTEM_CLIENT_ID
    ) {
      users.push(client_id);
      idx = users.length - 1;
      changed = true;
    }
    this.users = this.normalizedUsers(users);
    this.my_user_id = Math.max(1, idx);
    if (changed) {
      await this.setDocumentMetadata({ users: this.users });
    }
  };

  private patchDocMetadataFromState = (): PatchDocMetadataV1 => {
    return {
      version: PATCH_DOC_METADATA_VERSION,
      users: this.normalizedUsers(this.users),
      snapshot_interval: this.snapshot_interval,
      settings: this.settings?.toJS?.() ?? this.settings,
    };
  };

  private setSyncMetadataState = ({
    metadata,
    checkpoint,
  }: {
    metadata?: PatchDocMetadataV1;
    checkpoint?: { seq: number; data?: { patchId?: string } };
  }): void => {
    this.syncMetadata = fromJS({
      string_id: this.string_id,
      project_id: this.project_id,
      path: this.syncPath,
      users: metadata?.users,
      snapshot_interval: metadata?.snapshot_interval,
      settings: metadata?.settings ?? {},
      last_snapshot: checkpoint?.data?.patchId,
      last_seq: checkpoint?.seq,
    });
  };

  private loadPatchBootstrap = async (): Promise<void> => {
    const dbg = this.dbg("loadPatchBootstrap");
    const dstream = this.dstream();
    const rawMetadata = dstream.getMetadata();
    const metadata =
      rawMetadata != null &&
      typeof rawMetadata === "object" &&
      !Array.isArray(rawMetadata)
        ? (rawMetadata as PatchDocMetadataV1)
        : undefined;
    const checkpoint = dstream.getCheckpoint?.(LATEST_SNAPSHOT_CHECKPOINT) as
      | { seq: number; data?: { patchId?: string } }
      | undefined;

    this.setLastSnapshot(
      typeof checkpoint?.data?.patchId === "string"
        ? checkpoint.data.patchId
        : undefined,
    );
    this.last_seq = checkpoint?.seq;
    this.snapshot_interval =
      metadata?.snapshot_interval ?? DEFAULT_SNAPSHOT_INTERVAL;
    this.settings = fromJS(metadata?.settings ?? {}) as Map<string, any>;
    this.history_epoch = this.metadataHistoryEpoch(this.settings);
    this.users = this.normalizedUsers(metadata?.users);
    this.setSyncMetadataState({ metadata, checkpoint });

    await this.ensureCurrentClientIdentity();

    if (metadata == null || metadata.users == null) {
      dbg("initializing patch metadata for new document");
      await this.setDocumentMetadata({
        users: this.users,
        snapshot_interval: this.snapshot_interval,
        settings: this.settings,
      });
    }

    this.applyPatchWriteHeaders();
    this.emit("metadata-change");
    this.emit("settings-change", this.settings);
  };

  private refreshPatchMetadataFromDStream = async (): Promise<void> => {
    if (
      !this.useConat ||
      this.state === "closed" ||
      this.patches_table == null
    ) {
      return;
    }
    const dstream = this.dstream();
    let rawMetadata;
    try {
      rawMetadata = dstream.getMetadata();
    } catch (err) {
      const message = `${err ?? ""}`.toLowerCase();
      if (
        (this.state as string) === "closed" ||
        message.includes("closed") ||
        message.includes("disconnected")
      ) {
        return;
      }
      throw err;
    }
    const metadata =
      rawMetadata != null &&
      typeof rawMetadata === "object" &&
      !Array.isArray(rawMetadata)
        ? (rawMetadata as PatchDocMetadataV1)
        : undefined;
    let checkpoint;
    try {
      checkpoint = dstream.getCheckpoint?.(LATEST_SNAPSHOT_CHECKPOINT) as
        | { seq: number; data?: { patchId?: string } }
        | undefined;
    } catch (err) {
      const message = `${err ?? ""}`.toLowerCase();
      if (
        (this.state as string) === "closed" ||
        message.includes("closed") ||
        message.includes("disconnected")
      ) {
        return;
      }
      throw err;
    }
    const previousSettings = this.settings;
    const previousHistoryEpoch = this.history_epoch;
    const previousHistoryPurgedAt =
      previousSettings?.get?.("history_purged_at");
    const nextSettings = fromJS(metadata?.settings ?? {}) as Map<string, any>;
    const nextHistoryEpoch = this.metadataHistoryEpoch(nextSettings);
    const nextHistoryPurgedAt = nextSettings?.get?.("history_purged_at");

    this.setLastSnapshot(
      typeof checkpoint?.data?.patchId === "string"
        ? checkpoint.data.patchId
        : undefined,
    );
    this.last_seq = checkpoint?.seq;
    this.snapshot_interval =
      metadata?.snapshot_interval ?? DEFAULT_SNAPSHOT_INTERVAL;
    this.settings = nextSettings;
    this.history_epoch = nextHistoryEpoch;
    this.users = this.normalizedUsers(metadata?.users);
    this.setSyncMetadataState({ metadata, checkpoint });

    const historyEpochIncreased =
      previousHistoryEpoch != null &&
      nextHistoryEpoch != null &&
      nextHistoryEpoch > previousHistoryEpoch;
    const historyPurgeMarkerChanged =
      nextHistoryPurgedAt != null &&
      nextHistoryPurgedAt !== previousHistoryPurgedAt;
    if (
      historyEpochIncreased ||
      (this.isReady() && historyPurgeMarkerChanged)
    ) {
      this.beginHistoryTransition(nextHistoryEpoch, previousHistoryEpoch);
      return;
    }

    this.applyPatchWriteHeaders();

    await this.ensureCurrentClientIdentity();

    this.emit("metadata-change");
    if (!immutableIs(previousSettings, nextSettings)) {
      this.emit("settings-change", nextSettings);
    }
  };

  /* List of patch ids of the versions of this string in the sync
     table that we opened to start editing (so starts with what was
     the most recent snapshot when we started), sorted from oldest to newest. */
  versions = (): PatchId[] => {
    const v = this.patchflowVersions();
    if (v == null) {
      throw new Error("patchflow session not ready");
    }
    return v;
  };

  getHeads = (): PatchId[] => {
    if (!this.patchflowReady() || this.patchflowSession == null) {
      throw new Error("patchflow session not ready");
    }
    return this.patchflowSession.getHeads();
  };

  wallTime = (version: PatchId): number | undefined => {
    const patch = this.patchflowPatch(version);
    return patch?.wall;
  };

  // return time of a patch, which is encoded in the patchid,
  // and is NOT guaranteed to be unique among patches.
  patchTime = (version: PatchId): number => {
    return decodePatchId(version).timeMs;
  };

  // newest version of any non-staging known patch on this client,
  // including ones just made locally.
  newestVersion = (): PatchId | undefined => {
    const v = this.patchflowVersions();
    if (v != null && v.length > 0) {
      return v[v.length - 1];
    }
    return undefined;
  };

  hasVersion = (time: PatchId): boolean => {
    const v = this.patchflowVersions();
    if (v != null) {
      return v.includes(time);
    }
    return false;
  };

  historyFirstVersion = () => {
    const v = this.patchflowVersions();
    if (v != null && v.length > 0) {
      return v[0];
    }
    return;
  };

  historyLastVersion = () => {
    const v = this.patchflowVersions();
    if (v != null && v.length > 0) {
      return v[v.length - 1];
    }
    return;
  };

  historyVersionNumber = (time: PatchId): number | undefined => {
    const patch = this.patchflowPatch(time);
    return patch?.version;
  };

  last_changed = (): number => {
    const v = this.versions();
    const last = v[v.length - 1];
    return last ? decodePatchId(last).timeMs : 0;
  };

  private init_table_close_handlers(): void {
    for (const x of ["syncstring", "patches"]) {
      const t = this[x + "_table"];
      if (t != null) {
        t.on("close", () => this.handleTableClose(x, t));
      }
    }
  }

  private tableCanRecover(table: SyncTable): table is RecoverableSyncTable {
    return isRecoverableSyncTable(table);
  }

  private handleTableClose(tableName: string, table: SyncTable): void {
    if (this.tableCanRecover(table)) {
      const recoveryState = table.getRecoveryState();
      this.dbg("handleTableClose")(
        `${tableName} table closed with recoveryState=${recoveryState}, treating as recoverable disconnect`,
      );
      this.refreshLiveConnectionState();
      void this.recoverNow({
        reason: `${tableName}_table_close`,
      }).catch((err) => {
        this.dbg("handleTableClose")(
          `${tableName} recoverNow after close failed`,
          err,
        );
      });
      return;
    }
    this.dbg("handleTableClose")(
      `${tableName} table closed without recovery support; closing SyncDoc`,
    );
    this.close();
  }

  private tableConnectionStateChanged = (): void => {
    this.refreshLiveConnectionState();
  };

  private registerTableConnectionState(table?: SyncTable): void {
    if (table == null) return;
    table.on("connected", this.tableConnectionStateChanged);
    table.on("disconnected", this.tableConnectionStateChanged);
    table.on("closed", this.tableConnectionStateChanged);
    this.refreshLiveConnectionState();
  }

  private unregisterTableConnectionState(table?: SyncTable): void {
    if (table == null) return;
    table.removeListener("connected", this.tableConnectionStateChanged);
    table.removeListener("disconnected", this.tableConnectionStateChanged);
    table.removeListener("closed", this.tableConnectionStateChanged);
  }

  private connectedTables(): SyncTable[] {
    return [this.syncstring_table, this.patches_table].filter(
      (table): table is SyncTable => table != null,
    );
  }

  private refreshLiveConnectionState(): void {
    const next =
      this.state === "ready" &&
      this.connectedTables().length > 0 &&
      this.connectedTables().every(
        (table) => table.get_state() === "connected",
      );
    if (next === this.liveConnected) {
      return;
    }
    this.liveConnected = next;
    if (this.state === "closed") {
      return;
    }
    this.emit(next ? "connected" : "disconnected");
  }

  // more gentle version -- this can cause the project actions
  // to be *created* etc.
  end = reuseInFlight(async () => {
    if (this.client.is_browser() && this.state == "ready") {
      try {
        await this.save_to_disk();
      } catch (err) {
        // has to be non-fatal since we are closing the document,
        // and of couse we need to clear up everything else.
        // Do nothing here.
      }
    }
    this.close();
  });

  // Close synchronized editing of this string; this stops listening
  // for changes and stops broadcasting changes.
  close = reuseInFlight(async () => {
    if (this.state == "closed") {
      SyncDoc.testInstances.delete(this);
      return;
    }
    const dbg = this.dbg("close");
    dbg("close");

    //
    // SYNC STUFF
    //

    // WARNING: that 'closed' is emitted at the beginning of the
    // close function (before anything async) for the project is
    // assumed in src/packages/project/sync/sync-doc.ts, because
    // that ensures that the moment close is called we lock trying
    // try create the syncdoc again until closing is finished.
    // (This set_state call emits "closed"):
    this.set_state("closed");

    this.emit("close");

    this.stopBackendFsWatch();
    this.client.removeListener("closed", this.close);
    if (this.useConat && this.patches_table != null) {
      const dstream = this.dstream();
      dstream.removeListener("metadata-change", this.patchMetadataChanged);
      dstream.removeListener("checkpoints-change", this.patchMetadataChanged);
    }

    // must be after the emits above, so clients know
    // what happened and can respond.
    this.removeAllListeners();

    if (this.throttled_document_activity != null) {
      // Cancel any pending document-activity calls.
      cancel_scheduled(this.throttled_document_activity);
      (this.throttled_document_activity as any).cancel();
    }

    if (this.emit_change != null) {
      // Cancel any pending change emit calls.
      cancel_scheduled(this.emit_change);
    }
    cancel_scheduled(this.emit_change_debounced);
    cancel_scheduled(this.debouncedStat);
    cancel_scheduled(this.snapshotIfNecessary);
    cancel_scheduled(this.touchProject);
    cancel_scheduled(this.updateHasUnsavedChangesDebounced);

    this.patchflowSession?.close();
    this.cursorPubSub?.close();
    this.cursorPubSub = undefined;

    try {
      await this.closeTables();
      dbg("closeTables -- successfully saved all data to database");
    } catch (err) {
      dbg(`closeTables -- ERROR -- ${err}`);
    }
    // this avoids memory leaks:
    SyncDoc.testInstances.delete(this);
    close(this);

    // after doing that close, we need to keep the state (which just got deleted) as 'closed'
    this.set_state("closed");
    dbg("close done");
  });

  static closeAllForTests = async (): Promise<void> => {
    if (!process.env.COCALC_TEST_MODE) {
      return;
    }
    for (const doc of Array.from(SyncDoc.testInstances)) {
      try {
        await doc.close();
      } catch {
        // best-effort test cleanup only
      }
    }
  };

  private closeTables = async () => {
    this.unregisterTableConnectionState(this.syncstring_table);
    this.unregisterTableConnectionState(this.patches_table);
    await this.syncstring_table?.close();
    await this.patches_table?.close();
    await this.ipywidgets_state?.close();
  };

  private synctable = async (
    query,
    options: any[],
    throttle_changes?: undefined | number,
  ): Promise<SyncTable> => {
    this.assert_not_closed("synctable");
    const dbg = this.dbg("synctable");
    if (!this.useConat && !this.ephemeral && this.persistent) {
      // persistent table in a non-ephemeral syncdoc, so ensure that table is
      // persisted to database (not just in memory).
      options = options.concat([{ persistent: true }]);
    }
    if (this.ephemeral) {
      options.push({ ephemeral: true });
    }
    let synctable;
    let ephemeral = false;
    for (const x of options) {
      if (x.ephemeral) {
        ephemeral = true;
        break;
      }
    }
    if (this.useConat && query.patches) {
      const start_checkpoint = LATEST_SNAPSHOT_CHECKPOINT;
      synctable = await this.client.synctable_conat(query, {
        obj: {
          project_id: this.project_id,
          path: this.syncPath,
        },
        stream: true,
        atomic: true,
        desc: { path: this.syncPath },
        start_checkpoint,
        ephemeral,
        noAutosave: this.noAutosave,
        initPhaseReporter:
          this.makeConatInitPhaseReporter("patches_corestream"),
        ...(this.opts.patchesPersist ?? {}),
      });

      // If the checkpoint is stale or otherwise wrong, fall back to a full load.
      const checkpoint = synctable.dstream.getCheckpoint?.(start_checkpoint);
      if (checkpoint != null) {
        if (!isCompletePatchStream(synctable.dstream)) {
          console.log("updating invalid timetravel -- ", this.path);
          synctable.close();
          synctable = await this.client.synctable_conat(query, {
            obj: {
              project_id: this.project_id,
              path: this.syncPath,
            },
            stream: true,
            atomic: true,
            desc: { path: this.syncPath },
            ephemeral,
            noAutosave: this.noAutosave,
            initPhaseReporter:
              this.makeConatInitPhaseReporter("patches_corestream"),
            // The same routing as the first open: a board's checkpoint repair
            // writes through the board write service.
            ...(this.opts.patchesPersist ?? {}),
          });
          let repaired = false;
          let n = synctable.dstream.length - 1;
          for (; n >= 0; n--) {
            const x = synctable.dstream[n];
            if (x?.is_snapshot) {
              const time = x.time;
              let m = n - 1;
              let last_seq = synctable.dstream.seq(n) ?? 0;
              while (m >= 1) {
                if (synctable.dstream[m].time == time) {
                  last_seq = synctable.dstream.seq(m) ?? last_seq;
                  break;
                }
                m -= 1;
              }
              await synctable.dstream.setCheckpoint({
                name: LATEST_SNAPSHOT_CHECKPOINT,
                seq: last_seq,
                data: { patchId: time },
              });
              repaired = true;
              break;
            }
          }
          if (!repaired) {
            await synctable.dstream.deleteCheckpoint(
              LATEST_SNAPSHOT_CHECKPOINT,
            );
          }
        }
      } else {
        await repairLatestSnapshotCheckpoint(synctable.dstream);
      }
    } else if (this.useConat && query.syncstrings) {
      synctable = await this.client.synctable_conat(query, {
        obj: {
          project_id: this.project_id,
          path: this.syncPath,
        },
        stream: false,
        atomic: false,
        immutable: true,
        desc: { path: this.syncPath },
        ephemeral,
        noAutosave: this.noAutosave,
        initPhaseReporter: this.makeConatInitPhaseReporter(
          "syncstring_corestream",
        ),
      });
    } else if (this.useConat && query.ipywidgets) {
      synctable = await this.client.synctable_conat(query, {
        obj: {
          project_id: this.project_id,
          path: this.syncPath,
        },
        stream: false,
        atomic: true,
        immutable: true,
        // for now just putting a 1-day limit on the ipywidgets table
        // so we don't waste a ton of space.
        config: { max_age: 1000 * 60 * 60 * 24 },
        desc: { path: this.syncPath },
        ephemeral: true, // ipywidgets state always ephemeral
        noAutosave: this.noAutosave,
      });
    } else if (this.useConat && (query.eval_inputs || query.eval_outputs)) {
      synctable = await this.client.synctable_conat(query, {
        obj: {
          project_id: this.project_id,
          path: this.syncPath,
        },
        stream: false,
        atomic: true,
        immutable: true,
        config: { max_age: 5 * 60 * 1000 },
        desc: { path: this.syncPath },
        ephemeral: true, // eval state is always ephemeral
        noAutosave: this.noAutosave,
      });
    } else if (this.useConat) {
      synctable = await this.client.synctable_conat(query, {
        obj: {
          project_id: this.project_id,
          path: this.syncPath,
        },
        stream: false,
        atomic: true,
        immutable: true,
        desc: { path: this.syncPath },
        ephemeral,
        noAutosave: this.noAutosave,
      });
    } else {
      // only used for unit tests and the ephemeral messaging composer
      if (this.client.synctable_ephemeral == null) {
        throw Error(`client does not support sync properly`);
      }
      synctable = await this.client.synctable_ephemeral(
        this.project_id,
        query,
        options,
        throttle_changes,
      );
    }
    // We listen and log error events.  This is useful because in some settings, e.g.,
    // in the project, an eventemitter with no listener for errors, which has an error,
    // will crash the entire process.
    synctable.on("error", (error) => dbg("ERROR", error));
    return synctable;
  };

  private init_syncstring_table = async (): Promise<void> => {
    const query = {
      syncstrings: [
        {
          string_id: this.string_id,
          project_id: this.project_id,
          path: this.syncPath,
          users: null,
          last_snapshot: null,
          last_seq: null,
          snapshot_interval: null,
          save: null,
          last_active: null,
          init: null,
          read_only: null,
          last_file_change: null,
          doctype: null,
          archived: null,
          settings: null,
        },
      ],
    };
    const dbg = this.dbg("init_syncstring_table");

    dbg("getting table...");
    this.syncstring_table = await this.synctable(query, []);
    this.registerTableConnectionState(this.syncstring_table);
    dbg("handling the first update...");
    await this.handle_syncstring_update();
    this.syncstring_table.on("change", this.handle_syncstring_update);
    this.syncstring_table.on("change", this.update_has_unsaved_changes);
  };

  // Used for internal debug logging
  private dbg = (_f: string = ""): Function => {
    if (DEBUG) {
      return (...args) => {
        logger.debug(this.path, _f, ...args);
      };
    } else {
      return (..._args) => {};
    }
  };

  private initAll = async (): Promise<void> => {
    //const t0 = Date.now();
    if (this.state !== "init") {
      throw Error("connect can only be called in init state");
    }
    const log = this.dbg("initAll");

    log("patchflow, cursors, ipywidgets");
    this.assert_not_closed(
      "initAll -- before init patchflow, cursors, ipywidgets",
    );
    this.emitOpenPhase("canonicalize_identity_start");
    await this.canonicalizeFsIdentity();
    this.emitOpenPhase("canonicalize_identity_done", {
      prevalidated: this.opts.syncIdentityPathIsCanonical === true,
      string_id_provided: this.opts.string_id !== undefined,
    });
    if (!this.useConat) {
      this.emitOpenPhase("syncstring_table_start");
      await this.init_syncstring_table();
      this.emitOpenPhase("syncstring_table_done");
    }
    if (this.cursors) {
      void this.getCursorPresenceAdapter().catch((err) => {
        this.dbg("getCursorPresenceAdapter")(
          `prewarm failed: ${err?.message ?? err}`,
        );
      });
    }
    const useBackendFsWatch = this.shouldUseBackendFsWatch();
    // For watched doctypes, let backend sync-fs prime patchflow before we open
    // the client session. No-watch doctypes such as chats must open patchflow
    // first so existing live rows remain authoritative over stale disk state.
    if (useBackendFsWatch) {
      this.emitOpenPhase("backend_fs_watch_start");
      await this.startBackendFsWatch();
      this.emitOpenPhase("backend_fs_watch_done");
      this.emitOpenPhase("backend_fs_reconcile_start");
      await this.reconcileBackendFsState();
      this.emitOpenPhase("backend_fs_reconcile_done");
    }
    void this.refreshInitialDiskBaseline();
    this.emitOpenPhase("patchflow_init_start");
    await this.init_patchflow();
    this.emitOpenPhase("patchflow_init_done");
    if (!useBackendFsWatch) {
      await this.seedNoWatchDocFromDiskIfEmpty();
    }
    if (this.cursors) {
      this.emitOpenPhase("cursors_start");
      await Promise.all([this.init_cursors()]);
      this.emitOpenPhase("cursors_done");
    } else {
      await Promise.all([this.init_cursors()]);
    }
    this.assert_not_closed(
      "initAll -- successful init patchflow, cursors, and ipywidgets",
    );

    this.init_table_close_handlers();
    this.assert_not_closed("initAll -- successful init_table_close_handlers");

    log("document_activity_interval");
    this.init_document_activity_interval();

    this.emit("init");
    this.assert_not_closed("initAll -- after waiting until fully ready");

    this.update_has_unsaved_changes();
    log("done");
    //console.log("initAll: done", Date.now() - t0);
  };

  private assert_table_is_ready = (table: string): void => {
    const t = this[table + "_table"]; // not using string template only because it breaks codemirror!
    const ready =
      typeof t?.is_ready === "function"
        ? t.is_ready()
        : t?.get_state?.() === "connected";
    if (!ready) {
      throw Error(
        `Table ${table} must be initialized.  string_id=${this.string_id}`,
      );
    }
  };

  assert_is_ready = (desc: string): void => {
    if (!this.isReady()) {
      throw Error(`must be ready -- ${desc}`);
    }
  };

  wait_until_ready = async (): Promise<void> => {
    this.assert_not_closed("wait_until_ready");
    if (this.state !== ("ready" as State)) {
      // wait for a state change to ready.
      await once(this, "ready");
    }
  };

  wait_until_live_connected = async (): Promise<void> => {
    this.assert_not_closed("wait_until_live_connected");
    await this.wait_until_ready();
    if (this.liveConnected) {
      return;
    }
    await once(this, "connected");
  };

  recoverNow = async (
    opts: {
      epoch?: number;
      force?: boolean;
      priority?: "foreground" | "background";
      reason?: string;
    } = {},
  ): Promise<void> => {
    this.assert_not_closed("recoverNow");
    await Promise.all(
      this.connectedTables().map(async (table) => {
        const recoverNow = (table as any).recoverNow;
        if (typeof recoverNow === "function") {
          await recoverNow.call(table, opts);
        }
      }),
    );
    this.refreshLiveConnectionState();
  };

  /* Calls wait for the corresponding patches SyncTable, if
     it has been defined.  If it hasn't been defined, it waits
     until it is defined, then calls wait.  Timeout only starts
     when patches_table is already initialized.
  */
  wait = async (until: Function, timeout: number = 30): Promise<any> => {
    await this.wait_until_ready();
    //console.trace("SYNC WAIT -- start...");
    const result = await wait({
      obj: this,
      until,
      timeout,
      change_event: "change",
    });
    //console.trace("SYNC WAIT -- got it!");
    return result;
  };

  private patch_table_query = (cutoff?: PatchId) => {
    const query = {
      string_id: this.string_id,
      is_snapshot: false, // only used with conat
      time: cutoff ? { ">=": cutoff } : null,
      wall: null,
      // compressed format patch as a JSON *string*
      patch: null,
      // integer id of user (maps to the metadata.users array)
      user_id: null,
      // (optional) a snapshot at this point in time
      snapshot: null,
      // info about sequence number, count, etc. of this snapshot
      seq_info: null,
      parents: null,
      version: null,
      meta: null,
      hash: null,
      merge_parent: null,
      merge_patch: null,
      inexact: null,
    };
    if (this.doctype.patch_format != null) {
      (query as any).format = this.doctype.patch_format;
    }
    return query;
  };

  private setLastSnapshot(last_snapshot?: PatchId) {
    // Keep the cached latest-snapshot patch id normalized in one place.
    this.last_snapshot = last_snapshot;
  }

  private init_patchflow = async (): Promise<void> => {
    this.assert_not_closed("init_patchflow - start");
    const dbg = this.dbg("init_patchflow");
    dbg();

    dbg("opening the table...");
    this.emitOpenPhase("patches_table_start");
    const query = {
      patches: [
        this.patch_table_query(this.useConat ? undefined : this.last_snapshot),
      ],
    };
    try {
      this.patches_table = await this.synctable(query, [], this.patch_interval);
    } catch (err) {
      throw this.markOversizedHistory(err);
    }
    this.registerTableConnectionState(this.patches_table);
    this.emitOpenPhase("patches_table_done");
    this.assert_not_closed("init_patchflow -- after making synctable");
    if (this.useConat) {
      await this.loadPatchBootstrap();
      const dstream = this.dstream();
      // pending patches are sized by what they hold (bounded history plan
      // H1b-2: the transition's admission bound)
      dstream.setPendingSizeOf?.(
        (mesg: any) =>
          (mesg?.patch?.length ?? 0) + (mesg?.snapshot?.length ?? 0) + 256,
      );
      dstream.on("metadata-change", this.patchMetadataChanged);
      dstream.on("checkpoints-change", this.patchMetadataChanged);
    }
    this.applyPatchWriteHeaders();

    this.updateHasUnsavedChangesDebounced = debounce(
      this.update_has_unsaved_changes,
      500,
      { leading: true, trailing: true },
    );

    this.patches_table.on("has-uncommitted-changes", (val) => {
      this.emit("has-uncommitted-changes", val);
    });

    this.on("change", () => {
      this.updateHasUnsavedChangesDebounced?.();
    });

    this.emitOpenPhase("patchflow_session_start");
    await this.initPatchflowSession();
    this.emitOpenPhase("patchflow_session_done");

    // Ensure doc/last are initialized even if listeners run before ready state.
    if (this.patchflowReady() && this.patchflowSession != null) {
      try {
        const doc = this.patchflowSession.getDocument() as Document;
        this.last = this.doc = doc;
      } catch {
        // session will emit change after init and set doc/last then.
      }
    }

    dbg("done");
  };

  private initPatchflowSession = reuseInFlight(async (): Promise<void> => {
    if (this.patchflowSession || this.patches_table == null) {
      return;
    }
    const dbg = this.dbg("initPatchflowSession");
    this.patchflowCodec = this.buildPatchflowCodec();
    this.patchflowStore = this.createPatchflowStore();
    const presenceAdapter = await this.getCursorPresenceAdapter();
    // close() only closes a session that already exists, so one created
    // after it would outlive the document.
    if (this.isClosed()) throw Error("closed while opening");
    const session = new PatchflowSession({
      codec: this.patchflowCodec,
      patchStore: this.patchflowStore,
      clock: () => this.client?.server_time().valueOf() ?? Date.now(),
      userId: this.my_user_id ?? 1,
      docId: this.string_id,
      presenceAdapter,
    });
    this.patchflowSession = session;
    if (this.cursors) {
      session.on("cursors", this.handlePatchflowCursors);
    }
    session.on("patch", this.handlePatchflowPatch);
    session.on("change", this.handlePatchflowChange);
    session.on("inconsistency", this.handleInconsistency);
    try {
      await session.init();
    } catch (err) {
      session.close();
      this.patchflowSession = undefined;
      this.patchflowStore = undefined;
      this.patchflowCodec = undefined;
      throw err;
    }
    if (this.isClosed()) {
      // close() ran during init, which can subscribe even after the
      // session was closed; close it again now that init is done.
      session.close();
      throw Error("closed while opening");
    }
    dbg("patchflow session initialized");

    // check if file was deleted
    const v = this.patchflowVersions();
    if (v?.length) {
      const mostRecentPatch = this.patchflowSession.getPatch(v[v.length - 1]);
      if (mostRecentPatch?.meta?.deleted || this.isDeleted) {
        this.emitDeleted();
      }
    }

    this.emit("patchflow-ready");
  });

  // The open prewarms this and the patchflow session uses it later, so
  // remember the adapter: creating another would open a second channel.
  private getCursorPresenceAdapter = (): Promise<
    PatchflowPresenceAdapter | undefined
  > => {
    this.cursorPresenceAdapter ??= this.openCursorPresenceAdapter();
    return this.cursorPresenceAdapter;
  };

  private openCursorPresenceAdapter = async (): Promise<
    PatchflowPresenceAdapter | undefined
  > => {
    if (!this.cursors) {
      return;
    }
    this.emitOpenPhase("cursor_presence_start");
    try {
      return await this.createCursorPresenceAdapter();
    } catch (err) {
      // Cursor presence is optional.  In particular, an otherwise valid
      // document session may not have permission to subscribe to cursors.
      // Editing and Patchflow must still initialize in that case.
      logger.warn("cursor presence unavailable; continuing without it", {
        err: `${err}`,
        project_id: this.project_id,
        path: this.path,
      });
      // A later call (e.g. the patchflow session after a failed prewarm)
      // may try again.
      this.cursorPresenceAdapter = undefined;
      return;
    } finally {
      this.emitOpenPhase("cursor_presence_done");
    }
  };

  init_ipywidgets = reuseInFlight(async () => {
    if (this.ipywidgets_state != null) {
      return;
    }
    const dbg = this.dbg("init_ipywidgets");
    dbg("creating the ipywidgets state table, and waiting for init");
    this.ipywidgets_state = new IpywidgetsState(
      this,
      this.client,
      this.synctable,
    );
    await this.ipywidgets_state.init();
    dbg("done");
  });

  private init_cursors = async () => {
    const dbg = this.dbg("init_cursors");
    if (!this.cursors) {
      dbg("done -- do not care about cursors for this syncdoc.");
      return;
    }
    await this.initPatchflowSession();
    if (!this.patchflowReady()) {
      await once(this, "patchflow-ready");
    }
    if (!this.patchflowReady()) {
      dbg("patchflow not ready; skipping cursor setup");
      return;
    }
    this.cursor_map = this.buildCursorMap();
    this.patchflowSession?.on("cursors", this.handlePatchflowCursors);
    this.handlePatchflowCursors();
    dbg("done");
  };

  private handlePatchflowCursors = (states?: any[]): void => {
    const snapshots =
      states ??
      this.cursorSnapshots ??
      this.requirePatchflowSession().cursors();
    this.cursorSnapshots = snapshots;
    let map = Map<string, any>();
    for (const state of snapshots) {
      if (state.docId && state.docId !== this.string_id) {
        continue;
      }
      const key =
        this.cursorStateAccountId(state) ??
        state.clientId ??
        `client-${state.time}`;
      const userId = this.cursorStateUserId(state);
      const time = new Date(state.time);
      map = map.set(
        key,
        fromJS({
          user_id: userId,
          locs: state.locs,
          time,
        }),
      );
      this.emit("cursor_activity", key);
    }
    this.cursor_map = map;
  };

  private buildCursorMap = ({
    maxAge = 60 * 1000,
    excludeSelf = "always",
    states,
  }: {
    maxAge?: number;
    excludeSelf?: "always" | "never" | "heuristic";
    states?: any[];
  } = {}): Map<string, any> => {
    if (!this.patchflowReady()) {
      return Map();
    }
    const session = this.requirePatchflowSession();
    const account_id: string = this.client_id();
    const snapshots =
      states ?? this.cursorSnapshots ?? session.cursors({ ttlMs: maxAge });
    let map = Map<string, any>();
    const now = Date.now();
    for (const state of snapshots) {
      if (state.docId && state.docId !== this.string_id) {
        continue;
      }
      const key =
        this.cursorStateAccountId(state) ??
        state.clientId ??
        `client-${state.time}`;
      const userId = this.cursorStateUserId(state);
      const time = new Date(state.time);
      map = map.set(
        key,
        fromJS({
          user_id: userId,
          locs: state.locs,
          time,
        }),
      );
    }
    if (map.has(account_id) && excludeSelf != "never") {
      const ourTime = map.getIn([account_id, "time"], 0);
      if (
        excludeSelf == "always" ||
        (excludeSelf == "heuristic" &&
          this.cursor_last_time >= new Date(ourTime as number))
      ) {
        map = map.delete(account_id);
      }
    }
    for (const [client_id, value] of map as any) {
      const time = value.get("time");
      if (time == null) {
        map = map.delete(client_id);
        continue;
      }
      if (maxAge && Math.abs(now - time.valueOf()) >= maxAge) {
        map = map.delete(client_id);
        continue;
      }
      if (time >= now + 10 * 1000) {
        map = map.delete(client_id);
        continue;
      }
    }
    return map;
  };

  /* Returns *immutable* Map from account_id to list
     of cursor positions, if cursors are enabled.

     - excludeSelf: do not include our own cursor
     - maxAge: only include cursors that have been updated with maxAge ms from now.
  */
  get_cursors = ({
    maxAge = 60 * 1000,
    excludeSelf = "always",
  }: {
    maxAge?: number;
    excludeSelf?: "always" | "never" | "heuristic";
  } = {}): Map<string, any> => {
    this.assert_not_closed("get_cursors");
    if (!this.cursors) {
      throw Error("cursors are not enabled");
    }
    this.cursor_map = this.buildCursorMap({ maxAge, excludeSelf });
    return this.cursor_map;
  };

  /* Set settings map.  Used for custom configuration just for
     this one file, e.g., overloading the spell checker language.
   */
  set_settings = async (obj): Promise<void> => {
    this.assert_is_ready("set_settings");
    await this.setDocumentMetadata({
      settings: obj,
    });
  };

  client_id = () => {
    return this.client.client_id();
  };

  // get settings object
  get_settings = (): Map<string, any> => {
    this.assert_is_ready("get_settings");
    return this.getDocumentMetadataState().get("settings", Map());
  };

  /*
  Commits and saves current live syncdoc to backend.

  Function only returns when there is nothing needing
  saving.

  Save any changes we have as a new patch.
  */
  save = reuseInFlight(async () => {
    const dbg = this.dbg("save");
    dbg();
    if (this.historyTransition != null) {
      return;
    }
    // We just keep trying while syncdoc is ready and there
    // are changes that have not been saved (due to this.doc
    // changing during the while loop!).
    if (this.doc == null || this.last == null || this.state == "closed") {
      // EXPECTED: this happens after document is closed
      // There's nothing to do regarding save if the table is
      // already closed.  Note that we *do* have to save when
      // the table is init stage, since the project has to
      // record the newly opened version of the file to the
      // database! See
      //    https://github.com/sagemathinc/cocalc/issues/4986
      return;
    }
    if (this.client?.is_deleted(this.path, this.project_id)) {
      dbg("not saving because deleted");
      return;
    }
    // Compute any patches.
    while (!this.doc.is_equal(this.last)) {
      dbg("something to save");
      this.emitUserChange();
      if (!this.commit()) {
        // Could not commit (e.g., patchflow not ready)
        break;
      }
      if (!this.isReady()) {
        return;
      }
    }
    if (!this.isReady()) {
      // above async waits could have resulted in state change.
      return;
    }

    // Ensure all patches are saved to backend.
    // We do this after the above, so that creating the newest patch
    // happens immediately on save, which makes it possible for clients
    // to save current state without having to wait on an async, which is
    // useful to ensure specific undo points (e.g., right before a paste).
    await this.patches_table.save();
  });

  // Remote patches received but not applied to this.doc yet: they are
  // applied in a microtask (see the patchflow subscribe adapter).
  private remotePatchesPending = false;
  // Table keys of snapshot records ignored because their patch was before the
  // loaded range (see isSnapshotRecordBeforeLoadedRange). A snapshot record
  // has its own key, which loading more history does not change, so it is fed
  // to patchflow again here once its patch is loaded.
  private snapshotRecordsBeforeLoadedRange = new Set<any>();

  // The proof that value, about to be written to the file, is this document's
  // value including every patch with seq at most receivedThroughSeq.  Called
  // in the same synchronous step that captured value, so no remote patch
  // can be applied in between.  Undefined when that cannot be proven, e.g.,
  // remote patches are still to be applied or there is an uncommitted draft;
  // the file is still written, without a proof.
  private captureFileProof = (value: string): FileProof | undefined => {
    if (
      this.remotePatchesPending ||
      this.patchflowSession == null ||
      !this.patchflowReady() ||
      (this.patchflowSession as any).needsMoreHistory?.() ||
      this.doc == null ||
      this.last == null ||
      !this.documentsEqual(this.doc, this.last)
    ) {
      return undefined;
    }
    let seq: number;
    try {
      const dstream = this.dstream();
      if (typeof dstream.receivedThroughSeq !== "function") return undefined;
      seq = dstream.receivedThroughSeq();
    } catch {
      return undefined;
    }
    return fileProof({ value, epoch: this.history_epoch ?? 0, seq });
  };

  // After the bytes of proof were written: record it, if this is still the
  // epoch it belongs to.  A failure only means there is no proof.
  private publishFileProof = async (proof?: FileProof): Promise<void> => {
    if (
      proof == null ||
      this.isClosed() ||
      (this.history_epoch ?? 0) !== proof.epoch
    ) {
      return;
    }
    try {
      await this.dstream().setCheckpoint({
        name: SAVED_FILE_CHECKPOINT,
        seq: proof.seq,
        data: {
          sha256: proof.sha256,
          bytes: proof.bytes,
          epoch: proof.epoch,
        },
      });
    } catch (err) {
      this.dbg("publishFileProof")(`${err}`);
    }
  };

  private dstream = () => {
    // @ts-ignore -- in general patches_table might not be a conat one still,
    // or at least dstream is an internal implementation detail.
    const { dstream } = this.patches_table ?? {};
    if (dstream == null) {
      throw Error("dstream must be defined");
    }
    return dstream;
  };

  // return the conat-assigned sequence number of the oldest entry in the
  // patch list with the given time, and also:
  //    - prev_seq -- the sequence number of previous patch before that, for use in "load more"
  //    - index -- the global index of the entry with the given time.
  private conatSnapshotSeqInfo = (
    time: PatchId,
  ): { seq: number; prev_seq?: number } => {
    const dstream = this.dstream();
    const normalizePatchId = (raw: unknown): PatchId => {
      if (typeof raw === "string") return raw;
      if (typeof raw === "number") return legacyPatchId(raw);
      // fall back to string coercion to avoid crashing on unexpected old rows
      return legacyPatchId(new Date(String(raw)).valueOf());
    };
    // seq = actual sequence number of the message with the patch that we're
    // snapshotting at -- i.e., at time
    let seq: number | undefined = undefined;
    // prev_seq = sequence number of patch of *previous* snapshot, if there is a previous one.
    // This is needed for incremental loading of more history.
    let prev_seq: number | undefined;
    let i = 0;
    for (const mesg of dstream.getAll()) {
      const mesgTime = normalizePatchId(mesg.time);
      if (mesg.is_snapshot && comparePatchId(mesgTime, time) < 0) {
        // the seq field of this message has the actual sequence number of the patch
        // that was snapshotted, along with the index of that patch.
        prev_seq = mesg.seq_info.seq;
      }
      if (seq === undefined && mesgTime === time) {
        seq = dstream.seq(i);
      }
      i += 1;
    }
    if (seq == null) {
      const timeMs = decodePatchId(time).timeMs;
      throw Error(
        `unable to find message with time '${time}'=${new Date(timeMs)}`,
      );
    }
    return { seq, prev_seq };
  };

  /* Create and store in the database a snapshot of the state
     of the string at the given point in time.  This should
     be the time of an existing patch.

     The point of a snapshot is that if you load all patches recorded
     >= this point in time, then you don't need any earlier ones to
     reconstruct the document, since otherwise, why have the snapshot at
     all, as it does not good.  Due to potentially long offline users
     putting old data into history, this can fail. However, in the usual
     case we should never record a snapshot with this bad property.
  */
  private snapshot = reuseInFlight(async (time: PatchId): Promise<void> => {
    let user_id = this.my_user_id ?? 0;
    let snapshot: string | undefined;
    if (!this.patchflowReady() || this.patchflowSession == null) {
      throw new Error("patchflow session not ready");
    }
    const p = this.patchflowSession.getPatch(time);
    if (p == null) {
      throw Error(`no patch at time ${time}`);
    }
    if (p.isSnapshot && p.snapshot != null) {
      return;
    }
    user_id = p.userId ?? user_id;
    // Never pass on a value that differs from what the patch's author
    // recorded: every client opening the document later would start from it.
    // ("unknown": a patch from before hashes, or no exact value.)
    if ((this.patchflowSession as any).verifyValue?.(time) === "mismatch") {
      throw Error(
        `not making a snapshot at ${time}: value differs from its hash`,
      );
    }
    const doc = this.patchflowSession.value({ time }) as any;
    snapshot = (doc?.to_str?.() ?? doc?.toString?.() ?? `${doc}`) as string;
    if (snapshot == null) {
      throw Error("unable to compute snapshot");
    }
    const seq_info = this.conatSnapshotSeqInfo(time);
    const wall = p.wall ?? decodePatchId(time).timeMs;
    const obj = {
      size: snapshot.length,
      string_id: this.string_id,
      time,
      wall,
      is_snapshot: true,
      snapshot,
      user_id,
      seq_info,
      // The hash its author recorded, so a client that starts from this
      // snapshot can check it (see Patch.hash).
      ...(p.hash != null ? { hash: p.hash } : {}),
      __checkpoint: {
        name: LATEST_SNAPSHOT_CHECKPOINT,
        seq: seq_info.seq,
        data: { patchId: time },
      },
    };
    this.patches_table.set(obj);
    await this.patches_table.save();
    if (!this.isReady()) {
      return;
    }

    const last_seq = seq_info.seq;
    this.setLastSnapshot(time);
    this.last_seq = last_seq;
    this.setSyncMetadataState({
      metadata: this.patchDocMetadataFromState(),
      checkpoint: {
        seq: last_seq,
        data: { patchId: time },
      },
    });
  });

  // Have a snapshot every this.snapshot_interval patches, except
  // for the very last interval.  Throttle so we don't try to make
  // snapshots too frequently, as making them is always optional and
  // now part of the UI.
  private snapshotIfNecessary = throttle(async (): Promise<void> => {
    if (this.get_state() !== "ready") {
      // especially important due to throttle
      return;
    }
    const dbg = this.dbg("snapshotIfNecessary");
    const max_size = Math.floor(1.2 * MAX_FILE_SIZE_MB * 1000000);
    const interval = this.snapshot_interval;
    dbg("check if we need to make a snapshot:", { interval, max_size });
    if (!this.patchflowReady()) {
      return;
    }
    if ((this.patchflowSession as any).needsMoreHistory?.()) {
      // Values may be approximations until more history is loaded (see
      // loadHistoryIfNeeded), and a snapshot would pass an approximation on to
      // every client that opens the document later.
      dbg("not making a snapshot: more history is needed for exact values");
      return;
    }
    const candidate = this.patchflowSnapshotCandidate(interval, max_size);
    const time =
      candidate == null
        ? undefined
        : snapshotTimeAvoidingMismatch(this.patchflowSession, candidate);
    if (candidate != null && time !== candidate) {
      dbg("candidate value differs from its hash; using a later patch", {
        candidate,
        time,
      });
    }
    if (time != null) {
      dbg("yes, try to make a snapshot at time", time);
      try {
        await this.snapshot(time);
      } catch (err) {
        // this is expected to happen sometimes, e.g., when sufficient information
        // isn't known about the stream of patches.
        console.log(
          `(expected) WARNING: client temporarily unable to make a snapshot of ${this.path}  -- ${err}`,
        );
      }
    } else {
      dbg("no need to make a snapshot yet");
    }
  }, 60000);

  /*- x - patch object
    - patch: if given will be used as an actual patch
        instead of x.patch, which is a JSON string.
  */
  private processPatch = ({
    x,
    patch,
    size: size0,
  }: {
    x: Map<string, any>;
    patch?: any;
    size?: number;
  }): Patch => {
    const normalizePatchId = (raw: unknown): PatchId => {
      if (typeof raw === "string") {
        // Backward compat: some old patches used ISO timestamps for `time`.
        if (!raw.includes("_")) {
          const legacy = new Date(raw).valueOf();
          if (!Number.isNaN(legacy)) {
            return legacyPatchId(legacy);
          }
        }
        return raw;
      }
      if (typeof raw === "number") {
        return legacyPatchId(raw);
      }
      throw new Error(`invalid patch time: raw='${raw}'`);
    };

    const time = normalizePatchId(x.get("time"));
    const wall: number = x.get("wall") ?? decodePatchId(time).timeMs;
    const user_id: number = x.get("user_id");
    let parents: PatchId[] = (x.get("parents")?.toJS() ?? []).map(
      normalizePatchId,
    );
    let size: number;
    const is_snapshot = x.get("is_snapshot");
    if (is_snapshot) {
      size = x.get("snapshot")?.length ?? 0;
    } else {
      if (patch == null) {
        /* Do **NOT** use misc.from_json, since we definitely
         do not want to unpack ISO timestamps as Date,
         since patch just contains the raw patches from
         user editing.  This was done for a while, which
         led to horrific bugs in some edge cases...
         See https://github.com/sagemathinc/cocalc/issues/1771
      */
        if (x.has("patch")) {
          const p: string = x.get("patch");
          patch = JSON.parse(p);
          size = p.length;
        } else {
          patch = [];
          size = 2;
        }
      } else {
        const p = x.get("patch");
        size = p?.length ?? size0 ?? JSON.stringify(patch).length;
      }
    }

    const obj: Patch = {
      time,
      wall,
      user_id,
      patch,
      size,
      is_snapshot,
      parents,
      version: x.get("version"),
      file: x.get("file"),
    };
    if (x.has("meta")) {
      const m = x.get("meta");
      obj.meta = Map.isMap(m) ? m.toJS() : m;
    }
    const hash = x.get("hash");
    if (typeof hash === "string") {
      obj.hash = hash;
    }
    const mergeParent = x.get("merge_parent");
    const mergePatch = x.get("merge_patch");
    if (mergeParent != null && typeof mergePatch === "string") {
      // A JSON string, like patch (see above).
      obj.merge_parent = normalizePatchId(mergeParent);
      obj.merge_patch = JSON.parse(mergePatch);
    }
    if (x.get("inexact") === true) {
      obj.inexact = true;
    }
    if (is_snapshot) {
      obj.snapshot = x.get("snapshot"); // this is a string
      obj.seq_info = x.get("seq_info")?.toJS();
      if (obj.snapshot == null || obj.seq_info == null) {
        console.warn("WARNING: message = ", x.toJS());
        throw Error(
          `message with is_snapshot true must also set snapshot and seq_info fields -- time=${time}`,
        );
      }
    }
    return obj;
  };

  /* Return all patches with time such that
            time0 <= time <= time1;
     If time0 undefined then sets time0 equal to time of last_snapshot.
     If time1 undefined treated as +oo.
  */
  private toPatchflowEnvelope = (p: Patch): PatchEnvelope => {
    return {
      time: p.time,
      wall: p.wall,
      patch: p.patch,
      parents: p.parents,
      userId: p.user_id,
      size: p.size,
      version: p.version,
      isSnapshot: p.is_snapshot,
      snapshot: p.snapshot,
      seqInfo: p.seq_info,
      file: p.file,
      meta: p.meta,
      hash: p.hash,
      mergeParent: p.merge_parent,
      mergePatch: p.merge_patch,
      ...(p.inexact ? { inexact: true } : {}),
    };
  };

  private patchFromEnvelope = (env: PatchEnvelope): Patch => {
    return {
      time: env.time,
      wall: env.wall,
      patch: env.patch as CompressedPatch | undefined,
      parents: env.parents,
      user_id: env.userId ?? 0,
      size: env.size ?? 0,
      version: env.version,
      is_snapshot: env.isSnapshot,
      snapshot: env.snapshot,
      seq_info: env.seqInfo,
      file: env.file,
      meta: env.meta,
      hash: env.hash,
      merge_parent: env.mergeParent,
      merge_patch: env.mergePatch as CompressedPatch | undefined,
      ...(env.inexact ? { inexact: true } : {}),
    };
  };

  private buildPatchflowCodec = (): DocCodec => {
    return {
      fromString: (text: string) => this._from_str(text),
      toString: (doc: Document) =>
        (doc as any).to_str ? (doc as any).to_str() : doc.toString(),
      applyPatch: (doc: Document, patch: unknown) => {
        // console.log("applyPatch", patch);
        return ((doc as any).apply_patch ?? doc.applyPatch).call(doc, patch);
      },
      applyPatchBatch: (doc: Document, patches: unknown[]) => {
        const applyBatch =
          (doc as any).apply_patch_batch ?? (doc as any).applyPatchBatch;
        if (typeof applyBatch === "function") {
          return applyBatch.call(doc, patches);
        }
        return (patches as unknown[]).reduce<Document>(
          (current, patch) =>
            ((current as any).apply_patch ?? current.applyPatch).call(
              current,
              patch,
            ),
          doc,
        );
      },
      makePatch: (a: Document, b: Document) =>
        ((a as any).make_patch ?? a.makePatch).call(a, b),
      // Exact values for text: every patch applies to the value of its own
      // parents and concurrent heads merge three-way from their common
      // ancestor, instead of fuzzy-applying concurrent patches to each other's
      // text (which could delete or duplicate the wrong text).
      ...(this.doctype.type === "string"
        ? {
            merge3: stringMerge3<Document>(this._from_str, (doc) =>
              doc.to_str(),
            ),
          }
        : this.doctype.type === "db" &&
            this.doctype.opts?.primary_keys?.length > 0
          ? {
              merge3: dbMerge3<Document>(
                this._from_str,
                (doc) => doc.to_str(),
                {
                  primaryKeys: this.doctype.opts?.primary_keys,
                  stringCols: this.doctype.opts?.string_cols ?? [],
                },
              ),
            }
          : {}),
    };
  };

  private async createCursorPresenceAdapter(): Promise<
    PatchflowPresenceAdapter | undefined
  > {
    if (!this.cursors) {
      return;
    }
    if (this.useConat && this.client.pubsub_conat) {
      const table = await this.client.pubsub_conat({
        project_id: this.project_id,
        path: this.syncPath,
        name: "cursors",
      });
      if (this.state == "closed") {
        table.close();
        return;
      }
      this.cursorPubSub = table;
      const listeners: Array<(state: unknown, clientId: string) => void> = [];
      table.on("change", (obj: any) => {
        const account_id = this.cursorStateAccountId(obj);
        const userId = this.cursorStateUserId(obj);
        const clientId = account_id ?? `cursor-${userId ?? "unknown"}`;
        const state =
          obj != null && typeof obj === "object"
            ? {
                ...obj,
                accountId: account_id ?? obj.accountId ?? obj.account_id,
                userId: obj.userId ?? obj.user_id,
              }
            : obj;
        for (const fn of listeners) {
          fn(state, clientId);
        }
      });
      return {
        publish: (state: unknown) => {
          if (state == null || typeof state !== "object") {
            table.set(state);
            return;
          }
          const accountId = this.client_id();
          const rawClientId = this.rawClientId();
          const nextState: Record<string, unknown> = {
            ...(state as Record<string, unknown>),
          };
          if (accountId && accountId !== rawClientId) {
            nextState.accountId = accountId;
            nextState.account_id = accountId;
          } else {
            delete nextState.accountId;
            delete nextState.account_id;
          }
          table.set(nextState);
        },
        subscribe: (onState: (state: unknown, clientId: string) => void) => {
          listeners.push(onState);
          return () => {
            const i = listeners.indexOf(onState);
            if (i >= 0) {
              listeners.splice(i, 1);
            }
          };
        },
      };
    }
    // Fallback for test/fake clients: shared in-memory presence.
    return fallbackCursorPresence;
  }

  private cursorStateUserId = (state: any): number | undefined => {
    if (typeof state?.userId === "number") {
      return state.userId;
    }
    if (typeof state?.user_id === "number") {
      return state.user_id;
    }
    return;
  };

  private cursorStateAccountId = (state: any): string | undefined => {
    if (typeof state?.accountId === "string" && state.accountId.length > 0) {
      return state.accountId;
    }
    if (typeof state?.account_id === "string" && state.account_id.length > 0) {
      return state.account_id;
    }
    const userId = this.cursorStateUserId(state);
    if (userId != null) {
      const user = this.users[userId];
      if (user && user !== this.rawClientId()) {
        return user;
      }
    }
    return;
  };

  private createPatchflowStore = (): PatchflowPatchStore => {
    return {
      loadInitial: async () => {
        const raw = this.get_patches();
        const patches = raw.map((p) => this.toPatchflowEnvelope(p));
        return { patches, hasMore: !this.patchesHaveFullHistory(raw) };
      },
      append: (env: PatchEnvelope) => {
        try {
          if (this.patches_table == null) {
            throw new Error(
              "patches_table must be initialized before appending",
            );
          }
          const patch = this.patchFromEnvelope(env);
          const obj: any = {
            string_id: this.string_id,
            time: patch.time,
            wall: patch.wall ?? patch.time,
            user_id: patch.user_id ?? this.my_user_id,
            is_snapshot: patch.is_snapshot ?? false,
            parents: patch.parents ?? [],
            version:
              patch.version ??
              (this.patchflowReady() && this.patchflowSession
                ? this.patchflowSession.versions().length + 1
                : 1),
          };
          if (patch.file) {
            obj.file = true;
          }
          if (!patch.is_snapshot) {
            obj.patch = JSON.stringify(patch.patch ?? []);
          } else {
            obj.snapshot = patch.snapshot;
            obj.seq_info = patch.seq_info;
          }
          if (patch.meta != null) {
            obj.meta = patch.meta;
          }
          if (patch.hash != null) {
            obj.hash = patch.hash;
          }
          if (patch.merge_parent != null && patch.merge_patch != null) {
            obj.merge_parent = patch.merge_parent;
            obj.merge_patch = JSON.stringify(patch.merge_patch);
          }
          if (patch.inexact) {
            obj.inexact = true;
          }
          if (this.doctype.patch_format != null) {
            obj.format = this.doctype.patch_format;
          }
          this.my_patches[patch.time] = obj;
          let x = this.patches_table.set(obj, "none");
          if (x == null) {
            x = fromJS(obj);
          }
          this.processPatch({ x, patch: patch.patch, size: patch.size });
        } catch (err) {
          console.warn("patchflow append failed", err);
          console.warn(env);
          throw err;
        }
      },
      subscribe: (onEnvelope: (env: PatchEnvelope) => void) => {
        if (this.patches_table == null) {
          throw new Error(
            "patches_table must be initialized before subscribing",
          );
        }
        let closed = false;
        let scheduled = false;
        const pendingKeys = new Set<any>();
        const flush = () => {
          scheduled = false;
          try {
            if (closed || pendingKeys.size === 0) {
              pendingKeys.clear();
              return;
            }
            const keys = [...pendingKeys];
            pendingKeys.clear();
            this.applyPatchflowRemoteEnvelopes(
              this.patchflowEnvelopesForKeys(keys),
              onEnvelope,
            );
          } finally {
            // patches that arrived while this one applied are scheduled again
            this.remotePatchesPending = scheduled;
          }
        };
        const handler = (keys: any[]) => {
          for (const key of keys ?? []) {
            pendingKeys.add(key);
          }
          if (!scheduled) {
            scheduled = true;
            this.remotePatchesPending = true;
            queueMicrotask(flush);
          }
        };
        const table: any = this.patches_table;
        table.on("change", handler);
        return () => {
          closed = true;
          pendingKeys.clear();
          this.remotePatchesPending = false;
          if (table?.off) {
            table.off("change", handler);
          } else if (table?.removeListener) {
            table.removeListener("change", handler);
          }
        };
      },
    };
  };

  private patchflowEnvelopesForKeys = (keys: any[]): PatchEnvelope[] => {
    if (this.patches_table == null) {
      return [];
    }
    const envs: PatchEnvelope[] = [];
    const firstLoadedSeq = this.firstLoadedSeq();
    for (const key of keys ?? []) {
      let x = this.patches_table.get(key);
      if (x == null) {
        continue;
      }
      if (!Map.isMap(x)) {
        x = fromJS(x);
      }
      const p = this.processPatch({ x });
      if (p == null) continue;
      if (isSnapshotRecordBeforeLoadedRange(p, firstLoadedSeq)) {
        this.snapshotRecordsBeforeLoadedRange.add(key);
      } else {
        this.snapshotRecordsBeforeLoadedRange.delete(key);
        envs.push(this.toPatchflowEnvelope(p));
      }
    }
    // Ignored snapshot records whose patch is loaded now, in the same batch.
    for (const key of [...this.snapshotRecordsBeforeLoadedRange]) {
      let x = this.patches_table.get(key);
      if (x == null) {
        this.snapshotRecordsBeforeLoadedRange.delete(key);
        continue;
      }
      if (!Map.isMap(x)) {
        x = fromJS(x);
      }
      const p = this.processPatch({ x });
      if (p == null) {
        this.snapshotRecordsBeforeLoadedRange.delete(key);
      } else if (!isSnapshotRecordBeforeLoadedRange(p, firstLoadedSeq)) {
        this.snapshotRecordsBeforeLoadedRange.delete(key);
        envs.push(this.toPatchflowEnvelope(p));
      }
    }
    return envs;
  };

  private applyPatchflowRemoteEnvelopes = (
    envs: PatchEnvelope[],
    onEnvelope: (env: PatchEnvelope) => void,
  ): void => {
    if (envs.length === 0) {
      return;
    }
    if (envs.length > 1 && this.applyPatchflowRemoteBatch(envs)) {
      this.loadHistoryIfNeeded();
      return;
    }
    for (const env of envs) {
      onEnvelope(env);
    }
    this.loadHistoryIfNeeded();
  };

  // A document is loaded from its latest snapshot and the patches after the
  // snapshotted patch. Patches made concurrently with the snapshotted patch but
  // appended before it are in neither, and later patches can build on them
  // (e.g. a merge, or a client that was offline); then the exact value needs
  // older history, and without it this client would show something different
  // from everyone else. Load more history until it does not.
  private loadHistoryIfNeeded = (): void => {
    if (
      this.isClosed() ||
      this.patchflowSession == null ||
      !this.patchflowReady() ||
      this.get_state() !== "ready" ||
      this.hasFullHistory()
    ) {
      return;
    }
    if (!(this.patchflowSession as any).needsMoreHistory?.()) return;
    void this.loadHistoryForExactValue();
  };

  private loadHistoryForExactValue = reuseInFlight(async (): Promise<void> => {
    const needsMore = () =>
      !this.isClosed() &&
      this.patchflowSession != null &&
      !this.hasFullHistory() &&
      !!(this.patchflowSession as any).needsMoreHistory?.();
    try {
      // Normally one step back (to the previous snapshot) is enough.
      for (let i = 0; i < 3 && needsMore(); i++) {
        if (!(await this.loadMoreHistory())) break;
      }
      if (needsMore()) {
        await this.loadMoreHistory({ all: true });
      }
    } catch (err) {
      this.dbg("loadHistoryForExactValue")(`failed: ${err}`);
    }
  });

  private applyPatchflowRemoteBatch = (envs: PatchEnvelope[]): boolean => {
    if (this.patchflowSession == null) {
      return false;
    }
    this.patchflowSession.applyRemoteBatch(envs);
    return true;
  };

  private get_patches = (): Patch[] => {
    this.assert_table_is_ready("patches");

    // m below is an immutable map with keys the string that
    // is the JSON version of the primary key
    // [string_id, timestamp, user_number].
    let m: Map<string, any> | undefined = this.patches_table.get();
    if (m == null) {
      // won't happen because of assert above.
      throw Error("patches_table must be initialized");
    }
    if (!Map.isMap(m)) {
      // TODO: this is just for proof of concept NATS!!
      m = fromJS(m);
    }
    const v: Patch[] = [];
    const firstLoadedSeq = this.firstLoadedSeq();
    m.forEach((x, key) => {
      try {
        const p = this.processPatch({ x });
        if (p == null) return;
        if (isSnapshotRecordBeforeLoadedRange(p, firstLoadedSeq)) {
          this.snapshotRecordsBeforeLoadedRange.add(key);
        } else {
          return v.push(p);
        }
      } catch (err) {
        console.warn("Dropping a patch - ", err);
      }
    });
    v.sort(patch_cmp);
    return v;
  };

  // Stream position of the oldest loaded message (loading more history moves
  // it back before the older messages are processed).
  private firstLoadedSeq = (): number | undefined => {
    try {
      const seq = this.dstream()?.seq?.(0);
      return typeof seq === "number" ? seq : undefined;
    } catch {
      return undefined;
    }
  };

  private patchesHaveFullHistory = (patches: Patch[]): boolean => {
    return patchesHaveFullHistoryFromPatches(patches);
  };

  hasFullHistory = (): boolean => {
    if (this.patchflowReady() && this.patchflowSession != null) {
      try {
        return this.patchflowSession.hasFullHistory();
      } catch {
        // fall back to local computation below
      }
    }
    try {
      return this.patchesHaveFullHistory(this.get_patches());
    } catch {
      return false;
    }
  };

  // returns true if there may be additional history to load
  // after loading this. return false if definitely done.
  loadMoreHistory = async ({
    all,
  }: {
    // if true, loads all history
    all?: boolean;
  } = {}): Promise<boolean> => {
    if (this.hasFullHistory() || this.ephemeral || !this.patchflowReady()) {
      return false;
    }
    let dstream: any;
    try {
      dstream = this.dstream();
    } catch {
      return false;
    }
    const start_seq = all ? 0 : this.patchflowPrevSeqForMoreHistory();
    if (start_seq == null) {
      return false;
    }
    await dstream.load({ start_seq });
    if (start_seq <= 1) {
      this.markPatchflowFullHistory();
    }
    return start_seq > 1;
  };

  show_history = (opts = {}): void => {
    this.requirePatchflowSession().summarizeHistory({
      includeSnapshots: true,
      milliseconds: (opts as any)?.milliseconds ?? true,
      trunc: (opts as any)?.trunc ?? 80,
      log: (opts as any)?.log ?? console.log,
      formatDoc: (doc) => (doc as any).to_str?.() ?? `${doc}`,
    });
  };

  set_snapshot_interval = async (n: number): Promise<void> => {
    await this.setDocumentMetadata({
      snapshot_interval: n,
    });
  };

  get_last_save_to_disk_time = (): Date => {
    return this.last_save_to_disk_time;
  };

  private handle_syncstring_update = async (): Promise<void> => {
    if (this.state === "closed") {
      return;
    }
    const dbg = this.dbg("handle_syncstring_update");
    dbg();

    const data = this.syncstring_table_get_one();
    const x: any = data != null ? data.toJS() : undefined;

    dbg(JSON.stringify(x));
    if (x == null || x.users == null) {
      dbg("new_document");
      await this.handle_syncstring_update_new_document();
    } else {
      dbg("update_existing");
      await this.handle_syncstring_update_existing_document(x, data);
    }
  };

  private handle_syncstring_update_new_document = async (): Promise<void> => {
    this.emit("load-time-estimate", { type: "new", time: 1 });
    this.setLastSnapshot();
    this.last_seq = undefined;
    this.snapshot_interval =
      schema.SCHEMA.syncstrings.user_query?.get?.fields.snapshot_interval ??
      DEFAULT_SNAPSHOT_INTERVAL;

    this.my_user_id = 1;
    this.users = [FILESYSTEM_CLIENT_ID];
    const client_id = this.client.client_id();
    if (client_id != null) {
      this.users.push(client_id);
    }
    const obj = {
      string_id: this.string_id,
      project_id: this.project_id,
      path: this.syncPath,
      last_snapshot: this.last_snapshot,
      users: this.users,
      doctype: JSON.stringify(this.doctype),
      last_active: this.client.server_time(),
    };
    this.syncstring_table?.set(obj);
    await this.syncstring_table?.save();
    this.settings = Map();
    this.history_epoch = undefined;
    this.applyPatchWriteHeaders();
    this.emit("metadata-change");
    this.emit("settings-change", this.settings);
  };

  private metadataHistoryEpoch = (
    settings: Map<string, any>,
  ): number | undefined => {
    const raw = settings?.get?.("history_epoch");
    return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
  };

  private patchWriteHeaders = (): { history_epoch: number } | undefined => {
    if (
      this.history_epoch != null &&
      typeof this.history_epoch === "number" &&
      Number.isFinite(this.history_epoch)
    ) {
      return { history_epoch: this.history_epoch };
    }
    return;
  };

  private applyPatchWriteHeaders = (): void => {
    const headers = this.patchWriteHeaders();
    const table = this.patches_table as any;
    if (typeof table?.setWriteHeaders === "function") {
      table.setWriteHeaders(headers);
    }
  };

  private handle_syncstring_update_existing_document = async (
    x: any,
    data: Map<string, any>,
  ): Promise<void> => {
    if (this.state === "closed") {
      return;
    }

    if (this.path == null) {
      this.emit("load-time-estimate", { type: "ready", time: 1 });
    }
    this.setLastSnapshot(x.last_snapshot);
    this.last_seq = x.last_seq;
    this.snapshot_interval = x.snapshot_interval ?? DEFAULT_SNAPSHOT_INTERVAL;
    this.users = x.users ?? [FILESYSTEM_USER_ID];
    if (x.project_id) {
      // @ts-ignore
      this.project_id = x.project_id;
    }
    if (this.opts.string_id === undefined && x.string_id) {
      this.string_id = x.string_id;
    }
    if (x.path) {
      this.syncPath = x.path;
    }

    const settings = data.get("settings", Map());
    const previous_history_epoch = this.history_epoch;
    const previous_history_purged_at =
      this.settings?.get?.("history_purged_at");
    const current_history_epoch = this.metadataHistoryEpoch(settings);
    const current_history_purged_at = settings?.get?.("history_purged_at");
    this.history_epoch = current_history_epoch;

    const history_epoch_increased =
      previous_history_epoch != null &&
      current_history_epoch != null &&
      current_history_epoch > previous_history_epoch;
    const history_purge_marker_changed =
      current_history_purged_at != null &&
      current_history_purged_at !== previous_history_purged_at;
    if (
      history_epoch_increased ||
      (this.isReady() && history_purge_marker_changed)
    ) {
      this.beginHistoryTransition(
        current_history_epoch,
        previous_history_epoch,
      );
      return;
    }

    this.applyPatchWriteHeaders();

    if (settings !== this.settings) {
      this.settings = settings;
      this.emit("settings-change", settings);
    }

    await this.ensureCurrentClientIdentity();
    this.emit("metadata-change");
  };

  is_read_only = (): boolean => {
    if (this.canWriteToPath != null) {
      return !this.canWriteToPath;
    }
    if (this.stats) {
      return isReadOnlyForCurrentUser(this.stats, this.userIdentity);
    } else {
      return false;
    }
  };

  private stats?: Stats;
  private canWriteToPath?: boolean;
  private userIdentity?: {
    uid: number;
    gids: Set<number>;
  };

  private detectUserIdentity = reuseInFlight(
    async (): Promise<{ uid: number; gids: Set<number> } | undefined> => {
      const proc = (globalThis as any)?.process;
      if (typeof proc?.getuid === "function") {
        const uid = Number(proc.getuid());
        const gids = new Set<number>();
        if (typeof proc?.getgid === "function") {
          const gid = Number(proc.getgid());
          if (!Number.isNaN(gid)) gids.add(gid);
        }
        if (typeof proc?.getgroups === "function") {
          for (const groupId of proc.getgroups()) {
            const num = Number(groupId);
            if (!Number.isNaN(num)) gids.add(num);
          }
        }
        if (!Number.isNaN(uid)) {
          return { uid, gids };
        }
      }

      // Browser-side fallback: read effective uid/gids from procfs via fs API.
      try {
        const status = await this.fs.readFile("/proc/self/status", "utf8");
        if (typeof status === "string") {
          const uidLine = status.match(
            /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m,
          );
          const gidLine = status.match(
            /^Gid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m,
          );
          const groupsLine = status.match(/^Groups:\s+(.+)$/m);
          const effectiveUid = Number(uidLine?.[2] ?? uidLine?.[1]);
          const effectiveGid = Number(gidLine?.[2] ?? gidLine?.[1]);
          if (!Number.isNaN(effectiveUid)) {
            const gids = new Set<number>();
            if (!Number.isNaN(effectiveGid)) {
              gids.add(effectiveGid);
            }
            const groups = groupsLine?.[1]?.trim().split(/\s+/) ?? [];
            for (const group of groups) {
              const num = Number(group);
              if (!Number.isNaN(num)) gids.add(num);
            }
            return { uid: effectiveUid, gids };
          }
        }
      } catch {}

      // Last-resort fallback: infer uid/gid from /home, which maps to HOME in CoCalc.
      try {
        const homeStats = (await this.fs.stat("/home")) as Stats;
        return {
          uid: Number(homeStats.uid),
          gids: new Set<number>([Number(homeStats.gid)]),
        };
      } catch {
        return undefined;
      }
    },
  );

  private statWriteAccess = async (): Promise<boolean | undefined> => {
    // In tests we use minimal clients with stubbed path_access that
    // do not model real filesystem permissions.
    if (isTestClient(this.client)) return undefined;
    if (typeof this.client?.path_access !== "function") return undefined;
    return await new Promise<boolean | undefined>((resolve) => {
      try {
        this.client.path_access({
          path: this.path,
          mode: "w",
          cb: (result) => {
            // Compatibility: some sync clients (esp. browser/conat adapters)
            // use boolean callbacks, but some return constant true as a stub.
            // In that case, fall back to stat-based permission checks.
            if (typeof result === "boolean") {
              resolve(undefined);
              return;
            }
            resolve(result == null);
          },
        });
      } catch {
        resolve(undefined);
      }
    });
  };

  stat = async (): Promise<Stats> => {
    if (this.opts.noSaveToDisk) {
      throw Error("the noSaveToDisk options is set");
    }
    const prevReadOnly = this.is_read_only();
    const prevStats = this.stats;
    this.stats = (await this.fs.stat(this.path)) as Stats;
    const identity = await this.detectUserIdentity();
    if (identity != null) {
      this.userIdentity = identity;
    }
    const canWriteToPath = await this.statWriteAccess();
    if (canWriteToPath != null) {
      this.canWriteToPath = canWriteToPath;
    }
    this.isDeleted = false; // definitely not deleted since we just stat' it
    if (
      prevStats?.mode != this.stats.mode ||
      prevReadOnly != this.is_read_only()
    ) {
      // used by clients to track read-only state.
      this.emit("metadata-change");
    }
    return this.stats;
  };

  debouncedStat = debounce(
    async () => {
      try {
        await this.stat();
      } catch {}
    },
    STAT_DEBOUNCE,
    { leading: true, trailing: true },
  );

  wait_until_read_only_known = async (): Promise<void> => {
    await until(
      async () => {
        if (this.isClosed()) {
          return true;
        }
        if (this.stats != null) {
          return true;
        }
        try {
          await this.stat();
          return true;
        } catch {}
        return false;
      },
      { min: 3000 },
    );
  };

  /* Returns true if the current live version of this document has
     a different hash than the version mostly recently saved to disk.
     I.e., if there are changes that have not yet been **saved to
     disk**.  See the other function has_uncommitted_changes below
     for determining whether there are changes that haven't been
     commited to the database yet.  Returns *undefined* if
     initialization not even done yet. */
  has_unsaved_changes = (): boolean | undefined => {
    if (!this.isReady()) {
      return;
    }
    return this.hasUnsavedChanges();
  };

  private refreshInitialDiskBaseline = async (): Promise<void> => {
    const requestId = ++this.diskBaselineRequestId;
    try {
      const exists = await this.fs.exists(this.path);
      if (this.isClosed() || requestId !== this.diskBaselineRequestId) {
        return;
      }
      if (!exists) {
        this.valueOnDisk = undefined;
        this.diskMissingOnLoad = true;
        this.update_has_unsaved_changes();
        return;
      }
      this.diskMissingOnLoad = false;
      const rawValueOnDisk = await this.fs.readFile(this.path, "utf8");
      const valueOnDisk =
        typeof rawValueOnDisk === "string"
          ? rawValueOnDisk
          : rawValueOnDisk.toString("utf8");
      if (this.isClosed() || requestId !== this.diskBaselineRequestId) {
        return;
      }
      this.valueOnDisk = valueOnDisk;
      this.update_has_unsaved_changes();
    } catch (err) {
      if (this.isClosed() || requestId !== this.diskBaselineRequestId) {
        return;
      }
      const code =
        typeof err === "object" && err != null && "code" in err
          ? (err as any).code
          : undefined;
      if (code === "ENOENT") {
        this.valueOnDisk = undefined;
        this.diskMissingOnLoad = true;
        this.update_has_unsaved_changes();
      }
    }
  };

  // Returns hash of last version that we saved to disk or undefined
  // if we haven't saved yet.
  // NOTE: this does not take into account saving by another client
  // anymore; it used to, but that made things much more complicated.
  hash_of_saved_version = (): number | undefined => {
    if (!this.isReady() || this.valueOnDisk == null || this.isDeleted) {
      return;
    }
    return hash_string(this.valueOnDisk);
  };

  /* Return hash of the live version of the document,
     or undefined if the document isn't loaded yet.
     (TODO: write faster version of this for syncdb, which
     avoids converting to a string, which is a waste of time.) */
  hash_of_live_version = (): number | undefined => {
    if (!this.isReady()) {
      return;
    }
    return hash_string(this.doc.to_str());
  };

  /* Return true if there are changes to this syncstring that
     have not been committed to the database (with the commit
     acknowledged).  This does not mean the file has been
     written to disk; however, it does mean that it safe for
     the user to close their browser.
  */
  // Whether the live document has changes not committed as a patch yet.
  hasDraft = (): boolean =>
    this.doc != null && this.last != null && !this.doc.is_equal(this.last);

  has_uncommitted_changes = (): boolean => {
    if (!this.isReady()) {
      return false;
    }
    return this.patches_table.has_uncommitted_changes();
  };

  private patchflowReady = (): boolean => {
    return (
      this.patchflowSession != null &&
      this.patchflowStore != null &&
      this.patchflowCodec != null
    );
  };

  private requirePatchflowSession = (): PatchflowSession => {
    if (!this.patchflowReady() || this.patchflowSession == null) {
      throw new Error("patchflow session is not initialized");
    }
    return this.patchflowSession;
  };

  private patchflowPatch = (time: PatchId): PatchEnvelope | undefined => {
    if (!this.patchflowReady() || this.patchflowSession == null) return;
    try {
      return this.patchflowSession.getPatch(time);
    } catch {
      return;
    }
  };

  private patchflowVersions = (): PatchId[] | undefined => {
    if (!this.patchflowReady() || this.patchflowSession == null) return;
    try {
      return this.patchflowSession.versions();
    } catch {
      return;
    }
  };

  // This client computed a value that differs from the one the patch's author
  // recorded (patchflow checks values against Patch.hash): the document is
  // not what everyone else sees. Never silent: log it, report it to the
  // server's client error log, and emit "inconsistency" (for tests, tools and
  // agents working on the document).
  private inconsistencyCount = 0;
  private handleInconsistency = (e: Inconsistency): void => {
    this.inconsistencyCount += 1;
    const info = {
      ...e,
      path: this.path,
      project_id: this.project_id,
      string_id: this.string_id,
      count: this.inconsistencyCount,
      hasFullHistory: this.hasFullHistory(),
    };
    syncDebug("syncdoc:inconsistency", () => info);
    if (this.inconsistencyCount <= 10) {
      console.warn("sync: document value differs from its recorded hash", info);
    }
    this.dbg("inconsistency")(JSON.stringify(info));
    this.emit("inconsistency", info);
    if (this.inconsistencyCount <= 3) {
      try {
        this.client?.log_error?.({
          project_id: this.project_id,
          path: this.path,
          string_id: this.string_id,
          error: { type: "sync-inconsistency", ...info },
        });
      } catch {
        // reporting must never break editing
      }
    }
  };

  // Number of inconsistencies detected in this session (see
  // handleInconsistency).
  getInconsistencyCount = (): number => this.inconsistencyCount;

  private handlePatchflowPatch = (env: PatchEnvelope): void => {
    if (env.meta?.deleted) {
      this.emitDeleted();
    } else if (this.isDeleted) {
      this.isDeleted = false;
    }
    if (env.file && !env.meta?.deleted) {
      this.emit("filesystem-change", env);
    }
  };

  private handlePatchflowChange = (doc: Document): void => {
    if (this.historyTransition != null) {
      // The history was reset: whatever reaches the old graph now (the new
      // epoch's seed, its patches) must not replace this tab's value or its
      // committed base, which is what the recovery copy saves (CORR-H1B2-2).
      return;
    }
    const committed = doc as Document;
    const previous = this.doc;
    const next =
      previous == null ? committed : this.rebaseDraftOnto(previous, committed);
    syncDebug("syncdoc:remote", () => ({
      path: this.path,
      hadDraft:
        previous != null && this.last != null && !previous.is_equal(this.last),
      hadDraftBase: this.draftBase != null,
      rebasedDiffers: previous != null && !next.is_equal(committed),
    }));
    this.last = committed;
    this.doc = next;
    // The draft is now relative to the committed document.
    this.draftBase = undefined;
    if (previous != null && previous.is_equal(next) && this.state === "ready") {
      return;
    }
    if (this.state === "ready") {
      this.emit("after-change");
      this.emit_change();
    }
  };

  private patchflowPrevSeqForMoreHistory = (): number | undefined => {
    if (!this.patchflowReady() || this.patchflowSession == null) return;
    const history: Parameters<typeof prevSeqForMoreHistoryFromHistory>[0] = [
      ...this.patchflowSession.history({ includeSnapshots: true }),
    ];
    // Also every snapshot message in the loaded stream: patchflow does not
    // see a record ignored before its patch was loaded (see
    // isSnapshotRecordBeforeLoadedRange), and once its patch loads, the patch
    // takes its table key, so the record that leads one snapshot further
    // back would otherwise be missing.
    try {
      for (const mesg of this.dstream()?.getAll?.() ?? []) {
        if (mesg?.is_snapshot && mesg.seq_info != null) {
          history.push({
            time: mesg.time,
            isSnapshot: true,
            seqInfo: mesg.seq_info,
          });
        }
      }
    } catch {}
    return prevSeqForMoreHistoryFromHistory(history, this.firstLoadedSeq());
  };

  private patchflowSnapshotCandidate = (
    interval: number,
    max_size: number,
  ): PatchId | undefined => {
    if (!this.patchflowReady() || this.patchflowSession == null) return;
    const session = this.patchflowSession as any;
    return snapshotCandidateFromHistory({
      history: this.patchflowSession.history({ includeSnapshots: true }),
      interval,
      maxSize: max_size,
      isCut:
        typeof session?.isCut === "function"
          ? (time: PatchId) => session.isCut(time)
          : undefined,
    });
  };

  private reconcileBackendFsState = reuseInFlight(async (): Promise<void> => {
    if (
      this.isClosed() ||
      this.opts.noSaveToDisk ||
      this.shouldUseBackendFsWatch()
    ) {
      return;
    }
    // Chats and other no-watch doctypes intentionally avoid a live backend
    // filesystem watcher because disk can lag patchflow for long periods, which
    // risks rollback patches from stale on-disk state. They still need the same
    // init-time authority rule as sync-fs, though: patchflow wins over older
    // disk, newer disk can reconcile in, and empty history can seed from disk
    // exactly once. Do that here by asking the backend sync-fs service to run a
    // one-shot reconcile without starting a persistent watcher.
    const syncFsReconcile = (this.fs as any)?.syncFsReconcile;
    if (typeof syncFsReconcile !== "function") return;
    try {
      await syncFsReconcile(this.path, {
        project_id: this.project_id,
        history_epoch: this.history_epoch,
        doctype: this.doctype,
      });
    } catch (err) {
      this.dbg("syncFsReconcile")(`failed: ${err?.message ?? err}`);
    }
  });

  private seedNoWatchDocFromDiskIfEmpty = reuseInFlight(
    async (): Promise<void> => {
      if (
        this.isClosed() ||
        this.opts.noSaveToDisk ||
        this.shouldUseBackendFsWatch()
      ) {
        return;
      }
      const hasLiveHistory =
        (this.patchflowVersions()?.length ?? 0) > 0 ||
        ((this.doc as any)?.to_str?.() ?? "").length > 0;
      if (hasLiveHistory) {
        return;
      }
      let diskValue: string;
      try {
        diskValue = (await this.fs.readFile(this.path, "utf8")) as string;
      } catch (err: any) {
        if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
          this.valueOnDisk = "";
          return;
        }
        this.dbg("seedNoWatchDocFromDiskIfEmpty")(
          `failed to read disk state: ${err?.message ?? err}`,
        );
        return;
      }
      if (this.historyTransition != null || this.isClosed()) return;
      this.valueOnDisk = diskValue;
      this.isDeleted = false;
      if (!diskValue) {
        return;
      }
      const current = this.patchflowSession?.getDocument() as
        | Document
        | undefined;
      const diskDoc = this._from_str(diskValue);
      if (current != null && this.documentsEqual(current, diskDoc)) {
        this.last = this.doc = current;
        return;
      }
      this.doc = diskDoc;
      this.last = current ?? diskDoc;
      if (this.commit({ file: true, allowDuplicate: true })) {
        await this.patches_table.save();
      }
    },
  );

  private markPatchflowFullHistory = (): void => {
    if (!this.patchflowReady() || this.patchflowSession == null) return;
    try {
      if (
        typeof (this.patchflowSession as any).markFullHistory === "function"
      ) {
        (this.patchflowSession as any).markFullHistory();
      }
    } catch (err) {
      console.warn("markPatchflowFullHistory failed", err);
    }
  };

  private documentsEqual = (a?: Document, b?: Document): boolean => {
    if (a == null || b == null) {
      return false;
    }
    const docA: any = a as any;
    if (typeof docA.is_equal === "function") {
      return docA.is_equal(b);
    }
    if (typeof docA.isEqual === "function") {
      return docA.isEqual(b);
    }
    return a === b;
  };

  private commitWithPatchflow = ({
    emitChangeImmediately = false,
    file = false,
    allowDuplicate = false,
    meta,
  }: {
    emitChangeImmediately?: boolean;
    file?: boolean;
    allowDuplicate?: boolean;
    meta?: { [key: string]: JSONValue };
  }): boolean => {
    if (!this.patchflowReady() || this.patchflowSession == null) {
      throw new Error("patchflow session is not initialized");
    }
    const draft = this.doc;
    if (draft == null) {
      return false;
    }
    let current: Document | undefined;
    // If there are multiple heads, we need to emit a merge patch even when the
    // content is identical, so that the heads collapse to a single tip.
    const forceMerge =
      this.patchflowReady() &&
      this.patchflowSession != null &&
      this.patchflowSession.getHeads().length > 1;
    try {
      current = this.patchflowSession.getDocument() as Document;
    } catch {
      // session not initialized yet
      return false;
    }
    // A remote patch can advance the committed graph while this.doc still
    // contains a local draft. Replay only the local delta onto that graph.
    const draftBase = this.draftBase;
    const next = this.rebaseDraftOnto(draft, current);
    this.draftBase = undefined;
    this.doc = next;
    const compareAgainst = current;
    syncDebug("syncdoc:commit", () => ({
      path: this.path,
      heads: this.patchflowSession?.getHeads().length,
      forceMerge,
      changed: !this.documentsEqual(current as Document, next),
      hadDraftBase: draftBase != null,
      draftIsLast: this.last != null && draft.is_equal(this.last),
      stack: new Error().stack?.split("\n").slice(2, 8).join("\n"),
    }));
    if (
      !allowDuplicate &&
      !forceMerge &&
      this.documentsEqual(compareAgainst as Document, next)
    ) {
      return false;
    }
    if (emitChangeImmediately) {
      this.emit_change();
    }
    this.emitUserChange();
    // Ensure save loops don't spin while the async commit runs.
    this.last = next;
    try {
      const env = this.patchflowSession.commit(next as any, { file, meta });
      const myPatches = (this.my_patches = this.my_patches ?? {});
      myPatches[env.time] = { time: env.time } as any;
      this.snapshotIfNecessary();
    } catch (err) {
      // Keep the draft, but do not claim that it was committed. In
      // particular, save_to_disk must never write this unrecorded state and
      // let sync-fs import it back as a filesystem-authored revision.
      this.last = current;
      console.warn("patchflow commit failed", err?.message ?? err);
      console.warn(err?.stack ?? "");
      this.dbg("commitWithPatchflow")(`commit failed -- ${err}`);
      this.notifyPatchflowWriteFailure(err);
      return false;
    }
    const latest = this.patchflowSession.versions().slice(-1)[0];
    if (latest != null) {
      const myPatches = (this.my_patches = this.my_patches ?? {});
      if (!myPatches[latest]) {
        myPatches[latest] = { time: latest } as any;
      }
    }
    if (!this.noAutosave) {
      this.save(); // eventually syncs out to other clients
    }
    this.touchProject();
    return true;
  };

  // Commit any changes to the live document to
  // history as a new patch.  Returns true if there
  // were changes and false otherwise.   This works
  // fine offline, and does not wait until anything
  // is saved to the network, etc.
  commit = ({
    emitChangeImmediately = false,
    file = false,
    allowDuplicate = false,
    meta,
  }: {
    emitChangeImmediately?: boolean;
    // mark this as a commit obtained by loading the file from disk,
    // which can be used as input to the merge conflict resolution.
    file?: boolean;
    allowDuplicate?: boolean;
    meta?: { [key: string]: JSONValue };
  } = {}): boolean => {
    // UI callbacks can briefly retain a sync document while it is opening or
    // after teardown. A disconnected ready document still has patchflow and
    // must continue accepting offline edits; only a missing session is a no-op.
    if (!this.patchflowReady() || this.patchflowSession == null) {
      return false;
    }
    if (this.historyTransition != null) {
      // the draft is kept (see runHistoryTransition)
      return false;
    }
    return this.commitWithPatchflow({
      emitChangeImmediately,
      file,
      allowDuplicate,
      meta,
    });
  };

  /**
   * Commit a patch that was computed from an editor operation log.
   *
   * This is deliberately restricted to server-owned documents with a
   * trustedAccountId.  It avoids reconstructing the next document and then
   * running diff-match-patch over it again: Patchflow persists the supplied
   * patch verbatim while still applying normal branch merge semantics.
   */
  commitExactPatch = async (
    patch: unknown,
    {
      meta,
      source = "essential-edit-journal",
    }: {
      meta?: { [key: string]: JSONValue };
      source?: string;
    } = {},
  ): Promise<PatchEnvelope | undefined> => {
    if (!this.trustedAccountId) {
      throw new Error(
        "commitExactPatch is only available to a trusted server-owned SyncDoc",
      );
    }
    this.assert_is_ready("commitExactPatch");
    if (this.historyTransition != null) {
      throw new Error(
        "the edit history was reset; nothing more is committed to this session",
      );
    }
    const session = this.requirePatchflowSession();
    const codec = this.patchflowCodec;
    if (codec == null || this.patches_table == null) {
      throw new Error("patchflow must be initialized before committing");
    }
    const current = session.getDocument() as Document;
    const next = codec.applyPatch(current, patch) as Document;
    if (this.documentsEqual(current, next)) {
      return;
    }

    // Session.commit normally asks the codec to diff current and next.  The
    // editor already supplied that exact patch, so substitute it for this one
    // synchronous call and immediately restore the codec.
    const makePatch = codec.makePatch;
    codec.makePatch = () => patch;
    let env: PatchEnvelope;
    try {
      this.emitUserChange();
      env = session.commit(next, { meta, source });
    } finally {
      codec.makePatch = makePatch;
    }
    this.doc = next;
    this.last = next;
    const myPatches = (this.my_patches = this.my_patches ?? {});
    myPatches[env.time] = { time: env.time } as Patch;
    await this.patches_table.save();
    this.snapshotIfNecessary();
    this.touchProject();
    return env;
  };

  hasEditJournalCommit = ({
    journalId,
    sequence,
  }: {
    journalId: string;
    sequence: number;
  }): boolean => {
    if (!this.patchflowReady()) return false;
    return this.requirePatchflowSession()
      .history({ includeSnapshots: false })
      .some((entry) => {
        const journal = entry.meta?.essential_edit_journal;
        return (
          journal != null &&
          typeof journal === "object" &&
          !Array.isArray(journal) &&
          journal.journal_id === journalId &&
          journal.sequence === sequence
        );
      });
  };

  reconcileTrustedDisk = async (): Promise<void> => {
    if (!this.trustedAccountId) {
      throw new Error(
        "reconcileTrustedDisk is only available to a trusted server-owned SyncDoc",
      );
    }
    const syncFsReconcile = (this.fs as any)?.syncFsReconcile;
    if (typeof syncFsReconcile !== "function") {
      throw new Error("filesystem does not support sync-fs reconciliation");
    }
    await syncFsReconcile(this.path, {
      project_id: this.project_id,
      history_epoch: this.history_epoch,
      doctype: this.doctype,
    });
  };

  // valueOnDisk = value of the file on disk, if known.  If there's an
  // event indicating  what was on disk may have changed, this
  // this.valueOnDisk is deleted until the new version is loaded.
  private valueOnDisk: string | undefined = undefined;

  private hasUnsavedChanges = (): boolean => {
    if (this.valueOnDisk == null) {
      return (
        this.diskMissingOnLoad ||
        this.localEditsSinceDiskBaseline ||
        this.isDeleted
      );
    }
    return this.valueOnDisk != this.to_str() || this.isDeleted;
  };

  private lastPatchflowWriteAlert?:
    | {
        message: string;
        time: number;
      }
    | undefined;

  private notifyPatchflowWriteFailure = (err: unknown): void => {
    const raw =
      err instanceof Error
        ? err.message || err.toString()
        : typeof err === "string"
          ? err
          : JSON.stringify(err);
    const message = `Unable to save changes to the database for ${this.path}. Your recent edits may not be safely stored yet. ${raw}`;
    const now = Date.now();
    const last = this.lastPatchflowWriteAlert;
    if (last != null && last.message === message && now - last.time < 30000) {
      return;
    }
    this.lastPatchflowWriteAlert = { message, time: now };
    this.client.alert_message?.({
      title: "Unable to save changes",
      message,
      type: "error",
    });
  };

  writeFile = async () => {
    if (this.opts.noSaveToDisk) {
      return;
    }
    // once the history was reset, this tab's value goes to a recovery copy,
    // never over the file (CORR-H1B2-1): checked here and after every await
    if (this.historyTransition != null) return;
    const dbg = this.dbg("writeFile");
    if (this.client.is_deleted(this.path, this.project_id)) {
      dbg("not saving to disk because deleted");
      return;
    }
    dbg();
    if (this.is_read_only()) {
      await this.stat();
      if (this.is_read_only()) {
        // it is definitely still read only.
        return;
      }
    }
    if (this.historyTransition != null) return;

    const value = this.to_str();
    // in the same synchronous step as value (see captureFileProof)
    const proof = this.captureFileProof(value);
    // include {ignore:true} with events for this long,
    // so no clients waste resources loading in response to us saving
    // to disk.
    if (this.isClosed() || this.historyTransition != null) return;
    this.last_save_to_disk_time = new Date();
    this.emit("before-save-to-disk");
    try {
      if (typeof this.fs.writeFileDelta !== "function") {
        throw new Error("writeFileDelta is required for safe, atomic writes");
      }
      // writeFileDelta is both efficient and guarantees atomic writes.
      await this.fs.writeFileDelta(this.path, value, {
        baseContents: this.valueOnDisk,
        saveLast: true,
      });
      if (this.isClosed()) return;
    } catch (err) {
      if (err.code == "EACCES") {
        try {
          // update read only knowledge -- that may have caused save error.
          await this.stat();
        } catch {}
      }
      throw err;
    }
    if (this.isClosed()) return;
    this.diskBaselineRequestId += 1;
    this.isDeleted = false;
    this.diskMissingOnLoad = false;
    this.localEditsSinceDiskBaseline = false;
    this.valueOnDisk = value;
    // a proof in the old epoch would be refused anyway
    if (this.historyTransition != null) return;
    // only after these exact bytes were written
    await this.publishFileProof(proof);
    if (this.isClosed()) return;
    this.emit("save-to-disk");
  };

  /* Initiates a save of file to disk, then waits for the
     state to change. */
  save_to_disk = reuseInFlight(async (): Promise<void> => {
    if (!this.isReady()) {
      // We just make save_to_disk a successful
      // no operation, if the document is either
      // closed or hasn't finished opening, since
      // there's a lot of code that tries to save
      // on exit/close or automatically, and it
      // is difficult to ensure it all checks state
      // properly.
      return;
    }
    if (this.historyTransition != null) {
      // the history was reset: this tab's value goes to a recovery copy,
      // never over the file (see runHistoryTransition)
      return;
    }
    // Persist the live draft to Patchflow before writing its serialized form
    // to disk. Otherwise a failed history commit followed by a disk write is
    // observed by sync-fs as a destructive edit made by "The Filesystem".
    await this.save();
    // the transition may have begun while save() waited (CORR-H1B2-1)
    if (this.historyTransition != null || this.isClosed()) return;
    if (
      this.doc == null ||
      this.last == null ||
      !this.documentsEqual(this.doc, this.last)
    ) {
      throw new Error(
        `Refusing to save ${this.path} to disk because its collaborative history is not up to date`,
      );
    }
    await this.writeFile();
    this.update_has_unsaved_changes();
  });

  /* Export the (currently loaded) history of editing of this
     document to a simple JSON-able object. */
  export_history = (options: HistoryExportOptions = {}): HistoryEntry[] => {
    this.assert_is_ready("export_history");
    const info = this.getDocumentMetadataState();
    if (info == null || !info.has("users")) {
      throw Error("document metadata must define users");
    }
    const account_ids: string[] = info.get("users").toJS();
    const patches = this.requirePatchflowSession().history({
      includeSnapshots: true,
    });
    return export_history(account_ids, patches, options);
  };

  private update_has_unsaved_changes = (): void => {
    if (!this.isReady()) {
      // This can happen, since this is called by a debounced function.
      // Make it a no-op in case we're not ready.
      // See https://github.com/sagemathinc/cocalc/issues/3577
      return;
    }
    const cur = this.has_unsaved_changes();
    if (cur !== this.last_has_unsaved_changes) {
      this.emit("has-unsaved-changes", cur);
      this.last_has_unsaved_changes = cur;
    }
  };

  // Immediately alert all watchers of all changes since
  // last time.
  private emit_change = (): void => {
    this.emit("change", this.doc?.changes?.(this.before_change));
    this.before_change = this.doc;
  };

  // Alert to changes soon, but debounced in case there are a large
  // number of calls in a group.  This is called by default.
  // The debounce param is 0, since the idea is that this just waits
  // until the next "render loop" to avoid huge performance issues
  // with a nested for loop of sets.  Doing it this way, massively
  // simplifies client code.
  emit_change_debounced: typeof this.emit_change = debounce(
    this.emit_change,
    0,
  );

  private setDocumentMetadata = async (obj, save = true) => {
    const value0 = this.getDocumentMetadataState();
    const value = mergeDeep(value0, fromJS(obj));
    if (value0.equals(value)) {
      return;
    }
    this.syncMetadata = value;
    this.setLastSnapshot(value.get("last_snapshot") ?? undefined);
    this.last_seq = value.get("last_seq") ?? undefined;
    this.users = this.normalizedUsers(value.get("users")?.toJS?.());
    this.snapshot_interval =
      value.get("snapshot_interval") ?? DEFAULT_SNAPSHOT_INTERVAL;
    this.settings = value.get("settings", Map());
    this.history_epoch = this.metadataHistoryEpoch(this.settings);
    this.applyPatchWriteHeaders();

    if (save && this.syncstring_table != null) {
      this.syncstring_table.set(value);
      await this.syncstring_table.save();
      return;
    }

    if (save && this.patches_table != null) {
      const dstream = this.dstream();
      try {
        await dstream.setMetadata(this.patchDocMetadataFromState());
        if (this.last_snapshot != null && this.last_seq != null) {
          await dstream.setCheckpoint({
            name: LATEST_SNAPSHOT_CHECKPOINT,
            seq: this.last_seq,
            data: { patchId: this.last_snapshot },
          });
        } else {
          await dstream.deleteCheckpoint(LATEST_SNAPSHOT_CHECKPOINT);
        }
      } catch (err) {
        const message = `${err ?? ""}`.toLowerCase();
        if (
          this.state === "closed" ||
          message.includes("closed") ||
          message.includes("disconnected")
        ) {
          return;
        }
        throw err;
      }
    }
  };

  // this keeps the project from idle timing out -- it happens
  // whenever there is an edit to the file by a browser, and
  // keeps the project from stopping.
  private touchProject = throttle(() => {
    if (this.client?.is_browser()) {
      this.client.touch_project?.(this.project_id);
    }
  }, 60000);

  private shouldUseBackendFsWatch(): boolean {
    if (this.opts?.noSaveToDisk || this.opts?.noBackendFsWatch) {
      return false;
    }
    const normalizedPath = `${this.path ?? ""}`.trim().toLowerCase();
    if (!normalizedPath) {
      return true;
    }
    for (const ext of BACKEND_FS_WATCH_DISABLED_EXTENSIONS) {
      if (normalizedPath.endsWith(`.${ext}`)) {
        return false;
      }
    }
    return true;
  }

  private async sendBackendFsWatch(active: boolean): Promise<void> {
    if (!this.shouldUseBackendFsWatch()) return;
    const syncFsWatch = (this.fs as any)?.syncFsWatch;
    if (typeof syncFsWatch !== "function") return;
    const timeoutMs = Math.max(
      1,
      this.opts.backendFsWatchTimeoutMs ?? DEFAULT_BACKEND_FS_WATCH_TIMEOUT_MS,
    );
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        syncFsWatch(this.path, active, {
          project_id: this.project_id,
          history_epoch: this.history_epoch,
          doctype: this.doctype,
          watchDebounce: this.opts.watchDebounce,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `backend filesystem watch timed out after ${timeoutMs}ms`,
              ),
            );
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      this.dbg("syncFsWatch")(`failed: ${err?.message ?? err}`);
    } finally {
      if (timer != null) clearTimeout(timer);
    }
  }

  private async startBackendFsWatch(): Promise<void> {
    if (!this.shouldUseBackendFsWatch()) return;
    if (process.env.SYNC_FS_DEBUG) {
      console.log("startBackendFsWatch", {
        path: this.path,
      });
    }
    await this.sendBackendFsWatch(true);
    if (this.backendFsWatchTimer != null) {
      clearInterval(this.backendFsWatchTimer);
    }
    // Keep the backend watcher alive; TTL is 60s so ping every 30s.
    this.backendFsWatchTimer = setInterval(() => {
      void this.sendBackendFsWatch(true);
    }, 30000);
  }

  private stopBackendFsWatch(): void {
    if (this.backendFsWatchTimer != null) {
      clearInterval(this.backendFsWatchTimer);
      this.backendFsWatchTimer = undefined;
    }
    void this.sendBackendFsWatch(false);
  }

  push = (doc: SyncDoc, { source }: { source?: string | number } = {}) => {
    remote.push({ local: this, remote: doc, source });
  };

  pull = (doc: SyncDoc, { source }: { source?: string | number } = {}) => {
    remote.push({ local: doc, remote: this, source });
  };
}

function isCompletePatchStream(dstream) {
  if (dstream.length == 0) {
    return false;
  }
  const first = dstream[0];
  if (first.is_snapshot) {
    return false;
  }
  if (first.parents == null) {
    // first ever commit
    return true;
  }
  for (let i = 1; i < dstream.length; i++) {
    if (dstream[i].is_snapshot && dstream[i].time == first.time) {
      return true;
    }
  }
  return false;
}

async function repairLatestSnapshotCheckpoint(dstream): Promise<boolean> {
  const checkpoint = latestSnapshotCheckpoint(dstream);
  if (checkpoint == null) {
    return false;
  }
  await dstream.setCheckpoint(checkpoint);
  return true;
}

function latestSnapshotCheckpoint(dstream) {
  for (let n = dstream.length - 1; n >= 0; n--) {
    const x = dstream[n];
    if (!x?.is_snapshot) {
      continue;
    }
    const time = x.time;
    let seq = x.seq_info?.seq;
    if (seq == null) {
      let m = n - 1;
      seq = dstream.seq(n) ?? 0;
      while (m >= 1) {
        if (dstream[m].time == time) {
          seq = dstream.seq(m) ?? seq;
          break;
        }
        m -= 1;
      }
    }
    if (seq != null) {
      return {
        name: LATEST_SNAPSHOT_CHECKPOINT,
        seq,
        data: { patchId: time },
      };
    }
  }
}

function isReadOnlyForCurrentUser(
  stats,
  identity?: { uid: number; gids: Set<number> },
): boolean {
  const uid = identity?.uid;
  if (uid == null || Number.isNaN(uid)) {
    // Unknown current user: conservative fallback to historical behavior.
    return (stats.mode & 0o200) === 0;
  }
  if (uid === 0) {
    // Root can usually write regardless of mode bits. Any write failures
    // (e.g., read-only filesystem) are handled by statWriteAccess/save error.
    return false;
  }
  if (Number(stats.uid) === uid) {
    return (stats.mode & 0o200) === 0;
  }

  const groups = identity?.gids ?? new Set<number>();

  if (groups.has(Number(stats.gid))) {
    return (stats.mode & 0o020) === 0;
  }
  return (stats.mode & 0o002) === 0;
}
