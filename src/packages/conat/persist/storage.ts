/*
Persistent storage of a specific stream or kv store.

You can set a message by providing optionally a key, buffer and/or json value.
A sequence number and time (in ms since epoch) is assigned and returned.
If the key is provided, it is an arbitrary string and all older messages
with that same key are deleted.  You can efficiently retrieve a message
by its key.  The message content itself is given by the buffer and/or json
value.  The buffer is like the "payload" in NATS, and the json is like
the headers in NATS.

This module is:

  - efficient -- buffer is automatically compressed using zstandard
  - synchronous -- fast enough to meet our requirements even with blocking
  - memory efficient -- nothing in memory beyond whatever key you request

We care about memory efficiency here since it's likely we'll want to have
possibly thousands of these in a single nodejs process at once, but with
less than 1 read/write per second for each.  Thus memory is critical, and
supporting at least 1000 writes/second is what we need.
Fortunately, this implementation can do ~50,000+ writes per second and read
over 500,000 per second.  Yes, it blocks the main thread, but by using
sync node:sqlite, we get speed increases over async code, so this is worth it.


COMPRESSION:

I implemented *sync* lz4-napi compression here and it's very fast,
but it has to be run with async waits in a loop or it doesn't give back
memory, and such throttling may significantly negatively impact performance
and mean we don't get a 100% sync api (like we have now).
The async functions in lz4-napi seem fine.  Upstream report (by me):
https://github.com/antoniomuso/lz4-napi/issues/678
I also tried the rust sync snappy and it had a similar memory leak.  Finally,
I tried zstd-napi and it has a very fast sync implementation that does *not*
need async pauses to not leak memory. So zstd-napi it is.
I then switched to the zstd built into nodejs.
And I like zstandard anyways.

TIERED STORAGE:

You can provide a second path archive for the sqlite file.  If provided, on creation,
this will stat both the main path and the archive path.  If the archive path is
newer, then the file is first copied from the archive path to the normal path,
then opened.   Also, if the archive path is provided, then a backup of the database
is made to the archive path periodically.    We use this for tiered storage in
CoCalc as follows.  The archive path is on a Google Cloud Storage autoclass bucket
that is mounted using gcsfuse.  The normal primary path is on a small fast SSD
persistent disk, which we view as a cache.

NOTE:

We use seconds instead of ms in sqlite since that is the standard
convention for times in sqlite.

DEVELOPMENT:


   s = require('@cocalc/backend/conat/persist').pstream({path:'/tmp/a.db'})

*/

import { refCacheSync } from "@cocalc/util/refcache";
import { randomId } from "@cocalc/conat/names";
import {
  createDatabase,
  type Database,
  compress,
  decompress,
  decompressAsync,
  statSync,
  copyFileSync,
  ensureContainingDirectoryExists,
  assertSafeDatabasePath,
  isProjectOwnedDatabasePath,
} from "./context";
import type { JSONValue } from "@cocalc/util/types";
import { EventEmitter } from "events";
import {
  DataEncoding,
  type Headers,
  ConatError,
} from "@cocalc/conat/core/client";
import TTL from "@isaacs/ttlcache";
import { getLogger } from "@cocalc/conat/logger";
import { reuseInFlight } from "@cocalc/util/reuse-in-flight";
import { throttle } from "lodash";
import type { PersistMaintenanceHandle } from "./maintenance/types";
import { decode } from "@cocalc/conat/core/codec";
import { historyLimits, type HistoryLimits } from "./history-limits";

const logger = getLogger("persist:storage");

export interface PartialInventory {
  // how much space is used by this stream
  bytes: number;
  limits: Partial<Configuration>;
  // number of messages
  count: number;
  // for streams, the seq number up to which this data is valid, i.e.,
  // this data is for all elements of the stream with sequence
  // number <= seq.
  seq: number;
}

export interface StreamSeqBounds {
  oldest_retained_seq?: number;
  newest_retained_seq?: number;
}

export interface StreamCheckpoint {
  seq: number;
  time: number;
  data?: JSONValue;
}

export type StreamCheckpoints = Record<string, StreamCheckpoint>;

export interface CheckpointUpdate {
  name: string;
  seq?: number;
  time?: number;
  data?: JSONValue;
}

export interface Configuration {
  // How many messages may be in a Stream, oldest messages will be removed
  // if the Stream exceeds this size. -1 for unlimited.
  max_msgs: number;

  // Maximum age of any message in the stream,
  // expressed in milliseconds. 0 for unlimited.
  // **Note that max_age is in milliseconds.**
  max_age: number;

  // How big the Stream may be. When the stream size
  // exceeds this, old messages are removed. -1 for unlimited.
  // The size of a message is the sum of the raw uncompressed blob
  // size, the headers json and the key length.
  max_bytes: number;

  // The largest message that will be accepted. -1 for unlimited.
  max_msg_size: number;

  // Attempting to publish a message that causes either of the following
  // two rate limits to be exceeded throws an exception.
  // For dstream, the messages are explicitly rejected and the client
  // gets a "reject" event emitted.  E.g., the terminal running in the project
  // writes [...] when it gets these rejects, indicating that data was dropped.
  // -1 for unlimited
  max_bytes_per_second: number;

  // -1 for unlimited
  max_msgs_per_second: number;

  // old = delete old messages to make room for nw
  // new = refuse writes if they exceed the limits
  discard_policy: "old" | "new";

  // If true (default: false), messages will be automatically deleted after their ttl
  // Use the option {ttl:number of MILLISECONDS} when publishing to set a ttl.
  allow_msg_ttl: boolean;

  // If set, writes are rejected unless all listed header key/value pairs
  // exactly match the message headers.  This is used as a fencing token,
  // e.g. to reject stale writers after a history reset.
  required_headers: JSONValue;

  // description of this table
  desc: JSONValue;
}

const CONFIGURATION = {
  max_msgs: { def: -1, fromDb: parseInt, toDb: (x) => `${parseInt(x)}` },
  max_age: { def: 0, fromDb: parseInt, toDb: (x) => `${parseInt(x)}` },
  max_bytes: { def: -1, fromDb: parseInt, toDb: (x) => `${parseInt(x)}` },
  max_msg_size: { def: -1, fromDb: parseInt, toDb: (x) => `${parseInt(x)}` },
  max_bytes_per_second: {
    def: -1,
    fromDb: parseInt,
    toDb: (x) => `${parseInt(x)}`,
  },
  max_msgs_per_second: {
    def: -1,
    fromDb: parseInt,
    toDb: (x) => `${parseInt(x)}`,
  },
  discard_policy: {
    def: "old",
    fromDb: (x) => `${x}`,
    toDb: (x) => (x == "new" ? "new" : "old"),
  },
  allow_msg_ttl: {
    def: false,
    fromDb: (x) => x == "true",
    toDb: (x) => `${!!x}`,
  },
  required_headers: {
    def: null,
    fromDb: JSON.parse,
    toDb: JSON.stringify,
  },
  desc: {
    def: null,
    fromDb: JSON.parse,
    toDb: JSON.stringify,
  },
};

export const EPHEMERAL_MAX_BYTES = 64 * 1e6;

enum CompressionAlgorithm {
  None = 0,
  Zstd = 1,
}

interface Compression {
  // compression algorithm to use
  algorithm: CompressionAlgorithm;
  // only compress data above this size
  threshold: number;
}

const DEFAULT_COMPRESSION = {
  algorithm: CompressionAlgorithm.Zstd,
  threshold: 1024,
};

// Largest stored message (uncompressed raw data plus headers and key) that
// will be read.  A message is decompressed and sent whole, so an unbounded one
// -- e.g., a runaway notebook output saved as a single 500 MB patch -- made
// every read of its stream stall the shared persist server for seconds.
// Reading such a message fails with 413 instead.  (Writes are not limited
// yet.)  Notebook outputs are capped far below this and blobs at 25 MB, so the
// limit only catches pathological messages.
export const DEFAULT_MAX_PERSIST_MESSAGE_BYTES = 256 * 1024 * 1024;

export function maxPersistMessageBytes(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const value = Number(env.COCALC_PERSIST_MAX_MESSAGE_BYTES);
  return Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_MAX_PERSIST_MESSAGE_BYTES;
}

// A project's persist files live in the project, so the project can change
// them: nothing read from them is trusted.  The limits below bound what any
// stored message can cost the (shared) persist server to read.

// Largest stored headers (serialized JSON) that will be parsed.  Conat message
// headers are at most MAX_MESSAGE_HEADER_BYTES (100 KB), so larger ones were
// not written by this server.
export const MAX_PERSIST_HEADERS_CHARS = 1_000_000;

// Decompressing a stored message produces at most its recorded size (which is
// at least its uncompressed length, see set), and never less than this.
const MIN_DECOMPRESS_LIMIT_BYTES = 64 * 1024;

// The "size" of a stored message whose data is not a BLOB (only a changed
// file has that): over every limit, so it is never read, and a client can
// remove it like any oversized message (resetHistory).
const NOT_A_BLOB_SIZE = Number.MAX_SAFE_INTEGER;

// The size of a stored message, for checking limits before reading it: the
// recorded size, but never less than what is physically stored.  (typeof()
// and length() of a BLOB do not read it.)
const EFFECTIVE_SIZE_SQL = `CASE WHEN typeof(raw) <> 'blob' THEN ${NOT_A_BLOB_SIZE} ELSE MAX(IFNULL(CAST(size AS INTEGER), 0), length(raw) + IFNULL(length(headers), 0) + IFNULL(length(key), 0)) END`;

// SQLite locking mode for the persist database at path.  A project owns the
// -shm file of its databases, which SQLite memory-maps, so it could truncate
// it and crash the whole persist server with SIGBUS.  "exclusive" keeps the
// WAL index in this process's memory instead, but then no other connection
// can open the file while this one has it open.  That is fine for project
// files, which a project-host's single persist server opens, but persist
// servers elsewhere (and tests) share files, so by default only project files
// are exclusive.  COCALC_PERSIST_SQLITE_LOCKING_MODE=normal or =exclusive
// applies one mode to every file.
export function persistSqliteLockingMode(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): "exclusive" | "normal" {
  const mode = env.COCALC_PERSIST_SQLITE_LOCKING_MODE;
  if (mode === "normal" || mode === "exclusive") {
    return mode;
  }
  return path !== ":memory:" && isProjectOwnedDatabasePath(path)
    ? "exclusive"
    : "normal";
}

// sqlite3_set_authorizer return codes
const SQLITE_OK = 0;
const SQLITE_DENY = 1;

// How long an operation waits for a lock held by another connection to the
// same file.  The API is synchronous, so the whole server waits: keep it short.
export const DEFAULT_PERSIST_SQLITE_BUSY_TIMEOUT_MS = 500;

export function persistSqliteBusyTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const value = Number(env.COCALC_PERSIST_SQLITE_BUSY_TIMEOUT_MS);
  return env.COCALC_PERSIST_SQLITE_BUSY_TIMEOUT_MS != null &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : DEFAULT_PERSIST_SQLITE_BUSY_TIMEOUT_MS;
}

function decompressLimit(size: number): number {
  const recorded = Number.isFinite(size) ? size : 0;
  return Math.min(
    maxPersistMessageBytes(),
    Math.max(recorded, MIN_DECOMPRESS_LIMIT_BYTES),
  );
}

function parseStoredHeaders(headers?: string | null) {
  if (!headers) return undefined;
  if (headers.length > MAX_PERSIST_HEADERS_CHARS) {
    throw new ConatError(
      `stored message headers are ${headers.length} characters, over the ${MAX_PERSIST_HEADERS_CHARS} limit`,
      { code: 413 },
    );
  }
  return JSON.parse(headers);
}

// The tables that bound sync document history: the msgID of each accepted
// message, the records a load can start from, each history epoch and the
// loadable segments of the archived ones, and the results of resets by
// operation id.  The schema check accepts them before this server creates
// them, so a server can roll back to this version after a newer one has
// created them.
export const HISTORY_SCHEMA = {
  message_ids: `CREATE TABLE IF NOT EXISTS message_ids (
          seq INTEGER PRIMARY KEY, msg_id TEXT NOT NULL
        )`,
  idx_message_ids_msg_id:
    "CREATE INDEX IF NOT EXISTS idx_message_ids_msg_id ON message_ids(msg_id)",
  history_cuts: `CREATE TABLE IF NOT EXISTS history_cuts (
          seq INTEGER PRIMARY KEY, snapshot_seq INTEGER
        )`,
  history_epochs: `CREATE TABLE IF NOT EXISTS history_epochs (
          id INTEGER PRIMARY KEY,
          epoch INTEGER NOT NULL,
          first_seq INTEGER NOT NULL,
          last_seq INTEGER,
          covered_seq INTEGER,
          seed_seq INTEGER,
          starts_empty INTEGER NOT NULL,
          ids_complete INTEGER NOT NULL,
          archive TEXT,
          kept_records INTEGER NOT NULL DEFAULT 0,
          kept_bytes INTEGER NOT NULL DEFAULT 0,
          dropped_records INTEGER NOT NULL DEFAULT 0,
          dropped_bytes INTEGER NOT NULL DEFAULT 0,
          info_json TEXT,
          time INTEGER NOT NULL
        )`,
  history_segments: `CREATE TABLE IF NOT EXISTS history_segments (
          epoch_id INTEGER NOT NULL,
          first_seq INTEGER NOT NULL,
          last_seq INTEGER NOT NULL,
          cut_seq INTEGER,
          snapshot_seq INTEGER,
          cut_bytes INTEGER NOT NULL,
          suffix_bytes INTEGER NOT NULL,
          records INTEGER NOT NULL,
          PRIMARY KEY (epoch_id, first_seq)
        )`,
  history_ops: `CREATE TABLE IF NOT EXISTS history_ops (
          op_id TEXT PRIMARY KEY, result_json TEXT NOT NULL, time INTEGER NOT NULL
        )`,
} as const;

// The schema objects this server creates, keyed by name.  Opening a file with
// anything else (triggers, views, other indexes or tables, or a changed
// definition) is refused: such objects run code on every write or change
// query plans, and this server never creates them.
const SCHEMA = {
  messages: `CREATE TABLE IF NOT EXISTS messages (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE, time INTEGER NOT NULL, headers TEXT, compress NUMBER NOT NULL, encoding NUMBER NOT NULL, raw BLOB NOT NULL, size NUMBER NOT NULL, ttl NUMBER
          )`,
  idx_messages_key:
    "CREATE INDEX IF NOT EXISTS idx_messages_key ON messages(key)",
  idx_messages_time:
    "CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(time)",
  config: `CREATE TABLE IF NOT EXISTS config (
          field TEXT PRIMARY KEY, value TEXT NOT NULL
        )`,
  stream_metadata: `CREATE TABLE IF NOT EXISTS stream_metadata (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          metadata_json TEXT,
          revision INTEGER NOT NULL DEFAULT 0
        )`,
  stream_checkpoints: `CREATE TABLE IF NOT EXISTS stream_checkpoints (
          name TEXT PRIMARY KEY,
          seq INTEGER NOT NULL,
          time INTEGER NOT NULL,
          data_json TEXT,
          revision INTEGER NOT NULL DEFAULT 0
        )`,
  idx_stream_checkpoints_seq:
    "CREATE INDEX IF NOT EXISTS idx_stream_checkpoints_seq ON stream_checkpoints(seq)",
  ...HISTORY_SCHEMA,
} as const;

function normalizeSchemaSql(sql: string): string {
  return sql
    .replace(/\s+/g, " ")
    .replace(/\s*([(),=])\s*/g, "$1")
    .replace(/^CREATE (TABLE|INDEX) IF NOT EXISTS /i, "CREATE $1 ")
    .trim()
    .toLowerCase();
}

const ARCHIVED_MESSAGES_TABLE = /^messages_archived_\d+(?:_\d+)?$/;

export function persistSchemaCheckEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.COCALC_PERSIST_SCHEMA_CHECK !== "off";
}

// Why a database's schema is not one this server creates, or undefined if it
// is.  Exported for tests.
export function unexpectedPersistSchema(
  objects: {
    type: string;
    name: string;
    tbl_name: string;
    sql: string | null;
  }[],
): string | undefined {
  const expected = new Map(
    Object.entries(SCHEMA).map(([name, sql]) => [
      name,
      normalizeSchemaSql(sql),
    ]),
  );
  const archivedTable = normalizeSchemaSql(SCHEMA.messages);
  const ourTables = new Set([
    "messages",
    "config",
    "stream_checkpoints",
    "history_segments",
    "history_ops",
  ]);
  for (const { type, name, tbl_name, sql } of objects) {
    const label = `${type} ${JSON.stringify(String(name).slice(0, 80))}`;
    if (type === "table" && name === "sqlite_sequence") continue;
    if (type === "index" && name.startsWith("sqlite_autoindex_")) {
      if (ourTables.has(tbl_name) || ARCHIVED_MESSAGES_TABLE.test(tbl_name)) {
        continue;
      }
      return `unexpected ${label}`;
    }
    if (type === "table" && ARCHIVED_MESSAGES_TABLE.test(name)) {
      // created by ALTER TABLE messages RENAME TO "<name>" (resetHistory)
      const renamed = normalizeSchemaSql(sql ?? "").replace(
        /^create table "?messages_archived_\d+(?:_\d+)?"?\(/,
        "create table messages(",
      );
      if (renamed === archivedTable) continue;
      return `changed ${label}`;
    }
    if (
      (type === "table" || type === "index") &&
      expected.has(name) &&
      (type === "index") === name.startsWith("idx_")
    ) {
      if (normalizeSchemaSql(sql ?? "") === expected.get(name)) continue;
      return `changed ${label}`;
    }
    return `unexpected ${label}`;
  }
  return undefined;
}

export function persistMessageTooLargeError({
  size,
  limit,
  seq,
}: {
  size: number;
  limit: number;
  seq: number;
}): ConatError {
  const err = new ConatError(
    size >= NOT_A_BLOB_SIZE
      ? `stored message ${seq} is corrupt (its data is not stored as bytes), so it cannot be read; an operator must remove it from the stream`
      : `stored message ${seq} is ${size} bytes, over the ${limit} byte limit, so it cannot be read; an operator must remove it from the stream`,
    { code: 413 },
  );
  // which message, so a client can ask for exactly this one to be dealt with
  // (see resetHistory)
  (err as any).oversizedSeq = seq;
  return err;
}

export interface ResetHistoryOptions {
  // the new history_epoch is at least this (e.g., an epoch kept elsewhere)
  minEpoch?: number;
  // more settings to record in the metadata, e.g., who reset the history
  settings?: { [key: string]: JSONValue };
  // Only reset if the message with this seq is still in the history and too
  // large to load.  Several clients can see the same oversized message at
  // once; the first reset removes it, so the others change nothing.
  ifOversizedSeq?: number;
  // keep the old messages, in a table of their own, instead of deleting them
  archive?: boolean;
  // Only reset if the stream is still as judged: its newest seq and number of
  // messages (see inventory), and its history epoch.
  ifRevision?: { seq: number; count: number };
  ifInitEpoch?: number;
  // The first message of the new history: a snapshot of the document's value
  // including every message with seq <= coveredSeq.  It is inserted in the
  // same transaction, so there is never an empty history to open.
  seed?: ResetHistorySeed;
  // required with a seed: the stream's newest seq, so the seed covers every
  // message the server accepted ...
  coveredSeq?: number;
  // ... or older than that, if the newer messages cannot be used (a damaged
  // history, reset from the saved file).  Their ids are then reported as
  // excluded by historyInclusion, never as included.
  allowRollback?: boolean;
  // Identifies this reset: a repeated request (e.g., after a lost reply)
  // returns the first result instead of resetting again.
  opId?: string;
  // recorded with the archived epoch, e.g., "oversized" or "damaged"
  reason?: string;
}

export interface ResetHistorySeed {
  encoding: DataEncoding;
  // the encoded patch object, not compressed; it must be a snapshot
  // ({is_snapshot: true, snapshot: string, ...})
  raw: Buffer | Uint8Array;
  // the server adds the new history_epoch
  headers?: { [key: string]: JSONValue };
  msgID?: string;
  // a checkpoint to set at the seed's seq, e.g., latest_snapshot
  checkpoint?: { name: string; data?: JSONValue };
}

export type ResetHistoryRefusal =
  // ifOversizedSeq is gone or not too large
  | "not-oversized"
  // ifRevision, or coveredSeq without allowRollback, is not the stream's
  | "moved"
  | "epoch"
  | "seed-too-large"
  | "seed-invalid"
  // another reset of this stream is in progress on the persist server (see
  // the reset slot in server.ts); nothing was done, try again later
  | "busy";

export interface ResetHistoryResult {
  // false if a condition did not hold; see refused
  reset: boolean;
  // the history epoch now in effect
  history_epoch: number;
  // number of messages deleted or archived
  count: number;
  // name of the table the old messages were archived in
  archive?: string;
  refused?: ResetHistoryRefusal;
  // the seed's seq and what it covers
  seedSeq?: number;
  coveredSeq?: number;
  // the archive: its loadable segments, and the messages that are in no
  // loadable segment, so were removed
  segments?: number;
  dropped?: { records: number; bytes: number };
  // older archived history removed to stay within maxArchiveBytes
  droppedArchived?: { records: number; bytes: number };
  // this opId was already done; this is its result
  repeated?: boolean;
}

// What historyInclusion knows about a msg id:
//  - live: accepted in the current history;
//  - included: accepted in an older epoch, and in the current history's seed;
//  - excluded: accepted in an older epoch, and not in the current seed (a
//    rollback, or a reset without a seed);
//  - absent: never accepted in the epoch asked about;
//  - unknown: the evidence is gone or was never complete (older servers, an
//    expired archive, deleted messages).  Never treat this as absent.
export type InclusionStatus =
  | "live"
  | "included"
  | "excluded"
  | "absent"
  | "unknown";

export interface HistoryInclusion {
  history_epoch: number;
  ids: { [msgID: string]: { status: InclusionStatus; seq?: number } };
}

export interface ArchivedHistoryEpoch {
  epoch: number;
  first_seq: number;
  last_seq: number;
  covered_seq?: number;
  archive?: string;
  kept: { records: number; bytes: number };
  dropped: { records: number; bytes: number };
  info?: JSONValue;
  time: number;
  segments: ArchivedHistorySegment[];
}

// a loadable stretch of archived history: start at the cut (or the empty
// document if cut_seq is undefined) and load through last_seq
export interface ArchivedHistorySegment {
  first_seq: number;
  last_seq: number;
  cut_seq?: number;
  snapshot_seq?: number;
  cut_bytes: number;
  suffix_bytes: number;
  records: number;
}

// tables holding history kept by resetHistory({archive:true})
const ARCHIVED_MESSAGES_PREFIX = "messages_archived_";

// a stored archive table name, which is pasted into SQL: only exactly the
// names this server creates
function archiveTableName(name: unknown): string | undefined {
  return typeof name === "string" && ARCHIVED_MESSAGES_TABLE.test(name)
    ? name
    : undefined;
}

// The checkpoint sync documents set at their latest snapshot (see SyncDoc's
// LATEST_SNAPSHOT_CHECKPOINT): the only checkpoints that are archive cuts.
const SNAPSHOT_CHECKPOINT = "latest_snapshot";

// results of resets kept by opId, so a repeated request gets the first result
const MAX_HISTORY_OPS = 100;
// closed epochs without an archive kept in history_epochs
const MAX_HISTORY_EPOCH_ROWS = 100;
// archived epochs kept per stream (also bounded by maxArchiveBytes)
const MAX_ARCHIVED_EPOCHS = 100;
// charged against maxArchiveBytes for what an archived record and an archive
// table store beyond the message itself (row header, seq/time/size columns,
// index entries; schema and root pages), conservatively
export const ARCHIVE_RECORD_OVERHEAD_BYTES = 128;
export const ARCHIVE_TABLE_OVERHEAD_BYTES = 64 * 1024;

// the size recorded for a message: uncompressed data plus headers and key
function messageSize({
  serializedHeaders,
  raw,
  key,
}: {
  serializedHeaders?: string;
  raw?: Buffer | Uint8Array;
  key?: string;
}): number {
  return (
    (serializedHeaders?.length ?? 0) + (raw?.length ?? 0) + (key?.length ?? 0)
  );
}

// info_json of the open epoch: the newest seq written by a server that
// records msg ids (see verifyIdLedger)
function ledgerInfo(seq: number): string {
  return JSON.stringify({ ledger_seq: seq });
}

// The seed of a reset must be a snapshot patch: the document's whole value.
function isSnapshotPatch(obj: unknown): boolean {
  return (
    obj != null &&
    typeof obj === "object" &&
    !Array.isArray(obj) &&
    (obj as any).is_snapshot === true &&
    typeof (obj as any).snapshot === "string"
  );
}

function epochOf(x: { [key: string]: JSONValue }): number {
  const epoch = x.history_epoch;
  return typeof epoch === "number" && Number.isFinite(epoch) ? epoch : 0;
}

// A stored message as read from the database, before decompression.
export interface StoredRow {
  seq: number;
  key?: string | null;
  time: number;
  compress: CompressionAlgorithm;
  encoding: DataEncoding;
  raw: Buffer;
  headers?: string | null;
  // uncompressed size of raw data plus headers and key
  size: number;
}

// Messages at least this large (uncompressed) are decompressed off the event
// loop.  Callers that read them should bound how many are in flight (the
// persist server admits such replay pages one at a time per slot).
export const ASYNC_DECOMPRESS_MIN_BYTES = 1_000_000;

export async function storedRowToMessage(
  row: StoredRow,
): Promise<StoredMessage> {
  if (!(row.raw instanceof Uint8Array)) {
    // the size of such a row is NOT_A_BLOB_SIZE, but don't rely on callers
    // checking it
    throw persistMessageTooLargeError({
      size: NOT_A_BLOB_SIZE,
      limit: maxPersistMessageBytes(),
      seq: row.seq,
    });
  }
  let raw: Buffer;
  if (row.compress == CompressionAlgorithm.None) {
    raw = row.raw;
  } else if (row.compress == CompressionAlgorithm.Zstd) {
    const limit = decompressLimit(row.size);
    raw =
      row.size >= ASYNC_DECOMPRESS_MIN_BYTES
        ? await decompressAsync(row.raw, limit)
        : decompress(row.raw, limit);
  } else {
    throw Error(`unknown compression ${row.compress}`);
  }
  return {
    seq: row.seq,
    time: row.time * 1000,
    key: row.key != null ? row.key : undefined,
    encoding: row.encoding,
    raw,
    headers: parseStoredHeaders(row.headers),
  };
}

export interface StoredMessage {
  // server assigned positive increasing integer number
  seq: number;
  // server assigned time in ms since epoch
  time: number;
  // user assigned key -- when set all previous messages with that key are deleted.
  key?: string;
  // the encoding used to encode the raw data
  encoding: DataEncoding;
  // arbitrary binary data
  raw: Buffer;
  // arbitrary JSON-able object -- analogue of NATS headers, but anything JSON-able
  headers?: Headers;
}

export interface SetOperation extends StoredMessage {
  op?: undefined;
  msgID?: string;
}

export interface DeleteOperation {
  op: "delete";
  // sequence numbers of deleted messages
  seqs: number[];
}

export interface MetadataOperation {
  op: "metadata";
  metadata?: JSONValue;
}

export interface CheckpointsOperation {
  op: "checkpoints";
  checkpoints: StreamCheckpoints;
}

export type ChangefeedOperation =
  | SetOperation
  | DeleteOperation
  | MetadataOperation
  | CheckpointsOperation;

export const DEFAULT_ARCHIVE_INTERVAL = 30_000; // 30 seconds

export interface StorageOptions {
  // absolute path to sqlite database file.  This needs to be a valid filename
  // path, and must also be kept under 1000 characters in length so it can be
  // stored in cloud storage.
  path: string;
  // another absolute pat.    If this is given, then (1)
  // it will be copied to path before opening path if it is newer, and (2) a
  // backup will be saved to archive (using sqlite's backup feature) every
  // archiveInteral ms.  NOTE: we actually append ".db" to path and to archive.
  archive?: string;
  // the archive interval, if archive is given.  defaults to DEFAULT_ARCHIVE_INTERVAL
  // Depending on your setup, this is likely your tolerance for data loss in the worst case scenario, e.g.,
  // "loss of the last 30 seconds of TimeTravel edit history".
  archiveInterval?: number;
  // another path which will be written to when the database is closed,
  // but not otherwise. NOTE: '.db' is appended to name.
  // this backup is *NOT* used in any way except as a backup; in particular,
  // it won't be used even if archive and path were both gone.
  backup?: string;

  // if false (the default) do not require sync writes to disk on every set
  sync?: boolean;
  // if set, then data is never saved to disk at all. To avoid using a lot of server
  // RAM there is always a hard cap of at most EPHEMERAL_MAX_BYTES on any ephemeral
  // table, which is enforced on all writes.  Clients should always set max_bytes,
  // possibly as low as they can, and check by reading back what is set.
  ephemeral?: boolean;
  // compression configuration
  compression?: Compression;
}

export const EPHEMERAL_SQLITE_CACHE_KIB_ENV =
  "CONAT_PERSIST_EPHEMERAL_SQLITE_CACHE_KIB";
export const DEFAULT_EPHEMERAL_SQLITE_CACHE_KIB = 256;

type StreamStorageKind = "ephemeral" | "disk";

export interface CacheSizeSummary {
  streams: number;
  min_kib?: number;
  max_kib?: number;
}

const streamLifecycle = {
  opened_total: 0,
  closed_total: 0,
  opened_ephemeral_total: 0,
  closed_ephemeral_total: 0,
  opened_disk_total: 0,
  closed_disk_total: 0,
  open_ephemeral: 0,
  open_disk: 0,
};

const openCacheSizes = {
  ephemeral: new Map<number, number>(),
  disk: new Map<number, number>(),
};

type OpenStreamDiagnostic = {
  kind: StreamStorageKind;
  family: string;
  openedAt: number;
};

const openStreams = new Map<PersistentStream, OpenStreamDiagnostic>();

function streamNameFamily(name: string): string {
  const first = name.split("/")[0] ?? "";
  if (/^lro\./.test(first)) return "lro";
  if (first === "account-feed") return "account-feed";
  if (/^acp-(?:live|preview)-log(?:$|:)/.test(first)) return "acp-log";
  if (/^__dko__/.test(first)) return "dko";
  if (/^__/.test(first)) return "internal";
  return "other";
}

export function classifyPersistentStreamPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const scoped = normalized.match(
    /(?:^|\/)(accounts|projects|hosts)\/[^/]+\/(.+)$/,
  );
  if (scoped) {
    const scope = scoped[1].slice(0, -1);
    return `${scope}:${streamNameFamily(scoped[2])}`;
  }
  const hub = normalized.match(/(?:^|\/)hub\/(.+)$/);
  if (hub) {
    return `hub:${streamNameFamily(hub[1])}`;
  }
  return `other:${streamNameFamily(normalized.split("/").at(-1) ?? "")}`;
}

export function resolveEphemeralSqliteCacheKiB(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = `${env[EPHEMERAL_SQLITE_CACHE_KIB_ENV] ?? ""}`.trim();
  if (!raw) {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${EPHEMERAL_SQLITE_CACHE_KIB_ENV} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_048_576) {
    throw new Error(
      `${EPHEMERAL_SQLITE_CACHE_KIB_ENV} must be between 1 and 1048576`,
    );
  }
  return value;
}

export function effectiveEphemeralSqliteCacheKiB(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return (
    resolveEphemeralSqliteCacheKiB(env) ?? DEFAULT_EPHEMERAL_SQLITE_CACHE_KIB
  );
}

function updateCacheSizeCount(
  kind: StreamStorageKind,
  cacheKiB: number,
  delta: 1 | -1,
): void {
  const counts = openCacheSizes[kind];
  const next = (counts.get(cacheKiB) ?? 0) + delta;
  if (next > 0) {
    counts.set(cacheKiB, next);
  } else {
    counts.delete(cacheKiB);
  }
}

function recordStreamOpen(kind: StreamStorageKind, cacheKiB: number): void {
  streamLifecycle.opened_total += 1;
  streamLifecycle[`opened_${kind}_total`] += 1;
  streamLifecycle[`open_${kind}`] += 1;
  updateCacheSizeCount(kind, cacheKiB, 1);
}

function recordStreamClose(kind: StreamStorageKind, cacheKiB: number): void {
  streamLifecycle.closed_total += 1;
  streamLifecycle[`closed_${kind}_total`] += 1;
  streamLifecycle[`open_${kind}`] -= 1;
  updateCacheSizeCount(kind, cacheKiB, -1);
}

function summarizeCacheSizes(kind: StreamStorageKind): CacheSizeSummary {
  let streams = 0;
  let min_kib: number | undefined;
  let max_kib: number | undefined;
  for (const [cacheKiB, count] of openCacheSizes[kind]) {
    streams += count;
    min_kib = min_kib == null ? cacheKiB : Math.min(min_kib, cacheKiB);
    max_kib = max_kib == null ? cacheKiB : Math.max(max_kib, cacheKiB);
  }
  return { streams, min_kib, max_kib };
}

function summarizeOpenStreams(now: number) {
  const byFamily: Record<string, number> = {};
  const byAge = {
    under_1m: 0,
    from_1m_to_5m: 0,
    from_5m_to_15m: 0,
    from_15m_to_1h: 0,
    from_1h_to_6h: 0,
    over_6h: 0,
  };
  let oldestAgeSeconds = 0;
  for (const { family, openedAt } of openStreams.values()) {
    byFamily[family] = (byFamily[family] ?? 0) + 1;
    const ageMs = Math.max(0, now - openedAt);
    oldestAgeSeconds = Math.max(oldestAgeSeconds, Math.floor(ageMs / 1000));
    if (ageMs < 60_000) byAge.under_1m += 1;
    else if (ageMs < 5 * 60_000) byAge.from_1m_to_5m += 1;
    else if (ageMs < 15 * 60_000) byAge.from_5m_to_15m += 1;
    else if (ageMs < 60 * 60_000) byAge.from_15m_to_1h += 1;
    else if (ageMs < 6 * 60 * 60_000) byAge.from_1h_to_6h += 1;
    else byAge.over_6h += 1;
  }
  return {
    by_family: Object.fromEntries(
      Object.entries(byFamily).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    by_age: byAge,
    oldest_age_seconds: oldestAgeSeconds,
  };
}

// persistence for stream of messages with subject
export class PersistentStream extends EventEmitter {
  // Identifies this in-memory copy of an ephemeral stream.  Its contents and
  // seq numbers do not survive a persist server restart, so a client that
  // sees a different instance knows to start over rather than resume from
  // its last seq.  Undefined for disk-backed streams, whose seqs persist.
  readonly instance?: string;
  // A disk-backed stream opened after its project's files were replaced
  // under a fence (fence.ts) reports this as its instance instead, so that
  // clients start over rather than resume from seqs of the old files.
  replacedInstance?: string;
  private readonly options: StorageOptions;
  private readonly db: Database;
  private readonly dbPath?: string;
  private readonly storageKind: StreamStorageKind;
  private readonly sqliteCacheKiB: number;
  private readonly msgIDs = new TTL({ ttl: 2 * 60 * 1000 });
  private conf: Configuration;
  private throttledBackup?;
  private closing = false;
  private diagnosticsRegistered = false;
  private maintenanceDirty = false;
  private readonly maintenanceHandles = new Map<
    string,
    PersistMaintenanceHandle
  >();

  constructor(options: StorageOptions) {
    super();
    openPaths.add(options.path);
    try {
      logger.debug("constructor ", options.path);
      this.setMaxListeners(1000);
      options = { compression: DEFAULT_COMPRESSION, ...options };
      this.options = options;
      this.storageKind = this.options.ephemeral ? "ephemeral" : "disk";
      if (this.options.ephemeral) {
        this.instance = randomId();
      }
      const location = this.options.ephemeral
        ? ":memory:"
        : this.options.path + ".db";
      if (location !== ":memory:") {
        this.dbPath = location;
        assertSafeDatabasePath(location);
      }
      this.initArchive();
      if (location !== ":memory:") {
        // again: initArchive may have written the file
        assertSafeDatabasePath(location);
      }
      // defensive: no writable_schema or other ways to corrupt the file
      this.db = createDatabase(location, { defensive: true });
      try {
        this.hardenConnection(location);
        if (location !== ":memory:") {
          this.assertExpectedSchema();
        }
      } catch (err) {
        this.db.close();
        throw err;
      }
      const configuredCacheKiB = this.options.ephemeral
        ? effectiveEphemeralSqliteCacheKiB()
        : undefined;
      if (configuredCacheKiB != null) {
        this.db.exec(`PRAGMA cache_size=-${configuredCacheKiB}`);
      }
      this.sqliteCacheKiB = this.readSqliteCacheKiB();
      this.initSchema();
      this.maintenanceDirty = false;
      recordStreamOpen(this.storageKind, this.sqliteCacheKiB);
      openStreams.set(this, {
        kind: this.storageKind,
        family: classifyPersistentStreamPath(this.options.path),
        openedAt: Date.now(),
      });
      this.diagnosticsRegistered = true;
    } catch (err) {
      openPaths.delete(options.path);
      throw err;
    }
  }

  addMaintenanceHandle = (handle: PersistMaintenanceHandle): void => {
    if (this.options.ephemeral || this.closing) return;
    this.maintenanceHandles.set(handle.ownerId, handle);
  };

  private markMaintenanceMutation = (): void => {
    if (this.options.ephemeral || this.closing) return;
    this.maintenanceDirty = true;
    for (const handle of this.maintenanceHandles.values()) {
      try {
        handle.onMutation();
      } catch (err) {
        logger.debug("persist maintenance mutation hook failed", {
          path: this.options.path,
          err,
        });
      }
    }
  };

  private initArchive = () => {
    if (!this.options.archive) {
      this.throttledBackup = () => {};
      return;
    }
    this.throttledBackup = throttle(
      this.backup,
      this.options.archiveInterval ?? DEFAULT_ARCHIVE_INTERVAL,
    );

    const archive = this.options.archive + ".db";
    const archiveAge = age(archive);

    const path = this.options.path + ".db";
    const pathAge = age(path);

    if (archiveAge > pathAge) {
      copyFileSync(archive, path);
    }
  };

  // Limit what this connection can do, whatever the (untrusted) file holds.
  // Runs before anything reads the database.
  private hardenConnection = (location: string) => {
    // Avoid immediate "database is locked" errors under concurrent access
    // (e.g., jest workers), also for the first read (the schema check).
    this.db.exec(`PRAGMA busy_timeout=${persistSqliteBusyTimeoutMs()}`);
    if (persistSqliteLockingMode(location) === "exclusive") {
      // Before the first read: then SQLite never creates or maps a -shm file
      // (see persistSqliteLockingMode).
      this.db.exec("PRAGMA locking_mode=EXCLUSIVE");
    }
    const limits = (this.db as any).limits;
    if (limits != null) {
      // Never attach another database file, e.g., through a crafted table
      // name.  (This server never attaches or vacuums on these connections.)
      limits.attach = 0;
      // No string, blob or row larger than the largest message we read.
      limits.length = maxPersistMessageBytes() + 16 * 1024 * 1024;
    }
    // Functions with side effects can't run from the file's schema.
    this.db.exec("PRAGMA trusted_schema=OFF");
    // The project can change the file while it is open, e.g., add a trigger
    // after assertExpectedSchema checked it.  This server never uses triggers
    // or views, so refuse anything done from inside one.  SQLite checks this
    // whenever a statement is prepared, and re-prepares statements after any
    // schema change.
    const db = this.db as any;
    if (typeof db.setAuthorizer === "function") {
      db.setAuthorizer(
        (
          _action: number,
          _arg1: string | null,
          _arg2: string | null,
          _dbName: string | null,
          triggerOrView: string | null,
        ) => (triggerOrView == null ? SQLITE_OK : SQLITE_DENY),
      );
    }
  };

  private assertExpectedSchema = () => {
    if (!persistSchemaCheckEnabled()) return;
    const objects = this.db
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master")
      .all() as {
      type: string;
      name: string;
      tbl_name: string;
      sql: string | null;
    }[];
    const problem = unexpectedPersistSchema(objects);
    if (problem != null) {
      logger.warn("refusing to open persist database with unexpected schema", {
        path: this.dbPath,
        problem,
      });
      throw new ConatError(
        `this persistent storage was changed outside CoCalc (${problem}), so it cannot be opened`,
        { code: 500 },
      );
    }
  };

  private initSchema = () => {
    // WAL, so readers and a writer can use the file at once (see also
    // busy_timeout in hardenConnection).
    this.db.prepare("PRAGMA journal_mode=WAL").run();
    if (!this.options.sync && !this.options.ephemeral) {
      // Unless sync is set, we do not require that the filesystem has commited changes
      // to disk after every insert. This can easily make things 10x faster.  sets are
      // typically going to come in one-by-one as users edit files, so this works well
      // for our application.  Also, loss of a few seconds persistence is acceptable
      // in a lot  of applications, e.g., if it is just edit history for a file.
      this.db.prepare("PRAGMA synchronous=OFF").run();
    }
    this.createMessagesTable();
    this.db.prepare(SCHEMA.config).run();
    this.db.prepare(SCHEMA.stream_metadata).run();
    this.db.prepare(SCHEMA.stream_checkpoints).run();
    this.db.prepare(SCHEMA.idx_stream_checkpoints_seq).run();
    for (const sql of Object.values(HISTORY_SCHEMA)) {
      this.db.prepare(sql).run();
    }

    this.conf = this.config();
    this.ensureCurrentEpoch();
    this.runTransaction(() => this.trimArchivedHistory(historyLimits()));
  };

  // The history epoch in effect: the fence's, or the metadata's if higher.
  // The history epoch in effect, for answers that do not open a reset.
  historyEpochNow = (): number => this.currentEpoch();

  private currentEpoch = (): number => {
    const fence = isPlainRecord(this.conf?.required_headers)
      ? this.conf.required_headers
      : {};
    const metadata = this.getMetadata();
    const settings =
      isPlainRecord(metadata) && isPlainRecord(metadata.settings)
        ? metadata.settings
        : {};
    return Math.max(epochOf(settings), epochOf(fence));
  };

  // the seq the next message will get
  private nextSeq = (): number => {
    const row = this.db
      .prepare("SELECT seq FROM sqlite_sequence WHERE name='messages'")
      .get() as { seq?: number } | undefined;
    return Number(row?.seq ?? 0) + 1;
  };

  // The row of history_epochs describing the current history.  A stream from
  // before this server either is empty (so its ids are complete from now on),
  // or has messages whose ids were never recorded.
  private ensureCurrentEpoch = (): void => {
    if (
      this.db
        .prepare("SELECT id FROM history_epochs WHERE last_seq IS NULL")
        .get() != null
    ) {
      this.verifyIdLedger({ epoch: true });
      return;
    }
    const { first } = this.db
      .prepare("SELECT MIN(seq) AS first FROM messages")
      .get() as { first: number | null };
    const empty = first == null;
    this.db
      .prepare(
        "INSERT INTO history_epochs(epoch, first_seq, starts_empty, ids_complete, info_json, time) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        this.currentEpoch(),
        empty ? this.nextSeq() : first,
        // nothing was deleted from its start, so it can be loaded from the
        // empty document
        empty || first === 1 ? 1 : 0,
        empty ? 1 : 0,
        ledgerInfo(this.nextSeq() - 1),
        Date.now(),
      );
  };

  // The current epoch's ids are complete only if every message in it was
  // written by a server that records ids.  An older server can open this
  // database (H1a0 accepts the tables) and write messages without their ids,
  // so the open epoch records the newest seq written by this code
  // (ledger_seq).  If the stream has moved past it -- or its epoch was
  // changed elsewhere -- the ids are incomplete, and absence is never
  // claimed for that epoch.  Checked on open, before each write, and when
  // the epoch is closed.
  private verifyIdLedger = ({ epoch }: { epoch?: boolean } = {}): void => {
    const row = this.db
      .prepare(
        "SELECT id, epoch, first_seq, ids_complete, info_json FROM history_epochs WHERE last_seq IS NULL",
      )
      .get() as
      | {
          id: number;
          epoch: number;
          first_seq: number;
          ids_complete: number;
          info_json: string | null;
        }
      | undefined;
    if (row == null || row.ids_complete !== 1) return;
    let ledger = row.first_seq - 1;
    try {
      const info = JSON.parse(row.info_json ?? "null");
      if (Number.isSafeInteger(info?.ledger_seq)) ledger = info.ledger_seq;
    } catch {}
    if (
      this.nextSeq() - 1 > ledger ||
      (epoch && row.epoch !== this.currentEpoch())
    ) {
      this.db
        .prepare("UPDATE history_epochs SET ids_complete=0 WHERE id=?")
        .run(row.id);
    }
  };

  private createMessagesTable = () => {
    // time is in *seconds* since the epoch, since that is standard for sqlite.
    // ttl is in milliseconds.
    this.db.prepare(SCHEMA.messages).run();
    this.db.prepare(SCHEMA.idx_messages_key).run();
    this.db.prepare(SCHEMA.idx_messages_time).run();
  };

  private readSqliteCacheKiB = (): number => {
    const cacheRow = this.db.prepare("PRAGMA cache_size").get() as
      | { cache_size?: number }
      | undefined;
    const cacheSize = Number(cacheRow?.cache_size);
    if (!Number.isFinite(cacheSize)) {
      return 0;
    }
    if (cacheSize <= 0) {
      return Math.abs(cacheSize);
    }
    const pageRow = this.db.prepare("PRAGMA page_size").get() as
      | { page_size?: number }
      | undefined;
    const pageSize = Number(pageRow?.page_size);
    return Number.isFinite(pageSize)
      ? Math.ceil((cacheSize * pageSize) / 1024)
      : 0;
  };

  diagnosticSqliteFootprint = () => {
    const pageCount = Number(
      (
        this.db.prepare("PRAGMA page_count").get() as
          | { page_count?: number }
          | undefined
      )?.page_count ?? 0,
    );
    const freePageCount = Number(
      (
        this.db.prepare("PRAGMA freelist_count").get() as
          | { freelist_count?: number }
          | undefined
      )?.freelist_count ?? 0,
    );
    const pageSize = Number(
      (
        this.db.prepare("PRAGMA page_size").get() as
          | { page_size?: number }
          | undefined
      )?.page_size ?? 0,
    );
    const fileBytes = this.dbPath ? fileSize(this.dbPath) : 0;
    const walBytes = this.dbPath ? fileSize(`${this.dbPath}-wal`) : 0;
    const shmBytes = this.dbPath ? fileSize(`${this.dbPath}-shm`) : 0;
    return {
      kind: this.storageKind,
      page_bytes: pageCount * pageSize,
      live_page_bytes: Math.max(0, pageCount - freePageCount) * pageSize,
      freelist_bytes: freePageCount * pageSize,
      file_bytes: fileBytes,
      wal_bytes: walBytes,
      shm_bytes: shmBytes,
      message_bytes: this.totalSize(),
      messages: this.length,
    };
  };

  isClosing = (): boolean => this.closing;

  // The local path of the database (without .db); undefined once closed.
  localPath = (): string | undefined => this.options?.path;

  close = () => {
    const path = this.options?.path;
    if (path == null || this.closing) {
      return;
    }
    this.closing = true;
    logger.debug("close ", path);
    this.throttledBackup?.cancel?.();
    try {
      if (this.db != null) {
        // This must remain synchronous. refCacheSync removes the stream from
        // its cache as soon as close returns; yielding here allowed the same
        // SQLite path to reopen while this connection was still checkpointing
        // and closing. A full VACUUM on every disconnect was also unnecessary
        // churn and expanded the native SQLite failure surface.
        try {
          this.db.prepare("PRAGMA wal_checkpoint(FULL)").run();
        } catch (err) {
          logger.debug("WARNING: error checkpointing database on close", {
            path,
            err,
          });
        }
        let closed = false;
        try {
          this.db.close();
          closed = true;
        } catch (err) {
          logger.debug("WARNING: error closing database", { path, err });
        }
        if (closed) {
          this.backupClosedDatabase();
          for (const handle of this.maintenanceHandles.values()) {
            try {
              handle.onFinalClose(this.maintenanceDirty);
            } catch (err) {
              logger.debug("persist maintenance close hook failed", {
                path,
                err,
              });
            }
          }
        }
      }
    } finally {
      // @ts-ignore
      delete this.options;
      this.msgIDs?.clear();
      // @ts-ignore
      delete this.msgIDs;
      this.maintenanceHandles.clear();
      openPaths.delete(path);
      if (this.diagnosticsRegistered) {
        openStreams.delete(this);
        recordStreamClose(this.storageKind, this.sqliteCacheKiB);
        this.diagnosticsRegistered = false;
      }
    }
  };

  private backupClosedDatabase = (): void => {
    if (!this.dbPath) return;
    for (const destination of [this.options.archive, this.options.backup]) {
      if (!destination) continue;
      const dest = destination + ".db";
      try {
        // getStream creates these directories before opening the database.
        // Synchronous copies keep close atomic with respect to refCacheSync.
        assertSafeDatabasePath(this.dbPath);
        copyFileSync(this.dbPath, dest);
      } catch (err) {
        logger.warn("error creating backup while closing database", {
          source: this.dbPath,
          destination: dest,
          err,
        });
      }
    }
  };

  private backup = reuseInFlight(async (path?: string): Promise<void> => {
    if (this.options == null) {
      // can happen due to this.throttledBackup.
      return;
    }
    // reuseInFlight since probably doing a backup on top
    // of itself would corrupt data.
    if (path === undefined && !this.options.archive) {
      return;
    }
    if (!this.dbPath) {
      return;
    }
    const dest = (path ?? this.options.archive) + ".db";
    //console.log("backup", { path });
    try {
      await ensureContainingDirectoryExists(dest);
      if (this.closing) return;
      assertSafeDatabasePath(this.dbPath);
      copyFileSync(this.dbPath, dest);
    } catch (err) {
      if (!process.env.COCALC_TEST_MODE) {
        console.log(err);
      }
      logger.debug("WARNING: error creating a backup", dest, err);
    }
  });

  private runTransaction = <T>(fn: () => T): T => {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      this.markMaintenanceMutation();
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw err;
    }
  };

  private compress = (
    raw: Buffer,
  ): { raw: Buffer; compress: CompressionAlgorithm } => {
    if (
      this.options.compression!.algorithm == CompressionAlgorithm.None ||
      raw.length <= this.options.compression!.threshold
    ) {
      return { raw, compress: CompressionAlgorithm.None };
    }
    if (this.options.compression!.algorithm == CompressionAlgorithm.Zstd) {
      return { raw: compress(raw), compress: CompressionAlgorithm.Zstd };
    }
    throw Error(
      `unknown compression algorithm: ${this.options.compression!.algorithm}`,
    );
  };

  private setInternal = ({
    encoding,
    raw,
    headers,
    key,
    ttl,
    previousSeq,
    msgID,
    checkpoint,
    changes,
  }: {
    encoding: DataEncoding;
    raw: Buffer;
    headers?: JSONValue;
    key?: string;
    ttl?: number;
    previousSeq?: number;
    msgID?: string;
    checkpoint?: CheckpointUpdate;
    changes: ChangefeedOperation[];
  }): {
    time: number;
    seq: number;
  } => {
    if (previousSeq === null) {
      previousSeq = undefined;
    }
    if (key === null) {
      key = undefined;
    }
    if (msgID != null && this.msgIDs?.has(msgID)) {
      const existing = this.msgIDs.get(msgID)! as { seq: number; time: number };
      changes.push({
        seq: existing.seq,
        time: existing.time,
        key,
        encoding,
        raw,
        headers: headers == null ? undefined : (headers as Headers),
        msgID,
      });
      return {
        ...existing,
      };
    }
    this.checkRequiredHeaders(headers);
    if (key !== undefined && previousSeq !== undefined) {
      const { seq = 0 } =
        (this.db
          .prepare("SELECT seq FROM messages WHERE key=?")
          .get(key) as any) ?? {};
      if (seq != previousSeq) {
        throw new ConatError("wrong last sequence", {
          code: "wrong-last-sequence",
        });
      }
    }
    const serializedHeaders = JSON.stringify(headers);
    this.enforceLimits(messageSize({ serializedHeaders, raw, key }), changes);

    if (key !== undefined) {
      const replaced = this.db
        .prepare("DELETE FROM messages WHERE key = ? RETURNING seq")
        .all(key) as { seq: number }[];
      this.forgetSeqs(replaced.map(({ seq }) => seq));
    }
    const { time, seq } = this.insertMessage({
      encoding,
      raw,
      serializedHeaders,
      key,
      ttl,
      msgID,
      checkpoint,
    });
    changes.push({
      seq,
      time,
      key,
      encoding,
      raw,
      headers: headers == null ? undefined : (headers as Headers),
      msgID,
    });
    return {
      time,
      seq,
    };
  };

  // Insert one message, with its msg id and checkpoint, after all checks.
  private insertMessage = ({
    encoding,
    raw,
    serializedHeaders,
    key,
    ttl,
    msgID,
    checkpoint,
  }: {
    encoding: DataEncoding;
    raw: Buffer;
    serializedHeaders?: string;
    key?: string;
    ttl?: number;
    msgID?: string;
    checkpoint?: CheckpointUpdate;
  }): { time: number; seq: number } => {
    this.verifyIdLedger();
    const time = Date.now();
    const compressedRaw = this.compress(raw);
    const row = this.db
      .prepare(
        "INSERT INTO messages(time, compress, encoding, raw, headers, key, size, ttl) VALUES (?, ?, ?, ?, ?, ?, ?, ?)  RETURNING seq",
      )
      .get(
        time / 1000,
        compressedRaw.compress,
        encoding,
        compressedRaw.raw,
        serializedHeaders ?? null,
        key ?? null,
        messageSize({ serializedHeaders, raw, key }),
        ttl ?? null,
      );
    const seq = Number((row as any).seq);
    this.db
      .prepare("UPDATE history_epochs SET info_json=? WHERE last_seq IS NULL")
      .run(ledgerInfo(seq));
    if (msgID != null) {
      // persisted, so after a reset a client can learn which of its patches
      // the server accepted (historyInclusion)
      this.db
        .prepare("INSERT INTO message_ids(seq, msg_id) VALUES (?, ?)")
        .run(seq, msgID);
    }
    if (checkpoint != null) {
      this.writeCheckpoint({
        name: checkpoint.name,
        seq: checkpoint.seq ?? seq,
        time: checkpoint.time ?? time,
        data: checkpoint.data,
        snapshotSeq: seq,
      });
    }
    return { time, seq };
  };

  set = ({
    encoding,
    raw,
    headers,
    key,
    ttl,
    previousSeq,
    msgID,
    checkpoint,
  }: {
    encoding: DataEncoding;
    raw: Buffer;
    headers?: JSONValue;
    key?: string;
    ttl?: number;
    previousSeq?: number;
    // if given, any attempt to publish something again with the same msgID
    // is deduplicated. Use this to prevent accidentally writing twice, e.g.,
    // due to not getting a response back from the server.
    msgID?: string;
    checkpoint?: CheckpointUpdate;
  }): { seq: number; time: number } => {
    const changes: ChangefeedOperation[] = [];
    const result = this.runTransaction(() =>
      this.setInternal({
        encoding,
        raw,
        headers,
        key,
        ttl,
        previousSeq,
        msgID,
        checkpoint,
        changes,
      }),
    );
    for (const change of changes) {
      this.emit("change", change);
    }
    if (changes.length > 0) {
      this.throttledBackup();
    }
    if (msgID !== undefined) {
      this.msgIDs.set(msgID, { time: result.time, seq: result.seq });
    }
    return { time: result.time, seq: result.seq };
  };

  setMany = (
    operations: Array<{
      encoding: DataEncoding;
      raw: Buffer;
      headers?: JSONValue;
      key?: string;
      ttl?: number;
      previousSeq?: number;
      msgID?: string;
      checkpoint?: CheckpointUpdate;
    }>,
  ): Array<{ seq: number; time: number } | { error: string; code?: any }> => {
    const changes: ChangefeedOperation[] = [];
    const msgIds: Array<{ msgID: string; time: number; seq: number }> = [];
    const results = this.runTransaction(() =>
      operations.map((operation) => {
        try {
          const result = this.setInternal({ ...operation, changes });
          if (operation.msgID !== undefined) {
            msgIds.push({
              msgID: operation.msgID,
              time: result.time,
              seq: result.seq,
            });
          }
          return { time: result.time, seq: result.seq };
        } catch (err) {
          return { error: `${err}`, code: err.code };
        }
      }),
    );
    for (const change of changes) {
      this.emit("change", change);
    }
    if (changes.length > 0) {
      this.throttledBackup();
    }
    for (const { msgID, time, seq } of msgIds) {
      this.msgIDs.set(msgID, { time, seq });
    }
    return results;
  };

  private checkRequiredHeaders = (headers?: JSONValue): void => {
    const required = this.conf.required_headers as
      | Record<string, unknown>
      | null
      | undefined;
    if (required == null || typeof required !== "object") {
      return;
    }
    const provided =
      headers != null && typeof headers === "object"
        ? (headers as Record<string, unknown>)
        : {};
    for (const [key, expected] of Object.entries(required)) {
      if (!Object.is(provided[key], expected)) {
        throw new ConatError(`required header mismatch for '${key}'`, {
          code: "reject",
        });
      }
    }
  };

  get = ({
    seq,
    key,
  }: { seq: number; key: undefined } | { seq: undefined; key: string }):
    | StoredMessage
    | undefined => {
    const ttl = this.conf.allow_msg_ttl ? ", ttl" : "";
    // Check the size before reading the (possibly huge) data.
    let meta: { seq: number; size: number } | undefined;
    if (seq) {
      meta = this.db
        .prepare(
          `SELECT seq, ${EFFECTIVE_SIZE_SQL} AS size FROM messages WHERE seq=?`,
        )
        .get(seq) as any;
    } else if (key != null) {
      // NOTE: we guarantee when doing set above that there is at most one
      // row with a given key.  Also there's a unique constraint.
      meta = this.db
        .prepare(
          `SELECT seq, ${EFFECTIVE_SIZE_SQL} AS size FROM messages WHERE key=?`,
        )
        .get(key) as any;
    }
    if (meta == null) {
      return undefined;
    }
    const sizeLimit = maxPersistMessageBytes();
    if (Number(meta.size) > sizeLimit) {
      throw persistMessageTooLargeError({
        size: Number(meta.size),
        limit: sizeLimit,
        seq: Number(meta.seq),
      });
    }
    const x = this.db
      .prepare(
        `SELECT seq, key, time, compress, encoding, raw, headers${ttl} FROM messages WHERE seq=?`,
      )
      .get(meta.seq);
    return dbToMessage(x as any, Number(meta.size));
  };

  seqBounds = (): StreamSeqBounds => {
    const row = this.db
      .prepare(
        "SELECT MIN(seq) AS oldest_retained_seq, MAX(seq) AS newest_retained_seq FROM messages",
      )
      .get() as
      | {
          oldest_retained_seq?: number | null;
          newest_retained_seq?: number | null;
        }
      | undefined;
    return {
      oldest_retained_seq:
        row?.oldest_retained_seq == null
          ? undefined
          : Number(row.oldest_retained_seq),
      newest_retained_seq:
        row?.newest_retained_seq == null
          ? undefined
          : Number(row.newest_retained_seq),
    };
  };

  // Plan one page of a replay from message sizes alone (cheap; no message
  // data is read): the messages after after_seq through end_seq, ending once
  // their uncompressed sizes reach maxBytes but always including at least one.
  planPage = ({
    after_seq,
    end_seq,
    maxRows,
    maxBytes,
  }: {
    after_seq: number;
    end_seq?: number;
    maxRows: number;
    maxBytes: number;
  }): { seq: number; size: number }[] => {
    const where = "seq>?" + (end_seq != null ? " AND seq<=?" : "");
    const params = end_seq != null ? [after_seq, end_seq] : [after_seq];
    const sizes = this.db
      .prepare(
        `SELECT seq, ${EFFECTIVE_SIZE_SQL} AS size FROM messages WHERE ${where} ORDER BY seq LIMIT ?`,
      )
      .all(...params, maxRows) as { seq: number; size: number }[];
    const page: { seq: number; size: number }[] = [];
    let bytes = 0;
    for (const row of sizes) {
      const size = Number(row.size);
      bytes += size;
      if (bytes > maxBytes && page.length > 0) {
        break;
      }
      page.push({ seq: Number(row.seq), size });
    }
    return page;
  };

  // Read the messages with after_seq < seq <= last_seq.  A complete query, so
  // a caller can yield between pages without holding a SQLite iterator open.
  readPage = (after_seq: number, last_seq: number): StoredRow[] => {
    return this.db
      .prepare(
        `SELECT seq, key, time, compress, encoding, raw, headers, ${EFFECTIVE_SIZE_SQL} AS size FROM messages WHERE seq>? AND seq<=? ORDER BY seq`,
      )
      .all(after_seq, last_seq) as unknown as StoredRow[];
  };

  *getAll({
    start_seq,
    end_seq,
  }: {
    end_seq?: number;
    start_seq?: number;
  } = {}): IterableIterator<StoredMessage> {
    let query: string, stmt;

    const where: string[] = [];
    const v: number[] = [];
    if (start_seq != null) {
      where.push("seq>=?");
      v.push(start_seq);
    }
    if (end_seq != null) {
      where.push("seq<=?");
      v.push(end_seq);
    }
    // Check sizes before reading any (possibly huge) data.
    const sizeLimit = maxPersistMessageBytes();
    const whereSql = where.length == 0 ? "" : " where " + where.join(" AND ");
    const tooLarge = [...where, `${EFFECTIVE_SIZE_SQL} > ?`].join(" AND ");
    const oversized = this.db
      .prepare(
        `SELECT seq, ${EFFECTIVE_SIZE_SQL} AS size FROM messages WHERE ${tooLarge} ORDER BY seq LIMIT 1`,
      )
      .get(...v, sizeLimit) as { seq: number; size: number } | undefined;
    if (oversized != null) {
      throw persistMessageTooLargeError({
        size: Number(oversized.size),
        limit: sizeLimit,
        seq: Number(oversized.seq),
      });
    }
    query = `SELECT seq, key, time, compress, encoding, raw, headers, ${EFFECTIVE_SIZE_SQL} AS size FROM messages ${whereSql} ORDER BY seq`;
    stmt = this.db.prepare(query);
    for (const row of stmt.iterate(...v)) {
      yield dbToMessage(row, Number(row.size))!;
    }
  }

  delete = ({
    seq,
    seqs: seqs0,
    last_seq,
    all,
  }: {
    seq?: number;
    seqs?: number[];
    last_seq?: number;
    all?: boolean;
  }): { seqs: number[] } => {
    // SQLite reuses freed pages. Do not run a full VACUUM while this live
    // stream is open; physical compaction must be coordinated offline.
    let seqs: number[] = [];
    if (all) {
      this.runTransaction(() => {
        seqs = this.db
          .prepare("SELECT seq FROM messages")
          .all()
          .map((row: any) => row.seq);
        this.db.prepare("DELETE FROM messages").run();
        this.db.prepare("DELETE FROM stream_checkpoints").run();
        this.forgetSeqs(seqs);
      });
    } else if (last_seq) {
      this.runTransaction(() => {
        seqs = this.db
          .prepare("SELECT seq FROM messages WHERE seq<=?")
          .all(last_seq)
          .map((row: any) => row.seq);
        this.db.prepare("DELETE FROM messages WHERE seq<=?").run(last_seq);
        this.deleteCheckpointsInSeqs(seqs);
      });
    } else if (seq) {
      this.runTransaction(() => {
        seqs = this.db
          .prepare("SELECT seq FROM messages WHERE seq=?")
          .all(seq)
          .map((row: any) => row.seq);
        this.db.prepare("DELETE FROM messages WHERE seq=?").run(seq);
        this.deleteCheckpointsInSeqs(seqs);
      });
    } else if (seqs0) {
      const statement = this.db.prepare("DELETE FROM messages WHERE seq=?");
      this.runTransaction(() => {
        for (const s of seqs0) {
          statement.run(s);
        }
        this.deleteCheckpointsInSeqs(seqs0);
      });
      seqs = seqs0;
    }
    this.emit("change", { op: "delete", seqs });
    this.throttledBackup();
    return { seqs };
  };

  // Reset the history of a sync document -- TimeTravel's "purge history", and
  // the automatic reset of a history that cannot be loaded -- in one
  // transaction, so concurrent resets and writers cannot interleave:
  //  - check the conditions: ifOversizedSeq, ifInitEpoch, ifRevision, and that
  //    a seed covers every accepted message (coveredSeq); a repeated opId
  //    returns the first result;
  //  - fence: only writes with the new history_epoch header are accepted from
  //    now on, so copies of the document opened before cannot add to the new
  //    history;
  //  - publish the new epoch in the metadata, so those copies close;
  //  - delete the old messages, or archive them as loadable segments (what is
  //    in no loadable segment is removed, and counted), within
  //    maxArchiveBytes;
  //  - insert the seed, with its checkpoint, as the first message of the new
  //    history.
  // A crash leaves either the old history or the new seeded one.  A reset
  // that does not archive also drops the history kept by earlier resets, so
  // purging still means the history is gone.
  resetHistory = ({
    minEpoch = 0,
    settings,
    ifOversizedSeq,
    archive,
    ifRevision,
    ifInitEpoch,
    seed,
    coveredSeq,
    allowRollback,
    opId,
    reason,
  }: ResetHistoryOptions = {}): ResetHistoryResult => {
    if (
      opId != null &&
      (typeof opId !== "string" || opId.length == 0 || opId.length > 200)
    ) {
      throw new ConatError("resetHistory: invalid opId", { code: 400 });
    }
    if (
      coveredSeq != null &&
      !(Number.isSafeInteger(coveredSeq) && coveredSeq >= 0)
    ) {
      throw new ConatError("resetHistory: invalid coveredSeq", { code: 400 });
    }
    if (seed != null && coveredSeq == null) {
      throw new ConatError("resetHistory: a seed requires coveredSeq", {
        code: 400,
      });
    }
    const limits = historyLimits();
    let result: ResetHistoryResult | undefined;
    let metadata: JSONValue | undefined;
    let seqs: number[] = [];
    let seedChange = undefined as SetOperation | undefined;
    this.runTransaction(() => {
      if (opId != null) {
        const done = this.db
          .prepare("SELECT result_json FROM history_ops WHERE op_id=?")
          .get(opId) as { result_json: string } | undefined;
        if (done != null) {
          result = { ...JSON.parse(done.result_json), repeated: true };
          return;
        }
      }
      const fence = isPlainRecord(this.conf.required_headers)
        ? this.conf.required_headers
        : {};
      const current = this.getMetadata();
      const currentRecord = isPlainRecord(current) ? current : {};
      const currentSettings = isPlainRecord(currentRecord.settings)
        ? currentRecord.settings
        : {};
      const currentEpoch = Math.max(epochOf(currentSettings), epochOf(fence));
      const refuse = (refused: ResetHistoryRefusal) => {
        result = {
          reset: false,
          history_epoch: currentEpoch,
          count: 0,
          refused,
        };
      };
      if (ifOversizedSeq != null) {
        const row = this.db
          .prepare(
            `SELECT ${EFFECTIVE_SIZE_SQL} AS size FROM messages WHERE seq=?`,
          )
          .get(ifOversizedSeq) as { size: number } | undefined;
        if (row == null || !(row.size > maxPersistMessageBytes())) {
          refuse("not-oversized");
          return;
        }
      }
      if (ifInitEpoch != null && ifInitEpoch !== currentEpoch) {
        refuse("epoch");
        return;
      }
      const newest = this.seq();
      if (
        ifRevision != null &&
        (ifRevision.seq !== newest || ifRevision.count !== this.length)
      ) {
        refuse("moved");
        return;
      }
      if (
        coveredSeq != null &&
        (coveredSeq > newest || (coveredSeq < newest && !allowRollback))
      ) {
        refuse("moved");
        return;
      }
      let seedRaw: Buffer | undefined;
      let seedHeaders: string | undefined;
      if (seed != null) {
        seedRaw = Buffer.isBuffer(seed.raw)
          ? seed.raw
          : Buffer.from(seed.raw.buffer, seed.raw.byteOffset, seed.raw.length);
        if (seed.headers != null && !isPlainRecord(seed.headers)) {
          refuse("seed-invalid");
          return;
        }
        seedHeaders = JSON.stringify({ ...seed.headers });
        if (
          messageSize({ serializedHeaders: seedHeaders, raw: seedRaw }) >
          limits.maxSnapshotBytes
        ) {
          refuse("seed-too-large");
          return;
        }
        let obj: unknown;
        try {
          obj = decode({ encoding: seed.encoding, data: seedRaw });
        } catch {
          obj = undefined;
        }
        if (!isSnapshotPatch(obj)) {
          refuse("seed-invalid");
          return;
        }
      }

      // before the new epoch is published: are the closing epoch's ids
      // complete?
      this.verifyIdLedger({ epoch: true });
      const history_epoch = Math.max(minEpoch, currentEpoch) + 1;
      this.db
        .prepare(
          `INSERT INTO config (field, value) VALUES('required_headers', ?) ON CONFLICT(field) DO UPDATE SET value=excluded.value`,
        )
        .run(JSON.stringify({ ...fence, history_epoch }));
      metadata = {
        ...currentRecord,
        settings: { ...currentSettings, ...settings, history_epoch },
      };
      this.db
        .prepare(
          `
          INSERT INTO stream_metadata(id, metadata_json, revision)
          VALUES (1, ?, 1)
          ON CONFLICT(id) DO UPDATE SET
            metadata_json=excluded.metadata_json,
            revision=stream_metadata.revision + 1
        `,
        )
        .run(JSON.stringify(metadata));
      // seq is the rowid, so this does not read the (possibly huge) messages
      seqs = this.db
        .prepare("SELECT seq FROM messages")
        .all()
        .map((row: any) => row.seq);

      // close the current epoch: its messages, and what the seed covers
      const lastSeq = this.nextSeq() - 1;
      const closing = this.db
        .prepare("SELECT id FROM history_epochs WHERE last_seq IS NULL")
        .get() as { id: number };
      this.db
        .prepare(
          "UPDATE history_epochs SET last_seq=?, covered_seq=?, info_json=? WHERE id=?",
        )
        .run(
          lastSeq,
          seed != null ? coveredSeq! : null,
          JSON.stringify({
            reason: typeof reason === "string" ? reason.slice(0, 200) : null,
          }),
          closing.id,
        );

      let archiveTable: string | undefined;
      let archived:
        | {
            segments: number;
            dropped: { records: number; bytes: number };
            droppedArchived: { records: number; bytes: number };
          }
        | undefined;
      if (archive) {
        // Renaming keeps the old messages where they are: nothing is copied,
        // so this is fast and needs no disk space.  New messages continue
        // the old sequence numbers.
        archiveTable = this.unusedArchiveTableName();
        const last = (
          this.db
            .prepare("SELECT seq FROM sqlite_sequence WHERE name='messages'")
            .get() as { seq?: number } | undefined
        )?.seq;
        this.db.exec(`ALTER TABLE messages RENAME TO "${archiveTable}"`);
        this.db.exec("DROP INDEX IF EXISTS idx_messages_key");
        this.db.exec("DROP INDEX IF EXISTS idx_messages_time");
        this.createMessagesTable();
        if (last != null) {
          this.db
            .prepare(
              "INSERT INTO sqlite_sequence(name, seq) VALUES('messages', ?)",
            )
            .run(last);
        }
        this.db
          .prepare("UPDATE history_epochs SET archive=? WHERE id=?")
          .run(archiveTable, closing.id);
        const { segments, dropped } = this.segmentArchive(
          closing.id,
          archiveTable,
          limits,
        );
        if (segments == 0) {
          archiveTable = undefined;
        }
        const quota = this.enforceArchiveQuota(limits);
        const trimmed = this.trimArchivedHistory(limits);
        archived = {
          segments,
          dropped,
          droppedArchived: {
            records: quota.records + trimmed.records,
            bytes: quota.bytes + trimmed.bytes,
          },
        };
      } else {
        const bytes = this.totalSize();
        this.db.prepare("DELETE FROM messages").run();
        this.dropArchivedHistory(limits);
        this.db
          .prepare(
            "UPDATE history_epochs SET dropped_records=?, dropped_bytes=? WHERE id=?",
          )
          .run(seqs.length, bytes, closing.id);
        // purged: nothing is evidence of what was accepted any more
        this.db.prepare("DELETE FROM message_ids").run();
        this.db.prepare("UPDATE history_epochs SET ids_complete=0").run();
      }
      this.db.prepare("DELETE FROM stream_checkpoints").run();
      this.db.prepare("DELETE FROM history_cuts WHERE seq<=?").run(lastSeq);
      this.expireArchivedIds(limits);
      this.pruneEpochRows();

      // the new epoch, starting with its seed
      const { lastInsertRowid: epochId } = this.db
        .prepare(
          "INSERT INTO history_epochs(epoch, first_seq, starts_empty, ids_complete, info_json, time) VALUES (?, ?, ?, 1, ?, ?)",
        )
        .run(
          history_epoch,
          lastSeq + 1,
          seed != null ? 0 : 1,
          ledgerInfo(lastSeq),
          Date.now(),
        );
      let seedSeq: number | undefined;
      if (seed != null) {
        const headers = { ...seed.headers, history_epoch };
        const serializedHeaders = JSON.stringify(headers);
        const inserted = this.insertMessage({
          encoding: seed.encoding,
          raw: seedRaw!,
          serializedHeaders,
          msgID: seed.msgID,
          checkpoint:
            seed.checkpoint != null
              ? { name: seed.checkpoint.name, data: seed.checkpoint.data }
              : undefined,
        });
        seedSeq = inserted.seq;
        this.db
          .prepare(
            "INSERT OR REPLACE INTO history_cuts(seq, snapshot_seq) VALUES (?, ?)",
          )
          .run(seedSeq, seedSeq);
        this.db
          .prepare("UPDATE history_epochs SET seed_seq=? WHERE id=?")
          .run(seedSeq, epochId);
        seedChange = {
          seq: seedSeq,
          time: inserted.time,
          encoding: seed.encoding,
          raw: seedRaw!,
          headers: headers as Headers,
          msgID: seed.msgID,
        };
      }

      result = {
        reset: true,
        history_epoch,
        count: seqs.length,
        ...(archiveTable != null ? { archive: archiveTable } : {}),
        ...(seedSeq != null ? { seedSeq, coveredSeq } : {}),
        ...(archived ?? {}),
      };
      if (opId != null) {
        this.db
          .prepare(
            "INSERT INTO history_ops(op_id, result_json, time) VALUES (?, ?, ?)",
          )
          .run(opId, JSON.stringify(result), Date.now());
        this.db
          .prepare(
            `DELETE FROM history_ops WHERE op_id NOT IN (SELECT op_id FROM history_ops ORDER BY time DESC, op_id LIMIT ${MAX_HISTORY_OPS})`,
          )
          .run();
      }
    });
    if (!result!.reset || result!.repeated) {
      return result!;
    }
    this.msgIDs.clear();
    if (seedChange?.msgID != null) {
      this.msgIDs.set(seedChange.msgID, {
        time: seedChange.time,
        seq: seedChange.seq,
      });
    }
    // reload the configuration, so the new fence is enforced
    this.config();
    // metadata first: open copies of the document close on the new epoch
    // rather than react to their history disappearing
    this.emit("change", { op: "metadata", metadata });
    this.emit("change", { op: "delete", seqs });
    this.emit("change", {
      op: "checkpoints",
      checkpoints: this.getCheckpoints(),
    });
    if (seedChange != null) {
      this.emit("change", seedChange);
    }
    this.throttledBackup();
    return result!;
  };

  // Split the archived epoch into segments: maximal stretches that load
  // within an open's budget (bounded history design §3.2, §4.5), each
  // starting at a cut -- a checkpoint, whose snapshot is written with it --
  // or at the empty document if nothing was ever removed from the epoch's
  // start.  Messages in no segment cannot be loaded, so they are removed.
  // Heads and parents are not known here; the loader still verifies a cut.
  //
  // Only the newest stretch that the archive bounds could keep is scanned:
  // at most maxArchiveRecords messages, newest first, by seq and size alone.
  // An epoch from before these bounds can be far larger; what is older than
  // that stretch is left to trimArchivedHistory, which removes it a bounded
  // amount at a time.
  private segmentArchive = (
    epochId: number,
    table: string,
    limits: HistoryLimits,
  ): { segments: number; dropped: { records: number; bytes: number } } => {
    const epoch = this.db
      .prepare("SELECT starts_empty FROM history_epochs WHERE id=?")
      .get(epochId) as { starts_empty: number };
    let tailStart: number | undefined;
    let tailRecords = 0;
    let tailBytes = 0;
    let charged = ARCHIVE_TABLE_OVERHEAD_BYTES;
    for (const row of this.db
      .prepare(
        `SELECT seq, ${EFFECTIVE_SIZE_SQL} AS size FROM "${table}" ORDER BY seq DESC`,
      )
      .iterate() as Iterable<{ seq: number; size: number }>) {
      charged += Number(row.size) + ARCHIVE_RECORD_OVERHEAD_BYTES;
      if (
        tailRecords + 1 > limits.maxArchiveRecords ||
        charged > limits.maxArchiveBytes
      ) {
        break;
      }
      tailStart = Number(row.seq);
      tailRecords += 1;
      tailBytes += Number(row.size);
    }
    if (tailStart == null) {
      // nothing can be kept: the whole table is left to trimArchivedHistory
      return { segments: 0, dropped: { records: 0, bytes: 0 } };
    }
    const { first } = this.db
      .prepare(`SELECT MIN(seq) AS first FROM "${table}"`)
      .get() as { first: number };
    // the empty document is a cut only if the scan starts at the epoch's start
    const startsEmpty = epoch.starts_empty && Number(first) === tailStart;
    // the current snapshot checkpoint is a cut too (e.g., in streams from
    // before history_cuts)
    this.db
      .prepare(
        "INSERT OR IGNORE INTO history_cuts(seq) SELECT seq FROM stream_checkpoints WHERE name=?",
      )
      .run(SNAPSHOT_CHECKPOINT);

    interface Run {
      first: number;
      last: number;
      cut?: number;
      // the snapshot written with the cut; undefined for the empty document,
      // and for a cut whose snapshot is not known (then assume the largest
      // message)
      snap?: number;
      hasSnapshot: boolean;
      seen: boolean;
      snapBytes: number;
      bytes: number;
      records: number;
      maxBytes: number;
    }
    const startRun = (row: {
      seq: number;
      snapshot_seq: number | null;
    }): Run => ({
      first: row.seq,
      last: row.seq,
      cut: row.seq,
      snap: row.snapshot_seq ?? undefined,
      hasSnapshot: true,
      seen: row.snapshot_seq == null,
      snapBytes: 0,
      bytes: 0,
      records: 0,
      maxBytes: 0,
    });
    const add = (run: Run, seq: number, size: number) => {
      if (run.records == 0) run.first = seq;
      run.last = seq;
      run.bytes += size;
      run.records += 1;
      run.maxBytes = Math.max(run.maxBytes, size);
      if (run.snap === seq) {
        run.seen = true;
        run.snapBytes = size;
      }
    };
    const cutBytes = (run: Run) =>
      run.hasSnapshot && run.snap == null ? run.maxBytes : run.snapBytes;
    const fits = (run: Run) =>
      cutBytes(run) <= limits.maxSnapshotBytes &&
      run.bytes - cutBytes(run) <= limits.maxSuffixBytes &&
      run.records - (run.hasSnapshot ? 1 : 0) <= limits.maxOpenRecords;
    const good = (run: Run) => run.records > 0 && run.seen && fits(run);
    const freeze = (run: Run): ArchivedHistorySegment => ({
      first_seq: run.first,
      last_seq: run.last,
      cut_seq: run.cut,
      snapshot_seq: run.snap,
      cut_bytes: cutBytes(run),
      suffix_bytes: run.bytes - cutBytes(run),
      records: run.records,
    });

    // Segments are written as they are found, so memory stays bounded however
    // many there are (enforceArchiveQuota then bounds how many are kept).
    const insert = this.db.prepare(
      "INSERT INTO history_segments(epoch_id, first_seq, last_seq, cut_seq, snapshot_seq, cut_bytes, suffix_bytes, records) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    let segments = 0;
    const kept = { records: 0, bytes: 0 };
    const emit = (s: ArchivedHistorySegment) => {
      insert.run(
        epochId,
        s.first_seq,
        s.last_seq,
        s.cut_seq ?? null,
        s.snapshot_seq ?? null,
        s.cut_bytes,
        s.suffix_bytes,
        s.records,
      );
      segments += 1;
      kept.records += s.records;
      kept.bytes += s.cut_bytes + s.suffix_bytes;
    };
    // the segment being extended
    let cur: Run | null = startsEmpty
      ? {
          first: 0,
          last: 0,
          hasSnapshot: false,
          seen: true,
          snapBytes: 0,
          bytes: 0,
          records: 0,
          maxBytes: 0,
        }
      : null;
    // cur as it was just before the latest cut inside it, if loadable then
    let atCut: ArchivedHistorySegment | null = null;
    // cur as it was at the latest message where it was loadable
    let lastGood: ArchivedHistorySegment | null = null;
    // a segment starting at the latest cut inside cur
    let tail: Run | null = null;
    for (const row of this.db
      .prepare(
        `SELECT m.seq AS seq, ${EFFECTIVE_SIZE_SQL} AS size, c.seq AS cut, c.snapshot_seq AS snapshot_seq FROM "${table}" AS m LEFT JOIN history_cuts AS c ON c.seq = m.seq WHERE m.seq >= ? ORDER BY m.seq`,
      )
      .iterate(tailStart) as Iterable<{
      seq: number;
      size: number;
      cut: number | null;
      snapshot_seq: number | null;
    }>) {
      const seq = Number(row.seq);
      const size = Number(row.size);
      if (row.cut != null) {
        if (cur == null) {
          cur = startRun(row);
          atCut = lastGood = tail = null;
        } else {
          if (cur.records > 0) {
            atCut = good(cur) ? freeze(cur) : null;
          }
          tail = startRun(row);
        }
      }
      if (cur != null) add(cur, seq, size);
      if (tail != null && tail !== cur) add(tail, seq, size);
      while (cur != null && !fits(cur)) {
        if (atCut != null) {
          // end at the latest cut, and continue from it
          emit(atCut);
          cur = tail;
        } else {
          // the loadable start of cur, if any; the rest up to the next cut
          // cannot be loaded
          if (lastGood != null) emit(lastGood);
          cur =
            tail != null && (lastGood == null || tail.first > lastGood.last_seq)
              ? tail
              : null;
        }
        tail = atCut = lastGood = null;
      }
      if (cur != null && good(cur)) {
        lastGood = freeze(cur);
      }
    }
    if (cur != null && good(cur)) {
      emit(freeze(cur));
    } else if (tail != null && good(tail)) {
      emit(freeze(tail));
    }

    // remove the messages of the scanned stretch that are in no segment
    const dropped = {
      records: tailRecords - kept.records,
      bytes: tailBytes - kept.bytes,
    };
    const deleteRange = this.db.prepare(
      `DELETE FROM "${table}" WHERE seq BETWEEN ? AND ?`,
    );
    let from = tailStart;
    for (const s of this.db
      .prepare(
        "SELECT first_seq, last_seq FROM history_segments WHERE epoch_id=? ORDER BY first_seq",
      )
      .iterate(epochId) as Iterable<{ first_seq: number; last_seq: number }>) {
      if (s.first_seq > from) deleteRange.run(from, s.first_seq - 1);
      from = s.last_seq + 1;
    }
    deleteRange.run(from, Number.MAX_SAFE_INTEGER);
    // with no segment, the table is left to trimArchivedHistory
    this.db
      .prepare(
        "UPDATE history_epochs SET archive=?, kept_records=?, kept_bytes=?, dropped_records=?, dropped_bytes=? WHERE id=?",
      )
      .run(
        segments > 0 ? table : null,
        kept.records,
        kept.bytes,
        dropped.records,
        dropped.bytes,
        epochId,
      );
    return { segments, dropped };
  };

  // Archived history per stream is bounded in bytes (with a conservative
  // charge for each record's and table's own overhead), records, segments
  // and archives.  Over a bound, the oldest goes first: segment by segment,
  // then whole archives.  Each removal deletes one segment's rows, which are
  // within an open's envelope.  An archive left without segments, with
  // whatever else its table holds, becomes an archive without an index, and
  // trimArchivedHistory removes it a bounded amount at a time.  Only the
  // counts kept in history_epochs are read: nothing is scanned or measured.
  private enforceArchiveQuota = (
    limits: HistoryLimits,
  ): { records: number; bytes: number } => {
    const dropped = { records: 0, bytes: 0 };
    const charge = (records: number, bytes: number) =>
      bytes + ARCHIVE_RECORD_OVERHEAD_BYTES * records;
    const totals = this.db
      .prepare(
        "SELECT COUNT(*) AS tables, SUM(kept_records) AS records, SUM(kept_bytes) AS bytes FROM history_epochs WHERE archive IS NOT NULL",
      )
      .get() as {
      tables: number;
      records: number | null;
      bytes: number | null;
    };
    const usage = {
      tables: Number(totals.tables),
      records: Number(totals.records ?? 0),
      bytes:
        charge(Number(totals.records ?? 0), Number(totals.bytes ?? 0)) +
        ARCHIVE_TABLE_OVERHEAD_BYTES * Number(totals.tables),
      segments: Number(
        (
          this.db
            .prepare("SELECT COUNT(*) AS n FROM history_segments")
            .get() as { n: number }
        ).n,
      ),
    };
    const unregister = (epochId: number) => {
      this.db
        .prepare("UPDATE history_epochs SET archive=NULL WHERE id=?")
        .run(epochId);
      usage.tables -= 1;
      usage.bytes -= ARCHIVE_TABLE_OVERHEAD_BYTES;
    };
    const oldest = this.db.prepare(
      "SELECT s.epoch_id AS epoch_id, s.first_seq AS first_seq, s.last_seq AS last_seq, s.records AS records, s.cut_bytes + s.suffix_bytes AS bytes, e.archive AS archive FROM history_segments AS s JOIN history_epochs AS e ON e.id = s.epoch_id ORDER BY s.epoch_id, s.first_seq LIMIT 1",
    );
    const dropSegment = (s: {
      epoch_id: number;
      first_seq: number;
      last_seq: number;
      records: number;
      bytes: number;
      archive: string | null;
    }) => {
      const table = archiveTableName(s.archive);
      if (table != null) {
        this.db
          .prepare(`DELETE FROM "${table}" WHERE seq BETWEEN ? AND ?`)
          .run(s.first_seq, s.last_seq);
      }
      this.db
        .prepare(
          "DELETE FROM history_segments WHERE epoch_id=? AND first_seq=?",
        )
        .run(s.epoch_id, s.first_seq);
      this.db
        .prepare(
          "UPDATE history_epochs SET kept_records=kept_records-?, kept_bytes=kept_bytes-?, dropped_records=dropped_records+?, dropped_bytes=dropped_bytes+? WHERE id=?",
        )
        .run(s.records, s.bytes, s.records, s.bytes, s.epoch_id);
      usage.segments -= 1;
      usage.records -= Number(s.records);
      usage.bytes -= charge(Number(s.records), Number(s.bytes));
      dropped.records += Number(s.records);
      dropped.bytes += Number(s.bytes);
    };
    const over = () =>
      usage.bytes > limits.maxArchiveBytes ||
      usage.records > limits.maxArchiveRecords ||
      usage.segments > limits.maxArchiveSegments;
    while (over()) {
      const s = oldest.get() as Parameters<typeof dropSegment>[0] | undefined;
      if (s == null) break;
      dropSegment(s);
      if (
        this.db
          .prepare("SELECT 1 FROM history_segments WHERE epoch_id=? LIMIT 1")
          .get(s.epoch_id) == null
      ) {
        unregister(s.epoch_id);
      }
    }
    // and at most MAX_ARCHIVED_EPOCHS archives, however small
    for (const e of this.db
      .prepare(
        "SELECT id FROM history_epochs WHERE archive IS NOT NULL ORDER BY id LIMIT ?",
      )
      .all(Math.max(0, usage.tables - MAX_ARCHIVED_EPOCHS)) as {
      id: number;
    }[]) {
      for (const s of this.db
        .prepare(
          "SELECT s.epoch_id AS epoch_id, s.first_seq AS first_seq, s.last_seq AS last_seq, s.records AS records, s.cut_bytes + s.suffix_bytes AS bytes, e.archive AS archive FROM history_segments AS s JOIN history_epochs AS e ON e.id = s.epoch_id WHERE s.epoch_id=? ORDER BY s.first_seq",
        )
        .all(e.id) as Parameters<typeof dropSegment>[0][]) {
        dropSegment(s);
      }
      unregister(e.id);
    }
    return dropped;
  };

  // Remove archived history that has no index a bounded amount at a time:
  // archives from before segments, archives whose segments were all removed,
  // and the part of an archive older than its segments (an epoch larger than
  // the archive bounds).  Each call deletes at most maxTrimRecords messages
  // and maxTrimBytes (and at least one message, of at most the largest
  // message size), oldest first, and drops a table once it is empty.  Runs
  // when a stream opens, after each reset, and on purge, so a stream from
  // before the archive bounds reaches them in bounded steps.
  private trimArchivedHistory = (
    limits: HistoryLimits,
  ): { records: number; bytes: number; done: boolean } => {
    const trimmed = { records: 0, bytes: 0 };
    let records = limits.maxTrimRecords;
    let bytes = limits.maxTrimBytes;
    // delete the oldest rows below `below`; true if none are left
    const trim = (table: string, below: number): boolean => {
      while (records > 0 && bytes > 0) {
        const page = this.db
          .prepare(
            `SELECT seq, ${EFFECTIVE_SIZE_SQL} AS size FROM "${table}" WHERE seq < ? ORDER BY seq LIMIT ?`,
          )
          .all(below, Math.min(records, 1000)) as {
          seq: number;
          size: number;
        }[];
        if (page.length == 0) return true;
        let last: number | undefined;
        for (const row of page) {
          const size = Number(row.size);
          if (last != null && size > bytes) break;
          last = Number(row.seq);
          records -= 1;
          bytes -= size;
          trimmed.records += 1;
          trimmed.bytes += size;
        }
        this.db
          .prepare(`DELETE FROM "${table}" WHERE seq <= ? AND seq < ?`)
          .run(last!, below);
      }
      return (
        this.db
          .prepare(`SELECT 1 FROM "${table}" WHERE seq < ? LIMIT 1`)
          .get(below) == null
      );
    };
    // the older part of each indexed archive (at most MAX_ARCHIVED_EPOCHS)
    for (const e of this.db
      .prepare(
        "SELECT e.archive AS archive, (SELECT MIN(first_seq) FROM history_segments AS s WHERE s.epoch_id = e.id) AS lo FROM history_epochs AS e WHERE e.archive IS NOT NULL ORDER BY e.id",
      )
      .all() as { archive: string; lo: number | null }[]) {
      const table = archiveTableName(e.archive);
      if (table == null || e.lo == null) continue;
      if (!trim(table, e.lo)) return { ...trimmed, done: false };
    }
    // archives without an index, oldest first, a few names at a time
    const unindexed = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'messages_archived_%' AND name NOT IN (SELECT archive FROM history_epochs WHERE archive IS NOT NULL) ORDER BY name LIMIT 8",
    );
    while (records > 0 && bytes > 0) {
      const names = (unindexed.all() as { name: string }[])
        .map(({ name }) => archiveTableName(name))
        .filter((name): name is string => name != null);
      if (names.length == 0) return { ...trimmed, done: true };
      for (const name of names) {
        if (!trim(name, Number.MAX_SAFE_INTEGER)) {
          return { ...trimmed, done: false };
        }
        this.db.exec(`DROP TABLE "${name}"`);
      }
    }
    return { ...trimmed, done: false };
  };

  // Drop all archived history: the segments of indexed archives (each
  // within an open's envelope, at most maxArchiveSegments), then a bounded
  // amount of archived history without an index (trimArchivedHistory); done
  // is false if some of that is left for later calls.  The epochs' msg ids
  // are kept: they are still evidence of what was accepted.
  private dropArchivedHistory = (
    limits: HistoryLimits,
  ): { records: number; bytes: number; done: boolean } => {
    const { records, bytes } = this.db
      .prepare(
        "SELECT SUM(kept_records) AS records, SUM(kept_bytes) AS bytes FROM history_epochs WHERE archive IS NOT NULL",
      )
      .get() as { records: number | null; bytes: number | null };
    for (const s of this.db
      .prepare(
        "SELECT s.first_seq AS first_seq, s.last_seq AS last_seq, e.archive AS archive FROM history_segments AS s JOIN history_epochs AS e ON e.id = s.epoch_id",
      )
      .all() as { first_seq: number; last_seq: number; archive: string }[]) {
      const table = archiveTableName(s.archive);
      if (table == null) continue;
      this.db
        .prepare(`DELETE FROM "${table}" WHERE seq BETWEEN ? AND ?`)
        .run(s.first_seq, s.last_seq);
    }
    this.db.prepare("DELETE FROM history_segments").run();
    this.db
      .prepare(
        "UPDATE history_epochs SET archive=NULL, dropped_records=dropped_records+kept_records, dropped_bytes=dropped_bytes+kept_bytes, kept_records=0, kept_bytes=0 WHERE archive IS NOT NULL",
      )
      .run();
    const trimmed = this.trimArchivedHistory(limits);
    return {
      records: Number(records ?? 0) + trimmed.records,
      bytes: Number(bytes ?? 0) + trimmed.bytes,
      done: trimmed.done,
    };
  };

  // Keep the msg ids of only the newest maxArchivedIdEpochs archived epochs.
  private expireArchivedIds = (limits: HistoryLimits): void => {
    const old = this.db
      .prepare(
        "SELECT id, first_seq, last_seq FROM history_epochs WHERE last_seq IS NOT NULL ORDER BY id DESC LIMIT -1 OFFSET ?",
      )
      .all(limits.maxArchivedIdEpochs) as {
      id: number;
      first_seq: number;
      last_seq: number;
    }[];
    for (const { id, first_seq, last_seq } of old) {
      this.db
        .prepare("DELETE FROM message_ids WHERE seq BETWEEN ? AND ?")
        .run(first_seq, last_seq);
      this.db
        .prepare("UPDATE history_epochs SET ids_complete=0 WHERE id=?")
        .run(id);
    }
  };

  // at most MAX_HISTORY_EPOCH_ROWS closed epochs without an archive
  private pruneEpochRows = (): void => {
    const old = this.db
      .prepare(
        "SELECT id, first_seq, last_seq FROM history_epochs WHERE last_seq IS NOT NULL AND archive IS NULL ORDER BY id DESC LIMIT -1 OFFSET ?",
      )
      .all(MAX_HISTORY_EPOCH_ROWS) as {
      id: number;
      first_seq: number;
      last_seq: number;
    }[];
    for (const { id, first_seq, last_seq } of old) {
      this.db
        .prepare("DELETE FROM message_ids WHERE seq BETWEEN ? AND ?")
        .run(first_seq, last_seq);
      this.db.prepare("DELETE FROM history_segments WHERE epoch_id=?").run(id);
      this.db.prepare("DELETE FROM history_epochs WHERE id=?").run(id);
    }
  };

  // Which of these msg ids did the server accept, and are they in the current
  // history (see InclusionStatus)?  epoch: the history epoch the ids were
  // written in.  After a reset, an open copy of the document asks this about
  // its pending patches, so it re-applies only those proven absent.
  historyInclusion = ({
    epoch,
    ids,
  }: {
    epoch: number;
    ids: string[];
  }): HistoryInclusion => {
    const limits = historyLimits();
    if (
      typeof epoch !== "number" ||
      !Array.isArray(ids) ||
      ids.length > limits.maxInclusionIds ||
      ids.some((id) => typeof id !== "string" || id.length > 256)
    ) {
      throw new ConatError(
        `historyInclusion: at most ${limits.maxInclusionIds} string ids`,
        { code: 400 },
      );
    }
    const rows = this.db
      .prepare(
        "SELECT epoch, first_seq, last_seq, covered_seq, seed_seq, ids_complete FROM history_epochs ORDER BY id",
      )
      .all() as {
      epoch: number;
      first_seq: number;
      last_seq: number | null;
      covered_seq: number | null;
      seed_seq: number | null;
      ids_complete: number;
    }[];
    // Absence is only proven for a closed epoch: the fence refuses its
    // writes, so nothing more can be accepted in it.
    const asked = rows.filter((row) => row.epoch === epoch);
    const absent =
      asked.length > 0 &&
      asked.every((row) => row.last_seq != null && row.ids_complete === 1);
    // What a msg id accepted at a seq in each range means, as at most two
    // ranges per epoch.  An id can be accepted more than once (a retry after
    // its dedup expired), so it is looked up per range, best evidence first,
    // and each lookup reads at most one index entry: it never collects the
    // id's occurrences.
    const ranges: { lo: number; hi: number; status: InclusionStatus }[] = [];
    rows.forEach((row, i) => {
      if (row.last_seq == null) {
        ranges.push({
          lo: row.first_seq,
          hi: Number.MAX_SAFE_INTEGER,
          status: "live",
        });
        return;
      }
      // each later reset's seed must carry this epoch's seed forward
      const carried = rows
        .slice(i + 1)
        .every(
          (later) =>
            later.last_seq == null ||
            (later.seed_seq != null &&
              later.covered_seq != null &&
              later.covered_seq >= later.seed_seq),
        );
      const covered =
        row.covered_seq != null && carried
          ? Math.min(row.covered_seq, row.last_seq)
          : row.first_seq - 1;
      if (covered >= row.first_seq) {
        ranges.push({ lo: row.first_seq, hi: covered, status: "included" });
      }
      if (row.last_seq > covered) {
        ranges.push({
          lo: Math.max(row.first_seq, covered + 1),
          hi: row.last_seq,
          status: "excluded",
        });
      }
    });
    const rank: InclusionStatus[] = ["included", "live", "excluded"];
    ranges.sort((a, b) => rank.indexOf(a.status) - rank.indexOf(b.status));
    // (msg_id, seq) is the index's key, so this is one seek
    const inRange = this.db.prepare(
      "SELECT seq FROM message_ids WHERE msg_id=? AND seq BETWEEN ? AND ? ORDER BY seq LIMIT 1",
    );
    const anywhere = this.db.prepare(
      "SELECT seq FROM message_ids WHERE msg_id=? LIMIT 1",
    );
    const result: HistoryInclusion["ids"] = {};
    for (const id of ids) {
      if (result[id] != null) continue;
      for (const { lo, hi, status } of ranges) {
        const row = inRange.get(id, lo, hi) as { seq: number } | undefined;
        if (row != null) {
          result[id] = { status, seq: Number(row.seq) };
          break;
        }
      }
      if (result[id] != null) continue;
      if (anywhere.get(id) != null) {
        // accepted at a seq no epoch row describes any more
        result[id] = { status: "unknown" };
      } else {
        result[id] = { status: absent ? "absent" : "unknown" };
      }
    }
    return { history_epoch: this.currentEpoch(), ids: result };
  };

  // The archived epochs and their loadable segments, oldest first.
  historyArchives = (): ArchivedHistoryEpoch[] => {
    // at most maxArchiveSegments are kept (enforceArchiveQuota); the limit
    // also bounds this response if a database holds more
    const segments = new Map<number, ArchivedHistorySegment[]>();
    for (const s of this.db
      .prepare(
        "SELECT epoch_id, first_seq, last_seq, cut_seq, snapshot_seq, cut_bytes, suffix_bytes, records FROM history_segments ORDER BY epoch_id, first_seq LIMIT ?",
      )
      .iterate(historyLimits().maxArchiveSegments) as Iterable<any>) {
      const list = segments.get(s.epoch_id) ?? [];
      list.push({
        first_seq: s.first_seq,
        last_seq: s.last_seq,
        ...(s.cut_seq != null ? { cut_seq: s.cut_seq } : {}),
        ...(s.snapshot_seq != null ? { snapshot_seq: s.snapshot_seq } : {}),
        cut_bytes: s.cut_bytes,
        suffix_bytes: s.suffix_bytes,
        records: s.records,
      });
      segments.set(s.epoch_id, list);
    }
    return (
      this.db
        .prepare(
          "SELECT * FROM history_epochs WHERE last_seq IS NOT NULL ORDER BY id",
        )
        .all() as any[]
    ).map((row) => ({
      epoch: row.epoch,
      first_seq: row.first_seq,
      last_seq: row.last_seq,
      ...(row.covered_seq != null ? { covered_seq: row.covered_seq } : {}),
      ...(row.archive != null ? { archive: row.archive } : {}),
      kept: { records: row.kept_records, bytes: row.kept_bytes },
      dropped: { records: row.dropped_records, bytes: row.dropped_bytes },
      ...(row.info_json != null ? { info: JSON.parse(row.info_json) } : {}),
      time: row.time,
      segments: segments.get(row.id) ?? [],
    }));
  };

  // "Delete archived history to save space": irreversible.  The current
  // history is not touched.  done is false if archived history from before
  // the archive bounds is still being removed, a bounded amount per call.
  purgeArchivedHistory = (): {
    records: number;
    bytes: number;
    done: boolean;
  } => {
    const dropped = this.runTransaction(() =>
      this.dropArchivedHistory(historyLimits()),
    );
    this.throttledBackup();
    return dropped;
  };

  private archivedMessageTables = (): string[] => {
    return (
      (
        this.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as { name: string }[]
      )
        .map(({ name }) => name)
        // the name is pasted into SQL (ALTER/DROP TABLE), so only exactly the
        // names this server creates
        .filter((name) => ARCHIVED_MESSAGES_TABLE.test(name))
    );
  };

  private unusedArchiveTableName = (): string => {
    const existing = new Set(this.archivedMessageTables());
    const base = `${ARCHIVED_MESSAGES_PREFIX}${Date.now()}`;
    let name = base;
    for (let i = 1; existing.has(name); i++) {
      name = `${base}_${i}`;
    }
    return name;
  };

  get length(): number {
    const { length } = this.db
      .prepare("SELECT COUNT(*) AS length FROM messages")
      .get() as { length: number };
    return length;
  }

  totalSize = (): number => {
    return (
      (this.db.prepare(`SELECT SUM(size) AS sum FROM messages`).get() as any)
        .sum ?? 0
    );
  };

  seq = (): number => {
    return (
      (this.db.prepare(`SELECT MAX(seq) AS seq FROM messages`).get() as any)
        .seq ?? 0
    );
  };

  inventory = (): PartialInventory => {
    return {
      bytes: this.totalSize(),
      count: this.length,
      limits: this.getConfig(),
      seq: this.seq(),
    };
  };

  keys = (): string[] => {
    const v = this.db
      .prepare("SELECT key FROM messages WHERE key IS NOT NULL")
      .all() as {
      key: string;
    }[];
    return v.map(({ key }) => key);
  };

  sqlite = (statement: string, params: any[] = []): any[] => {
    // Matches "attach database" (case-insensitive, ignores whitespace)
    if (/\battach\s+database\b/i.test(statement)) {
      throw Error("ATTACH DATABASE not allowed");
    }
    const stmt = this.db.prepare(statement);
    try {
      return stmt.all(...params);
    } catch (err) {
      if (err.message.includes("run() instead")) {
        stmt.run(...params);
        return [];
      } else {
        throw err;
      }
    }
  };

  // only returns fields that are not set to their default value,
  // and doesn't enforce any limits
  getConfig = (): Partial<Configuration> => {
    const cur: any = {};
    for (const { field, value } of this.db
      .prepare("SELECT * FROM config")
      .all() as any) {
      const { def, fromDb } = CONFIGURATION[field];
      cur[field] = fromDb(value);
      if (cur[field] == def) {
        delete cur[field];
      }
    }
    return cur;
  };

  config = (config?: Partial<Configuration>): Configuration => {
    const cur: any = {};
    for (const { field, value } of this.db
      .prepare("SELECT * FROM config")
      .all() as any) {
      cur[field] = value;
    }
    const full: Partial<Configuration> = {};
    for (const key in CONFIGURATION) {
      const { def, fromDb, toDb } = CONFIGURATION[key];
      full[key] =
        config?.[key] ?? (cur[key] !== undefined ? fromDb(cur[key]) : def);
      let x = toDb(full[key]);
      if (config?.[key] != null && full[key] != (cur[key] ?? def)) {
        // making a change
        this.db
          .prepare(
            `INSERT INTO config (field, value) VALUES(?, ?) ON CONFLICT(field) DO UPDATE SET value=excluded.value`,
          )
          .run(key, x);
      }
      full[key] = fromDb(x);
      if (
        this.options.ephemeral &&
        key == "max_bytes" &&
        (full[key] == null || full[key] <= 0 || full[key] > EPHEMERAL_MAX_BYTES)
      ) {
        // for ephemeral we always make it so max_bytes is capped
        // (note -- this isn't explicitly set in the sqlite database, since we might
        // change it, and by not setting it in the database we can)
        full[key] = EPHEMERAL_MAX_BYTES;
      }
    }
    this.conf = full as Configuration;
    // ensure any new limits are enforced
    this.enforceLimits(0);
    if (config != null) {
      this.markMaintenanceMutation();
    }
    this.throttledBackup();
    return full as Configuration;
  };

  getMetadata = (): JSONValue | undefined => {
    const row = this.db
      .prepare(
        "SELECT metadata_json FROM stream_metadata WHERE id = 1 AND metadata_json IS NOT NULL",
      )
      .get() as { metadata_json?: string } | undefined;
    if (row?.metadata_json == null) {
      return undefined;
    }
    return JSON.parse(row.metadata_json);
  };

  setMetadata = (metadata?: JSONValue): JSONValue | undefined => {
    this.runTransaction(() => {
      if (metadata === undefined) {
        this.db.prepare("DELETE FROM stream_metadata WHERE id = 1").run();
      } else {
        this.db
          .prepare(
            `
            INSERT INTO stream_metadata(id, metadata_json, revision)
            VALUES (1, ?, 1)
            ON CONFLICT(id) DO UPDATE SET
              metadata_json=excluded.metadata_json,
              revision=stream_metadata.revision + 1
          `,
          )
          .run(JSON.stringify(metadata));
      }
    });
    this.emit("change", { op: "metadata", metadata });
    this.throttledBackup();
    return metadata;
  };

  patchMetadata = (delta: JSONValue): JSONValue | undefined => {
    const current = this.getMetadata();
    let next: JSONValue;
    if (isPlainRecord(current) && isPlainRecord(delta)) {
      next = { ...current, ...delta };
    } else {
      next = delta;
    }
    return this.setMetadata(next);
  };

  getCheckpoints = (): StreamCheckpoints => {
    const checkpoints: StreamCheckpoints = {};
    for (const row of this.db
      .prepare(
        "SELECT name, seq, time, data_json FROM stream_checkpoints ORDER BY name",
      )
      .iterate() as Iterable<{
      name: string;
      seq: number;
      time: number;
      data_json?: string | null;
    }>) {
      checkpoints[row.name] = {
        seq: row.seq,
        time: row.time,
        data:
          row.data_json == null || row.data_json === ""
            ? undefined
            : JSON.parse(row.data_json),
      };
    }
    return checkpoints;
  };

  getCheckpoint = (name: string): StreamCheckpoint | undefined => {
    const row = this.db
      .prepare(
        "SELECT seq, time, data_json FROM stream_checkpoints WHERE name = ?",
      )
      .get(name) as
      | { seq: number; time: number; data_json?: string | null }
      | undefined;
    if (row == null) {
      return undefined;
    }
    return {
      seq: row.seq,
      time: row.time,
      data:
        row.data_json == null || row.data_json === ""
          ? undefined
          : JSON.parse(row.data_json),
    };
  };

  setCheckpoint = ({
    name,
    seq,
    time,
    data,
  }: CheckpointUpdate): StreamCheckpoint => {
    if (seq == null) {
      throw Error("setCheckpoint requires seq");
    }
    if (time == null) {
      time = Date.now();
    }
    this.runTransaction(() => {
      this.writeCheckpoint({ name, seq, time, data });
    });
    this.emit("change", {
      op: "checkpoints",
      checkpoints: this.getCheckpoints(),
    });
    this.throttledBackup();
    return { seq, time, data };
  };

  deleteCheckpoint = (name: string): void => {
    this.db.prepare("DELETE FROM stream_checkpoints WHERE name = ?").run(name);
    this.markMaintenanceMutation();
    this.emit("change", {
      op: "checkpoints",
      checkpoints: this.getCheckpoints(),
    });
    this.throttledBackup();
  };

  private writeCheckpoint = ({
    name,
    seq,
    time,
    data,
    snapshotSeq,
  }: {
    name: string;
    seq: number;
    time: number;
    data?: JSONValue;
    // the message written with this checkpoint, e.g., the snapshot of the
    // patch at seq
    snapshotSeq?: number;
  }): void => {
    this.db
      .prepare(
        `
        INSERT INTO stream_checkpoints(name, seq, time, data_json, revision)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(name) DO UPDATE SET
          seq=excluded.seq,
          time=excluded.time,
          data_json=excluded.data_json,
          revision=stream_checkpoints.revision + 1
      `,
      )
      .run(name, seq, time, data === undefined ? null : JSON.stringify(data));
    // A snapshot checkpoint is a place a load can start from, so the archive
    // segments of a reset start at them.  Only the newest checkpoint per name
    // is kept above; this keeps all of them.  Other checkpoints (e.g., the
    // saved_file proof) describe no snapshot, so they are never cuts.
    if (name !== SNAPSHOT_CHECKPOINT) return;
    this.db
      .prepare(
        `INSERT INTO history_cuts(seq, snapshot_seq) VALUES (?, ?)
         ON CONFLICT(seq) DO UPDATE SET
           snapshot_seq=COALESCE(excluded.snapshot_seq, history_cuts.snapshot_seq)`,
      )
      .run(seq, snapshotSeq != null && snapshotSeq >= seq ? snapshotSeq : null);
  };

  private deleteCheckpointsInSeqs = (seqs: number[]): void => {
    if (seqs.length == 0) {
      return;
    }
    const placeholders = seqs.map(() => "?").join(", ");
    this.db
      .prepare(`DELETE FROM stream_checkpoints WHERE seq IN (${placeholders})`)
      .run(...seqs);
    this.forgetSeqs(seqs);
  };

  // Deleted messages: forget their ids and the cuts they were part of.  An id
  // that is forgotten is no longer evidence that its message was accepted, so
  // the current history's ids are incomplete from then on, and
  // historyInclusion answers "unknown" rather than "absent".
  private forgetSeqs = (seqs: number[]): void => {
    let forgotten = 0;
    for (let i = 0; i < seqs.length; i += 500) {
      const chunk = seqs.slice(i, i + 500);
      const placeholders = chunk.map(() => "?").join(", ");
      forgotten += Number(
        this.db
          .prepare(`DELETE FROM message_ids WHERE seq IN (${placeholders})`)
          .run(...chunk).changes,
      );
      this.db
        .prepare(
          `DELETE FROM history_cuts WHERE seq IN (${placeholders}) OR snapshot_seq IN (${placeholders})`,
        )
        .run(...chunk, ...chunk);
    }
    if (forgotten > 0) {
      this.db
        .prepare(
          "UPDATE history_epochs SET ids_complete=0 WHERE last_seq IS NULL AND ids_complete=1",
        )
        .run();
    }
  };

  private emitDelete = (rows, deferredChanges?: ChangefeedOperation[]) => {
    if (rows.length > 0) {
      const seqs = rows.map((row: { seq: number }) => row.seq);
      this.deleteCheckpointsInSeqs(seqs);
      if (deferredChanges != null) {
        deferredChanges.push({ op: "delete", seqs });
      } else {
        this.emit("change", { op: "delete", seqs });
        this.throttledBackup();
      }
    }
  };

  // do whatever limit enforcement and throttling is needed when inserting one new message
  // with the given size; if size=0 assume not actually inserting a new message, and just
  // enforcingt current limits
  private enforceLimits = (
    size: number = 0,
    deferredChanges?: ChangefeedOperation[],
  ) => {
    if (
      size > 0 &&
      (this.conf.max_msgs_per_second > 0 || this.conf.max_bytes_per_second > 0)
    ) {
      const { msgs, bytes } = this.db
        .prepare(
          "SELECT COUNT(*) AS msgs, SUM(size) AS bytes FROM messages WHERE time >= ?",
        )
        .get(Date.now() / 1000 - 1) as { msgs: number; bytes: number };
      if (
        this.conf.max_msgs_per_second > 0 &&
        msgs > this.conf.max_msgs_per_second
      ) {
        throw new ConatError("max_msgs_per_second exceeded", {
          code: "reject",
        });
      }
      if (
        this.conf.max_bytes_per_second > 0 &&
        bytes > this.conf.max_bytes_per_second
      ) {
        throw new ConatError("max_bytes_per_second exceeded", {
          code: "reject",
        });
      }
    }

    if (this.conf.max_msgs > -1) {
      const length = this.length + (size > 0 ? 1 : 0);
      if (length > this.conf.max_msgs) {
        if (this.conf.discard_policy == "new") {
          if (size > 0) {
            throw new ConatError("max_msgs limit reached", { code: "reject" });
          }
        } else {
          // delete earliest messages to make room
          const rows = this.db
            .prepare(
              `DELETE FROM messages WHERE seq IN (SELECT seq FROM messages ORDER BY seq ASC LIMIT ?) RETURNING seq`,
            )
            .all(length - this.conf.max_msgs);
          this.emitDelete(rows, deferredChanges);
        }
      }
    }

    if (this.conf.max_age > 0) {
      const rows = this.db
        .prepare(
          `DELETE FROM messages WHERE seq IN (SELECT seq FROM messages WHERE time <= ?) RETURNING seq`,
        )
        .all((Date.now() - this.conf.max_age) / 1000);
      this.emitDelete(rows, deferredChanges);
    }

    if (this.conf.max_bytes > -1) {
      if (size > this.conf.max_bytes) {
        if (this.conf.discard_policy == "new") {
          if (size > 0) {
            throw new ConatError("max_bytes limit reached", { code: "reject" });
          }
        } else {
          // new message exceeds total, so this is the same as adding in the new message,
          // then deleting everything.
          const rows = this.db
            .prepare("DELETE FROM messages RETURNING seq")
            .all() as { seq: number }[];
          this.db.prepare("DELETE FROM stream_checkpoints").run();
          this.emitDelete(rows, deferredChanges);
        }
      } else {
        // delete all the earliest (in terms of seq number) messages
        // so that the sum of the remaining
        // sizes along with the new size is <= max_bytes.
        // Only enforce if actually inserting, or if current sum is over
        const totalSize = this.totalSize();
        const newTotal = totalSize + size;
        if (newTotal > this.conf.max_bytes) {
          const bytesToFree = newTotal - this.conf.max_bytes;
          let freed = 0;
          let lastSeqToDelete: number | null = null;

          for (const { seq, size: msgSize } of this.db
            .prepare(`SELECT seq, size FROM messages ORDER BY seq ASC`)
            .iterate() as any) {
            if (freed >= bytesToFree) break;
            freed += msgSize;
            lastSeqToDelete = seq;
          }

          if (lastSeqToDelete !== null) {
            if (this.conf.discard_policy == "new") {
              if (size > 0) {
                throw new ConatError("max_bytes limit reached", {
                  code: "reject",
                });
              }
            } else {
              const rows = this.db
                .prepare(`DELETE FROM messages WHERE seq <= ? RETURNING seq`)
                .all(lastSeqToDelete);
              this.emitDelete(rows, deferredChanges);
            }
          }
        }
      }
    }

    if (this.conf.allow_msg_ttl) {
      const rows = this.db
        .prepare(
          `DELETE FROM messages WHERE ttl IS NOT null AND time + ttl/1000 < ? RETURNING seq`,
        )
        .all(Date.now() / 1000);
      this.emitDelete(rows, deferredChanges);
    }

    if (this.conf.max_msg_size > -1 && size > this.conf.max_msg_size) {
      throw new ConatError(
        `max_msg_size of ${this.conf.max_msg_size} bytes exceeded`,
        { code: "reject" },
      );
    }
  };
}

function dbToMessage(
  x:
    | {
        seq: number;
        key?: string;
        time: number;
        compress: CompressionAlgorithm;
        encoding: DataEncoding;
        raw: Buffer;
        headers?: string;
        ttl?: number;
      }
    | undefined,
  // effective size of the stored message (see EFFECTIVE_SIZE_SQL)
  size: number,
): StoredMessage | undefined {
  if (x === undefined) {
    return x;
  }
  if (x.ttl && Date.now() - 1000 * x.time >= x.ttl) {
    // the actual record will get cleared eventually from the
    // database when enforceLimits is called.  For now we
    // just returned undefined.  The check here makes it so
    // ttl fully works as claimed, rather than "eventually", i.e.,
    // it can be used for a short-term lock, rather than just
    // being something for saving space longterm.
    return undefined;
  }
  return {
    seq: x.seq,
    time: x.time * 1000,
    key: x.key != null ? x.key : undefined,
    encoding: x.encoding,
    raw: handleDecompress(x, size),
    headers: parseStoredHeaders(x.headers),
  };
}

function handleDecompress(
  {
    raw,
    compress,
  }: {
    raw: Buffer;
    compress: CompressionAlgorithm;
  },
  size: number,
) {
  if (compress == CompressionAlgorithm.None) {
    return raw;
  } else if (compress == CompressionAlgorithm.Zstd) {
    return decompress(raw, decompressLimit(size));
  } else {
    throw Error(`unknown compression ${compress}`);
  }
}

interface CreateOptions extends StorageOptions {
  noCache?: boolean;
}

export const openPaths = new Set<string>();

export const cache = refCacheSync<CreateOptions, PersistentStream>({
  name: "persistent-storage-stream",
  createKey: ({ path }: CreateOptions) => path,
  createObject: (options: CreateOptions) => {
    return new PersistentStream(options);
  },
});

export function getPersistentStreamDiagnostics() {
  const cacheInfo = cache.info();
  const referenceCounts = Object.values(cacheInfo.count);
  return {
    ...streamLifecycle,
    open_total: streamLifecycle.open_ephemeral + streamLifecycle.open_disk,
    open_paths: openPaths.size,
    cached_streams: referenceCounts.length,
    cached_references: referenceCounts.reduce((sum, count) => sum + count, 0),
    max_cached_references: Math.max(0, ...referenceCounts),
    sqlite_cache: {
      ephemeral: summarizeCacheSizes("ephemeral"),
      disk: summarizeCacheSizes("disk"),
      ephemeral_default_kib: DEFAULT_EPHEMERAL_SQLITE_CACHE_KIB,
      ephemeral_effective_kib: effectiveEphemeralSqliteCacheKiB(),
      ephemeral_override_kib: resolveEphemeralSqliteCacheKiB(),
    },
    open_stream_inventory: summarizeOpenStreams(Date.now()),
  };
}

export interface SqliteFootprintSummary {
  databases: number;
  page_bytes: number;
  live_page_bytes: number;
  freelist_bytes: number;
  file_bytes: number;
  wal_bytes: number;
  shm_bytes: number;
  message_bytes: number;
  messages: number;
  errors: number;
}

function emptySqliteFootprintSummary(): SqliteFootprintSummary {
  return {
    databases: 0,
    page_bytes: 0,
    live_page_bytes: 0,
    freelist_bytes: 0,
    file_bytes: 0,
    wal_bytes: 0,
    shm_bytes: 0,
    message_bytes: 0,
    messages: 0,
    errors: 0,
  };
}

export function getPersistentStreamSqliteDiagnostics() {
  const started = Date.now();
  const result = {
    ephemeral: emptySqliteFootprintSummary(),
    disk: emptySqliteFootprintSummary(),
    duration_ms: 0,
  };
  for (const [stream, { kind }] of openStreams) {
    try {
      const footprint = stream.diagnosticSqliteFootprint();
      const summary = result[footprint.kind];
      summary.databases += 1;
      summary.page_bytes += footprint.page_bytes;
      summary.live_page_bytes += footprint.live_page_bytes;
      summary.freelist_bytes += footprint.freelist_bytes;
      summary.file_bytes += footprint.file_bytes;
      summary.wal_bytes += footprint.wal_bytes;
      summary.shm_bytes += footprint.shm_bytes;
      summary.message_bytes += footprint.message_bytes;
      summary.messages += footprint.messages;
    } catch {
      result[kind].errors += 1;
    }
  }
  result.duration_ms = Date.now() - started;
  return result;
}

// The local paths (without .db) of the disk-backed streams open in this
// process.
export function openDiskStreamPaths(): string[] {
  const paths: string[] = [];
  for (const [stream, { kind }] of openStreams) {
    const path = stream.localPath();
    if (kind === "disk" && path != null) {
      paths.push(path);
    }
  }
  return paths;
}

export function pstream(
  options: StorageOptions & { noCache?: boolean },
): PersistentStream {
  return cache(options);
}

function age(path: string) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function fileSize(path: string): number {
  try {
    const size = Number(statSync(path).size ?? 0);
    return Number.isFinite(size) && size > 0 ? size : 0;
  } catch {
    return 0;
  }
}

function isPlainRecord(
  value: JSONValue | undefined,
): value is { [key: string]: JSONValue } {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
