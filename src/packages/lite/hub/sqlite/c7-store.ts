/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The durable side of C7, the typed turn/event protocol (Sagebrush slice S6a,
// scope packet r10 §2.2, §2.5 and §2.6). Everything an agent turn feeds into C7
// is admitted here, in one SQLite transaction per input, together with its
// queue row, its projection and the thread's next seq. The end of a turn is
// decided here too: one winner per turn, shared by the chat and by C7.
//
// The projector itself (what C7 events an input produces) is pluggable: this
// module only stores what it returns.

import { randomBytes } from "node:crypto";
import type { AcpChatContext } from "@cocalc/conat/ai/acp/types";
import { getAcpDatabase } from "./acp-database";
import type { SqliteDatabase } from "./acp-database";
import { ensureAcpTurnsSchema } from "./acp-turns";
import { canonicalJson, sha256Bytes, sha256Hex } from "./c7-envelope";

export const C7_VERSION = "1.0";

// ---------------------------------------------------------------------------
// Types

export interface C7TurnKey {
  project_id: string;
  path: string;
  message_date: string;
}

// What C7 needs to know about a turn besides its key.
export interface C7TurnContext extends C7TurnKey {
  thread_id: string;
  // The assistant reply's chat message id: the C7 turn_id.
  turn_id: string;
}

export type C7Origin = "source" | "local";

// An immutable hub-ingress envelope (§2.2). `n` and `time` are assigned
// inside admission; `body` is the payload exactly as received, taken once as
// canonical JSON. Every consumer (the hash, the queue row, the projector and
// the hub) gets its own parse of that one text.
export interface C7Envelope {
  kind: "in";
  project_id: string;
  path: string;
  message_date: string;
  attempt_id: string;
  attempt_gen: number;
  n: number;
  origin: C7Origin;
  time: number;
  body: unknown;
}

export type C7Outcome = "completed" | "interrupted" | "error";

export interface C7CloseCandidate {
  outcome: C7Outcome;
  // The authoritative final text, for a completed close only.
  F?: string;
  code?: string;
  // For an integrity refusal: the input that was refused.
  cause?: { attempt_id: string; kind: "in" | "close"; n: number };
}

export interface C7Winner extends C7CloseCandidate {
  attempt_id: string;
  attempt_gen: number;
  h_close: string;
}

// A stored close candidate. Closes are keyed (K, attempt, "close", k): `k`
// numbers an attempt's close candidates in their own namespace, never shared
// with input ordinals (§2.2: "a close is never an ordinal").
export interface C7CloseEnvelope {
  kind: "close";
  project_id: string;
  path: string;
  message_date: string;
  attempt_id: string;
  attempt_gen: number;
  k: number;
  candidate: C7CloseCandidate;
}

// A C7 event as the projector returns it: the store adds thread_id, seq,
// turn_id and v.
export interface C7EventDraft {
  type: string;
  [field: string]: unknown;
}

export type C7ObjectClass = "diff" | "tool_body" | "page" | "reset";

export interface C7ObjectDraft {
  object_id: string;
  class: C7ObjectClass;
  body: Uint8Array;
  // The turns (message_date of each) this object depends on (§2.6).
  deps: string[];
}

export interface C7Projection {
  state: unknown;
  events: C7EventDraft[];
  objects: C7ObjectDraft[];
}

export interface C7ProjectionContext {
  turn: C7TurnContext;
  attempt_gen: number;
  // True at the first admitted input of a new current attempt (§2.2).
  cutover: boolean;
  newObjectId: () => string;
}

export type C7RefusalCode =
  | "source_conflict"
  | "source_gap"
  | "source_malformed";

export interface C7Projector {
  // Is this input well-formed against the turn's state (§2.4)?
  validate(state: unknown, envelope: C7Envelope): "ok" | "malformed";
  // A live, admitted input.
  input(
    state: unknown,
    envelope: C7Envelope,
    ctx: C7ProjectionContext,
  ): C7Projection;
  // The turn's winner, the first time it is recorded (§2.5).
  close(
    state: unknown,
    winner: C7Winner,
    ctx: C7ProjectionContext,
  ): C7Projection;
  // An integrity refusal after the winner (§2.2): one turn_invalidated.
  invalidate(
    state: unknown,
    code: C7RefusalCode,
    ctx: C7ProjectionContext,
  ): C7Projection;
}

// The class an input was given at admission. Only `live` inputs are ever
// processed by the hub, at admission or on replay.
export type C7InputClass = "live" | "stale" | "late" | "malformed";

export type C7AdmitResult =
  | { result: "admitted"; envelope: C7Envelope }
  | {
      result: "refused";
      reason: "stale" | "late" | "malformed" | "no_attempt";
    }
  | { result: "storage_failed"; error: unknown };

export type C7ReplayResult =
  // A stored row that matches its record exactly: a live input (processable,
  // with its own parse of the stored text), or a close candidate (never
  // processed).
  | {
      result: "duplicate";
      kind: "in";
      class: "live";
      process: true;
      envelope: C7Envelope;
    }
  | { result: "duplicate"; kind: "close"; class: string; process: false }
  // An exact stored input that admission refused: it stays refused, and is
  // never processed. Not an integrity problem, so nothing else happens.
  | {
      result: "refused";
      reason: "stale" | "late" | "malformed";
      integrity: false;
    }
  // A stored row that doesn't match its record: an integrity refusal.
  | { result: "refused"; reason: "collision" | "gap"; integrity: true }
  | { result: "storage_failed"; error: unknown };

export type C7DecideResult =
  | { role: "winner"; winner: C7Winner }
  | { role: "loser"; winner: C7Winner }
  | { role: "stale"; winner: null };

// ---------------------------------------------------------------------------
// Fault injection (tests only): called at named points inside transactions.

let faultHook: ((point: string) => void) | undefined;

export function __setC7FaultHook(hook?: (point: string) => void): void {
  faultHook = hook;
}

function fault(point: string): void {
  faultHook?.(point);
}

// ---------------------------------------------------------------------------
// The process-level pending flags (§2.2): turns whose admission failed and
// whose durable c7_incomplete write hasn't committed yet. An entry outlives
// the writer that recorded it; it is removed only after a transaction that
// wrote the flag to the turn's lease row has committed.

const pendingIncomplete = new Set<string>();

function turnKeyString(key: C7TurnKey): string {
  return JSON.stringify([key.project_id, key.path, key.message_date]);
}

export function markPendingIncomplete(key: C7TurnKey): void {
  pendingIncomplete.add(turnKeyString(key));
}

export function hasPendingIncomplete(key: C7TurnKey): boolean {
  return pendingIncomplete.has(turnKeyString(key));
}

// Writes K's pending flag durably, if there is one. Returns true when nothing
// is pending any more. A failure, or a missing lease row, keeps the entry.
export function flushPendingIncomplete(key: C7TurnKey): boolean {
  if (!hasPendingIncomplete(key)) return true;
  const db = database();
  let written = false;
  try {
    transaction(db, () => {
      written = writeIncompleteInTx(db, key);
      fault("flush:before-commit");
    });
  } catch {
    return false;
  }
  if (!written) return false;
  pendingIncomplete.delete(turnKeyString(key));
  return true;
}

export function __clearPendingIncompleteForTests(): void {
  pendingIncomplete.clear();
}

// ---------------------------------------------------------------------------
// Schema

let initialized = false;

function database(): SqliteDatabase {
  const db = getAcpDatabase();
  if (!initialized) {
    initSchema(db);
    initialized = true;
  }
  return db;
}

export function __resetC7InitForTests(): void {
  initialized = false;
}

function initSchema(db: SqliteDatabase): void {
  ensureAcpTurnsSchema();
  const columns = db.prepare(`PRAGMA table_info(acp_turns)`).all() as Array<{
    name: string;
  }>;
  const has = (name: string) => columns.some((x) => x?.name === name);
  if (!has("attempt_id")) {
    db.exec(`ALTER TABLE acp_turns ADD COLUMN attempt_id TEXT`);
  }
  if (!has("attempt_gen")) {
    db.exec(
      `ALTER TABLE acp_turns ADD COLUMN attempt_gen INTEGER NOT NULL DEFAULT 0`,
    );
  }
  if (!has("c7_incomplete")) {
    db.exec(
      `ALTER TABLE acp_turns ADD COLUMN c7_incomplete INTEGER NOT NULL DEFAULT 0`,
    );
  }
  // One record per admitted input (kind "in", by ordinal n) and per close
  // candidate (kind "close", by candidate index k), with the attempt_gen it
  // was admitted under, its commit position qseq, its hash and its class.
  db.exec(`
    CREATE TABLE IF NOT EXISTS c7_input (
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      message_date TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      n INTEGER NOT NULL,
      attempt_gen INTEGER NOT NULL,
      qseq INTEGER NOT NULL,
      origin TEXT,
      h TEXT NOT NULL,
      class TEXT NOT NULL,
      PRIMARY KEY (project_id, path, message_date, attempt_id, kind, n)
    )
  `);
  // The queue: insert-once rows, read back in commit order (qseq).
  db.exec(`
    CREATE TABLE IF NOT EXISTS c7_queue (
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      message_date TEXT NOT NULL,
      attempt_gen INTEGER NOT NULL,
      attempt_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      n INTEGER NOT NULL,
      qseq INTEGER NOT NULL,
      envelope TEXT NOT NULL,
      h TEXT NOT NULL,
      hub_seq INTEGER,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, path, message_date, attempt_gen, attempt_id, kind, n)
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS c7_queue_order_idx ON c7_queue(project_id, path, message_date, qseq)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS c7_queue_created_idx ON c7_queue(created_at)`,
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS c7_turn (
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      message_date TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      state TEXT,
      last_attempt_gen INTEGER NOT NULL DEFAULT 0,
      next_qseq INTEGER NOT NULL DEFAULT 1,
      invalidated_code TEXT,
      late_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, path, message_date)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS c7_close (
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      message_date TEXT NOT NULL,
      record TEXT NOT NULL,
      h_close TEXT NOT NULL,
      PRIMARY KEY (project_id, path, message_date)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS c7_thread (
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      next_seq INTEGER NOT NULL,
      PRIMARY KEY (project_id, path, thread_id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS c7_log (
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      message_date TEXT NOT NULL,
      event TEXT NOT NULL,
      PRIMARY KEY (project_id, path, thread_id, seq)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS c7_object (
      object_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      class TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      body BLOB NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS c7_object_class_created_idx ON c7_object(class, created_at)`,
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS c7_object_dep (
      object_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      message_date TEXT NOT NULL,
      PRIMARY KEY (object_id, project_id, path, message_date)
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS c7_object_dep_turn_idx ON c7_object_dep(project_id, path, message_date)`,
  );
}

// ---------------------------------------------------------------------------
// Transactions

// One write transaction. BEGIN IMMEDIATE takes the write lock up front, so
// the thread's seq allocation and every check-then-write below is serialized
// against other processes on the same database.
function transaction<T>(db: SqliteDatabase, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  let result: T;
  try {
    result = fn();
    fault("tx:before-commit");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // the transaction may already be gone
    }
    throw err;
  }
  try {
    // tests only: a failure at the COMMIT call itself, taking the same
    // handler as a COMMIT that SQLite refuses
    fault("tx:commit");
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw err;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Rows

interface LeaseRow {
  attempt_id: string | null;
  attempt_gen: number;
  c7_incomplete: number;
  state: string;
  owner_instance_id: string;
}

function readLease(db: SqliteDatabase, key: C7TurnKey): LeaseRow | undefined {
  return db
    .prepare(
      `SELECT attempt_id, attempt_gen, c7_incomplete, state, owner_instance_id
       FROM acp_turns
       WHERE project_id = ? AND path = ? AND message_date = ?`,
    )
    .get(key.project_id, key.path, key.message_date) as LeaseRow | undefined;
}

function readWinner(db: SqliteDatabase, key: C7TurnKey): C7Winner | undefined {
  const row = db
    .prepare(
      `SELECT record FROM c7_close
       WHERE project_id = ? AND path = ? AND message_date = ?`,
    )
    .get(key.project_id, key.path, key.message_date) as
    | { record: string }
    | undefined;
  return row ? (JSON.parse(row.record) as C7Winner) : undefined;
}

export function getC7Winner(key: C7TurnKey): C7Winner | undefined {
  return readWinner(database(), key);
}

interface TurnRow {
  state: string | null;
  last_attempt_gen: number;
  next_qseq: number;
  invalidated_code: string | null;
}

function readTurn(db: SqliteDatabase, key: C7TurnKey): TurnRow | undefined {
  return db
    .prepare(
      `SELECT state, last_attempt_gen, next_qseq, invalidated_code FROM c7_turn
       WHERE project_id = ? AND path = ? AND message_date = ?`,
    )
    .get(key.project_id, key.path, key.message_date) as TurnRow | undefined;
}

function ensureTurn(db: SqliteDatabase, turn: C7TurnContext): TurnRow {
  db.prepare(
    `INSERT INTO c7_turn (project_id, path, message_date, thread_id, turn_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id, path, message_date) DO NOTHING`,
  ).run(
    turn.project_id,
    turn.path,
    turn.message_date,
    turn.thread_id,
    turn.turn_id,
  );
  return readTurn(db, turn)!;
}

function parseState(row: TurnRow): unknown {
  return row.state == null ? undefined : JSON.parse(row.state);
}

function writeState(
  db: SqliteDatabase,
  key: C7TurnKey,
  state: unknown,
  last_attempt_gen?: number,
): void {
  const text = state === undefined ? null : JSON.stringify(state);
  if (last_attempt_gen == null) {
    db.prepare(
      `UPDATE c7_turn SET state = ?
       WHERE project_id = ? AND path = ? AND message_date = ?`,
    ).run(text, key.project_id, key.path, key.message_date);
  } else {
    db.prepare(
      `UPDATE c7_turn SET state = ?, last_attempt_gen = ?
       WHERE project_id = ? AND path = ? AND message_date = ?`,
    ).run(text, last_attempt_gen, key.project_id, key.path, key.message_date);
  }
}

function countLate(db: SqliteDatabase, key: C7TurnKey): void {
  db.prepare(
    `UPDATE c7_turn SET late_count = late_count + 1
     WHERE project_id = ? AND path = ? AND message_date = ?`,
  ).run(key.project_id, key.path, key.message_date);
}

function nextIndex(
  db: SqliteDatabase,
  key: C7TurnKey,
  attempt_id: string,
  kind: "in" | "close",
): number {
  const row = db
    .prepare(
      `SELECT MAX(n) AS n FROM c7_input
       WHERE project_id = ? AND path = ? AND message_date = ?
         AND attempt_id = ? AND kind = ?`,
    )
    .get(key.project_id, key.path, key.message_date, attempt_id, kind) as
    | { n: number | null }
    | undefined;
  return row?.n == null ? 0 : Number(row.n) + 1;
}

function recordInput(
  db: SqliteDatabase,
  key: C7TurnKey,
  attempt_id: string,
  kind: "in" | "close",
  n: number,
  attempt_gen: number,
  qseq: number,
  origin: C7Origin | null,
  h: string,
  klass: string,
): void {
  db.prepare(
    `INSERT INTO c7_input
       (project_id, path, message_date, attempt_id, kind, n, attempt_gen,
        qseq, origin, h, class)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    key.project_id,
    key.path,
    key.message_date,
    attempt_id,
    kind,
    n,
    attempt_gen,
    qseq,
    origin,
    h,
    klass,
  );
}

// The next commit position for the turn: allocated from the turn's row
// inside the admitting transaction, so qseq is the order admissions
// committed, inputs and closes merged. It is recorded in c7_input as well as
// the queue, and replay requires the two to agree.
function allocQseq(db: SqliteDatabase, turn: C7TurnContext): number {
  const row = ensureTurn(db, turn);
  const qseq = Number(row.next_qseq);
  db.prepare(
    `UPDATE c7_turn SET next_qseq = ?
     WHERE project_id = ? AND path = ? AND message_date = ?`,
  ).run(qseq + 1, turn.project_id, turn.path, turn.message_date);
  return qseq;
}

// Insert-once (§2.2, step 2), at the commit position allocQseq gave.
function writeQueueRow(
  db: SqliteDatabase,
  turn: C7TurnContext,
  attempt_gen: number,
  attempt_id: string,
  kind: "in" | "close",
  n: number,
  qseq: number,
  envelope: string,
  h: string,
  hub_seq: number | null,
  now: number,
): void {
  const changes = db
    .prepare(
      `INSERT INTO c7_queue
         (project_id, path, message_date, attempt_gen, attempt_id, kind, n,
          qseq, envelope, h, hub_seq, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(
      turn.project_id,
      turn.path,
      turn.message_date,
      attempt_gen,
      attempt_id,
      kind,
      n,
      qseq,
      envelope,
      h,
      hub_seq,
      now,
    ).changes;
  if (Number(changes) !== 1) {
    // The input record is new, so its queue row must be too.
    throw new Error("c7: queue row already exists for a new input");
  }
}

// Returns true when exactly the turn's lease row now carries the flag.
function writeIncompleteInTx(db: SqliteDatabase, key: C7TurnKey): boolean {
  const changes = db
    .prepare(
      `UPDATE acp_turns SET c7_incomplete = 1
       WHERE project_id = ? AND path = ? AND message_date = ?`,
    )
    .run(key.project_id, key.path, key.message_date).changes;
  return Number(changes) === 1;
}

// ---------------------------------------------------------------------------
// The projected log and objects

function appendProjection(
  db: SqliteDatabase,
  turn: C7TurnContext,
  projection: C7Projection,
  now: number,
): void {
  for (const object of projection.objects) {
    db.prepare(
      `INSERT INTO c7_object
         (object_id, project_id, path, thread_id, class, bytes, sha256, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      object.object_id,
      turn.project_id,
      turn.path,
      turn.thread_id,
      object.class,
      object.body.byteLength,
      sha256Bytes(object.body),
      object.body,
      now,
    );
    for (const dep of object.deps) {
      db.prepare(
        `INSERT INTO c7_object_dep (object_id, project_id, path, message_date)
         VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      ).run(object.object_id, turn.project_id, turn.path, dep);
    }
    fault("projection:after-object");
  }
  if (projection.events.length === 0) return;
  db.prepare(
    `INSERT INTO c7_thread (project_id, path, thread_id, next_seq)
     VALUES (?, ?, ?, 1) ON CONFLICT DO NOTHING`,
  ).run(turn.project_id, turn.path, turn.thread_id);
  const row = db
    .prepare(
      `SELECT next_seq FROM c7_thread
       WHERE project_id = ? AND path = ? AND thread_id = ?`,
    )
    .get(turn.project_id, turn.path, turn.thread_id) as { next_seq: number };
  let seq = Number(row.next_seq);
  for (const draft of projection.events) {
    const event = {
      ...draft,
      thread_id: turn.thread_id,
      seq,
      turn_id: turn.turn_id,
      v: C7_VERSION,
    };
    db.prepare(
      `INSERT INTO c7_log (project_id, path, thread_id, seq, message_date, event)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      turn.project_id,
      turn.path,
      turn.thread_id,
      seq,
      turn.message_date,
      JSON.stringify(event),
    );
    seq += 1;
    fault("projection:after-event");
  }
  db.prepare(
    `UPDATE c7_thread SET next_seq = ?
     WHERE project_id = ? AND path = ? AND thread_id = ?`,
  ).run(seq, turn.project_id, turn.path, turn.thread_id);
}

function newObjectId(): string {
  return randomBytes(16).toString("hex");
}

function projectionContext(
  turn: C7TurnContext,
  attempt_gen: number,
  cutover: boolean,
): C7ProjectionContext {
  return { turn, attempt_gen, cutover, newObjectId };
}

// ---------------------------------------------------------------------------
// The terminal arbiter (§2.5)

export type C7Caller = "ordinary" | "arbiter";

interface DecideArgs {
  turn: C7TurnContext;
  caller: C7Caller;
  // For an ordinary caller, the caller's own attempt. An arbiter caller acts
  // for K and records its winner under the lease's current attempt.
  attempt_id?: string;
  candidate: C7CloseCandidate;
  projector: C7Projector;
  now: number;
}

function decideCloseInTx(db: SqliteDatabase, args: DecideArgs): C7DecideResult {
  const { turn, caller, projector, now } = args;
  const lease = readLease(db, turn);
  const attempt_id =
    caller === "arbiter"
      ? (lease?.attempt_id ?? args.attempt_id)
      : args.attempt_id;
  if (!attempt_id) {
    throw new Error("decide-close without an attempt");
  }
  const attempt_gen =
    lease?.attempt_id === attempt_id ? Number(lease.attempt_gen) : 0;
  const k = nextIndex(db, turn, attempt_id, "close");
  const closeEnvelope: C7CloseEnvelope = {
    kind: "close",
    project_id: turn.project_id,
    path: turn.path,
    message_date: turn.message_date,
    attempt_id,
    attempt_gen,
    k,
    candidate: args.candidate,
  };
  const envelopeText = canonicalJson(closeEnvelope);
  const h = sha256Hex(envelopeText);
  const record = (klass: string) => {
    const qseq = allocQseq(db, turn);
    recordInput(
      db,
      turn,
      attempt_id,
      "close",
      k,
      attempt_gen,
      qseq,
      null,
      h,
      klass,
    );
    writeQueueRow(
      db,
      turn,
      attempt_gen,
      attempt_id,
      "close",
      k,
      qseq,
      envelopeText,
      h,
      null,
      now,
    );
  };

  // 1. A winner exists: the candidate loses and adopts it.
  const existing = readWinner(db, turn);
  if (existing) {
    record(caller === "arbiter" ? "arbiter-loser" : "loser");
    return { role: "loser", winner: existing };
  }
  // 2. An ordinary caller whose attempt isn't current: stale.
  if (caller === "ordinary" && lease?.attempt_id !== attempt_id) {
    record("stale");
    return { role: "stale", winner: null };
  }
  // 3. The winner. An incomplete turn can only end as admission_failed.
  let candidate = args.candidate;
  if (Number(lease?.c7_incomplete ?? 0) === 1 || hasPendingIncomplete(turn)) {
    candidate = { outcome: "error", code: "admission_failed" };
  }
  const base = {
    ...candidate,
    attempt_id,
    attempt_gen,
  };
  const h_close = sha256Hex(canonicalJson(base));
  const winner: C7Winner = { ...base, h_close };
  db.prepare(
    `INSERT INTO c7_close (project_id, path, message_date, record, h_close)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    turn.project_id,
    turn.path,
    turn.message_date,
    JSON.stringify(winner),
    h_close,
  );
  record(caller === "arbiter" ? "arbiter-winner" : "winner");
  const row = ensureTurn(db, turn);
  const projection = projector.close(
    parseState(row),
    winner,
    projectionContext(turn, attempt_gen, false),
  );
  appendProjection(db, turn, projection, now);
  writeState(db, turn, projection.state);
  fault("decide:before-commit");
  return { role: "winner", winner };
}

export function decideClose(
  args: Omit<DecideArgs, "now"> & { now?: number },
): C7DecideResult {
  const db = database();
  flushPendingIncomplete(args.turn);
  return transaction(db, () =>
    decideCloseInTx(db, { ...args, now: args.now ?? Date.now() }),
  );
}

// An integrity refusal (§2.2): through the arbiter, in the caller's
// transaction. Before the winner it becomes the error winner; after it, a
// collision or a gap invalidates the turn, once.
function refuseInTx(
  db: SqliteDatabase,
  turn: C7TurnContext,
  code: C7RefusalCode,
  cause: { attempt_id: string; kind: "in" | "close"; n: number },
  projector: C7Projector,
  now: number,
): void {
  const result = decideCloseInTx(db, {
    turn,
    caller: "arbiter",
    attempt_id: cause.attempt_id,
    candidate: { outcome: "error", code, cause },
    projector,
    now,
  });
  if (result.role !== "loser" || code === "source_malformed") return;
  const row = ensureTurn(db, turn);
  if (row.invalidated_code != null) return;
  const projection = projector.invalidate(
    parseState(row),
    code,
    projectionContext(turn, Number(row.last_attempt_gen), false),
  );
  appendProjection(db, turn, projection, now);
  writeState(db, turn, projection.state);
  db.prepare(
    `UPDATE c7_turn SET invalidated_code = ?
     WHERE project_id = ? AND path = ? AND message_date = ?`,
  ).run(code, turn.project_id, turn.path, turn.message_date);
}

// ---------------------------------------------------------------------------
// Admission (§2.2)

function inputHash(e: {
  origin: C7Origin;
  n: number;
  time: number;
  body: unknown;
}): string {
  return sha256Hex(
    canonicalJson({ origin: e.origin, n: e.n, time: e.time, body: e.body }),
  );
}

export function admitInitial(args: {
  turn: C7TurnContext;
  attempt_id: string;
  origin: C7Origin;
  body: unknown;
  hub_seq?: number | null;
  projector: C7Projector;
  now?: number;
}): C7AdmitResult {
  const { turn, attempt_id, origin, projector } = args;
  const now = args.now ?? Date.now();
  try {
    // One owned snapshot of the body: its canonical text is taken once, and
    // every consumer below gets its own parse of that text.
    const bodyText = canonicalJson(args.body);
    const db = database();
    flushPendingIncomplete(turn);
    return transaction(db, (): C7AdmitResult => {
      const lease = readLease(db, turn);
      if (!lease?.attempt_id) {
        return { result: "refused", reason: "no_attempt" };
      }
      const current = lease.attempt_id === attempt_id;
      const attempt_gen = current ? Number(lease.attempt_gen) : 0;
      const n = nextIndex(db, turn, attempt_id, "in");
      const envelope: C7Envelope = {
        kind: "in",
        project_id: turn.project_id,
        path: turn.path,
        message_date: turn.message_date,
        attempt_id,
        attempt_gen,
        n,
        origin,
        time: now,
        body: JSON.parse(bodyText),
      };
      const text = canonicalJson(envelope);
      const h = inputHash(envelope);
      const row = ensureTurn(db, turn);
      const late = readWinner(db, turn) != null;
      let klass: C7InputClass;
      if (late) klass = "late";
      else if (!current) klass = "stale";
      else if (
        projector.validate(parseState(row), JSON.parse(text)) === "malformed"
      )
        klass = "malformed";
      else klass = "live";
      const qseq = allocQseq(db, turn);
      recordInput(
        db,
        turn,
        attempt_id,
        "in",
        n,
        attempt_gen,
        qseq,
        origin,
        h,
        klass,
      );
      fault("admit:after-record");
      writeQueueRow(
        db,
        turn,
        attempt_gen,
        attempt_id,
        "in",
        n,
        qseq,
        text,
        h,
        args.hub_seq ?? null,
        now,
      );
      fault("admit:after-queue");
      if (klass === "live") {
        const cutover = Number(row.last_attempt_gen) !== attempt_gen;
        const projection = projector.input(
          parseState(row),
          JSON.parse(text) as C7Envelope,
          projectionContext(turn, attempt_gen, cutover),
        );
        appendProjection(db, turn, projection, now);
        writeState(db, turn, projection.state, attempt_gen);
        fault("admit:before-commit");
        return { result: "admitted", envelope: JSON.parse(text) };
      }
      if (klass === "malformed") {
        refuseInTx(
          db,
          turn,
          "source_malformed",
          { attempt_id, kind: "in", n },
          projector,
          now,
        );
      } else {
        countLate(db, turn);
      }
      fault("admit:before-commit");
      return { result: "refused", reason: klass };
    });
  } catch (error) {
    // A storage failure (or a body that has no canonical JSON): nothing was
    // written. The hub still processes the input for the chat, so the turn
    // is incomplete from now on.
    markPendingIncomplete(turn);
    return { result: "storage_failed", error };
  }
}

export interface C7QueueRow {
  attempt_gen: number;
  attempt_id: string;
  kind: "in" | "close";
  n: number;
  qseq: number;
  envelope: string;
  h: string;
  hub_seq: number | null;
}

interface StoredIdentity {
  kind: "in" | "close";
  attempt_id: string;
  attempt_gen: number;
  index: number;
  h: string;
}

// Parses a stored row and recomputes its identity and hash. Anything that
// doesn't parse into a well-formed envelope of this turn returns undefined.
function storedIdentity(
  turn: C7TurnKey,
  row: C7QueueRow,
): StoredIdentity | undefined {
  try {
    const parsed = JSON.parse(row.envelope) as any;
    if (parsed == null || typeof parsed !== "object") return undefined;
    if (
      parsed.project_id !== turn.project_id ||
      parsed.path !== turn.path ||
      parsed.message_date !== turn.message_date
    ) {
      return undefined;
    }
    if (parsed.kind === "in") {
      if (
        typeof parsed.n !== "number" ||
        typeof parsed.time !== "number" ||
        (parsed.origin !== "source" && parsed.origin !== "local")
      ) {
        return undefined;
      }
      return {
        kind: "in",
        attempt_id: parsed.attempt_id,
        attempt_gen: parsed.attempt_gen,
        index: parsed.n,
        h: inputHash(parsed),
      };
    }
    if (parsed.kind === "close") {
      if (typeof parsed.k !== "number") return undefined;
      return {
        kind: "close",
        attempt_id: parsed.attempt_id,
        attempt_gen: parsed.attempt_gen,
        index: parsed.k,
        h: sha256Hex(canonicalJson(parsed)),
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// Replay of a stored queue row (§2.2): a duplicate, or an integrity refusal.
// A refused row is never processed, and only a duplicate of a live input is
// processable.
export function replayRow(args: {
  turn: C7TurnContext;
  row: C7QueueRow;
  projector: C7Projector;
  now?: number;
}): C7ReplayResult {
  const { turn, row, projector } = args;
  const now = args.now ?? Date.now();
  try {
    const db = database();
    return transaction(db, (): C7ReplayResult => {
      const identity = storedIdentity(turn, row);
      const recorded = db
        .prepare(
          `SELECT attempt_gen, qseq, h, class FROM c7_input
           WHERE project_id = ? AND path = ? AND message_date = ?
             AND attempt_id = ? AND kind = ? AND n = ?`,
        )
        .get(
          turn.project_id,
          turn.path,
          turn.message_date,
          row.attempt_id,
          row.kind,
          row.n,
        ) as
        | { attempt_gen: number; qseq: number; h: string; class: string }
        | undefined;
      const exact =
        identity != null &&
        recorded != null &&
        identity.kind === row.kind &&
        identity.attempt_id === row.attempt_id &&
        identity.index === row.n &&
        identity.attempt_gen === row.attempt_gen &&
        Number(recorded.attempt_gen) === row.attempt_gen &&
        Number(recorded.qseq) === row.qseq &&
        identity.h === recorded.h &&
        row.h === recorded.h;
      if (exact) {
        if (row.kind === "close") {
          return {
            result: "duplicate",
            kind: "close",
            class: recorded!.class,
            process: false,
          };
        }
        if (recorded!.class === "live") {
          return {
            result: "duplicate",
            kind: "in",
            class: "live",
            process: true,
            envelope: JSON.parse(row.envelope) as C7Envelope,
          };
        }
        return {
          result: "refused",
          reason: recorded!.class as "stale" | "late" | "malformed",
          integrity: false,
        };
      }
      const reason = recorded ? "collision" : "gap";
      refuseInTx(
        db,
        turn,
        reason === "collision" ? "source_conflict" : "source_gap",
        { attempt_id: row.attempt_id, kind: row.kind, n: row.n },
        projector,
        now,
      );
      return { result: "refused", reason, integrity: true };
    });
  } catch (error) {
    // A genuine storage failure (a bad stored row is an integrity refusal,
    // above): the incomplete fence is set before any fallback runs.
    markPendingIncomplete(turn);
    return { result: "storage_failed", error };
  }
}

// The turn's queue in commit order: inputs and closes merged.
export function listC7QueueRows(key: C7TurnKey): C7QueueRow[] {
  return database()
    .prepare(
      `SELECT attempt_gen, attempt_id, kind, n, qseq, envelope, h, hub_seq
       FROM c7_queue
       WHERE project_id = ? AND path = ? AND message_date = ?
       ORDER BY qseq ASC`,
    )
    .all(key.project_id, key.path, key.message_date) as C7QueueRow[];
}

export function clearC7QueueRows(key: C7TurnKey): void {
  database()
    .prepare(
      `DELETE FROM c7_queue WHERE project_id = ? AND path = ? AND message_date = ?`,
    )
    .run(key.project_id, key.path, key.message_date);
}

const QUEUE_RETENTION_MS = 24 * 60 * 60 * 1000;

export function pruneC7Queue(retentionMs: number = QUEUE_RETENTION_MS): void {
  database()
    .prepare(`DELETE FROM c7_queue WHERE created_at < ?`)
    .run(Date.now() - retentionMs);
}

// ---------------------------------------------------------------------------
// The lease (§2.2): cutover, heartbeat and finalization, compare-and-swap on
// the attempt.

export function startC7LeaseAttempt(args: {
  context: AcpChatContext;
  attempt_id: string;
  owner_instance_id: string;
  pid: number;
  session_id?: string;
  approver_account_id: string;
  now?: number;
}): { attempt_gen: number } {
  const db = database();
  const key: C7TurnKey = {
    project_id: args.context.project_id,
    path: args.context.path,
    message_date: args.context.message_date,
  };
  const inherited = hasPendingIncomplete(key) ? 1 : 0;
  const now = args.now ?? Date.now();
  const result = transaction(db, () => {
    db.prepare(
      `INSERT INTO acp_turns
        (project_id, path, message_date, message_id, thread_id, sender_id,
         approver_account_id, session_id, state, owner_instance_id, pid,
         started_at, heartbeat_at, ended_at, reason,
         attempt_id, attempt_gen, c7_incomplete)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, NULL, NULL, ?, 1, ?)
        ON CONFLICT(project_id, path, message_date) DO UPDATE SET
          message_id = COALESCE(excluded.message_id, acp_turns.message_id),
          thread_id = COALESCE(excluded.thread_id, acp_turns.thread_id),
          sender_id = excluded.sender_id,
          approver_account_id = excluded.approver_account_id,
          session_id = COALESCE(excluded.session_id, acp_turns.session_id),
          state = 'running',
          owner_instance_id = excluded.owner_instance_id,
          pid = excluded.pid,
          started_at = excluded.started_at,
          heartbeat_at = excluded.heartbeat_at,
          ended_at = NULL,
          reason = NULL,
          attempt_id = excluded.attempt_id,
          attempt_gen = acp_turns.attempt_gen + 1,
          c7_incomplete = MAX(acp_turns.c7_incomplete, excluded.c7_incomplete)`,
    ).run(
      key.project_id,
      key.path,
      key.message_date,
      args.context.message_id ?? null,
      args.context.thread_id ?? null,
      args.context.sender_id ?? null,
      args.approver_account_id,
      args.session_id ?? null,
      args.owner_instance_id,
      args.pid,
      now,
      now,
      args.attempt_id,
      inherited,
    );
    fault("cutover:before-commit");
    const lease = readLease(db, key);
    if (lease?.attempt_id !== args.attempt_id) {
      throw new Error("c7: cutover did not take effect");
    }
    return { attempt_gen: Number(lease.attempt_gen) };
  });
  // Only after the commit: the inherited flag is durable now.
  if (inherited) pendingIncomplete.delete(turnKeyString(key));
  return result;
}

// Returns false when the caller's attempt is no longer the lease's current
// one: the caller must stop its heartbeat timer.
export function heartbeatC7Lease(args: {
  key: C7TurnKey;
  owner_instance_id: string;
  attempt_id: string;
  attempt_gen: number;
  pid: number;
  session_id?: string;
}): boolean {
  const changes = database()
    .prepare(
      `UPDATE acp_turns
        SET heartbeat_at = ?, pid = ?, session_id = COALESCE(?, session_id)
        WHERE project_id = ? AND path = ? AND message_date = ?
          AND owner_instance_id = ? AND state = 'running'
          AND attempt_id = ? AND attempt_gen = ?`,
    )
    .run(
      Date.now(),
      args.pid,
      args.session_id ?? null,
      args.key.project_id,
      args.key.path,
      args.key.message_date,
      args.owner_instance_id,
      args.attempt_id,
      args.attempt_gen,
    ).changes;
  return Number(changes) > 0;
}

// The lease state that follows a winner.
export function leaseStateForWinner(
  winner: C7Winner,
): "completed" | "error" | "aborted" {
  if (winner.outcome === "error") {
    return winner.code === "aborted" ? "aborted" : "error";
  }
  return "completed";
}

// The lease ends only with a winner, never because of a stale writer, and
// only for its own owner while it is still running. The lease state follows
// the winner, not the caller's local decision.
export function finalizeC7Lease(args: {
  turn: C7TurnContext;
  owner_instance_id: string;
  attempt_id: string;
  attempt_gen: number;
  reason?: string;
  projector: C7Projector;
  now?: number;
}): {
  ended: boolean;
  stale: boolean;
  winner: C7Winner | null;
  state?: "completed" | "error" | "aborted";
} {
  const db = database();
  const now = args.now ?? Date.now();
  flushPendingIncomplete(args.turn);
  return transaction(db, () => {
    const lease = readLease(db, args.turn);
    if (
      lease == null ||
      lease.attempt_id !== args.attempt_id ||
      Number(lease.attempt_gen) !== args.attempt_gen ||
      lease.owner_instance_id !== args.owner_instance_id ||
      lease.state !== "running"
    ) {
      return { ended: false, stale: true, winner: null };
    }
    const decided = decideCloseInTx(db, {
      turn: args.turn,
      caller: "ordinary",
      attempt_id: args.attempt_id,
      candidate: { outcome: "error", code: "lease_finalized" },
      projector: args.projector,
      now,
    });
    if (decided.winner == null) {
      return { ended: false, stale: true, winner: null };
    }
    const state = leaseStateForWinner(decided.winner);
    fault("finalize:before-update");
    const changes = db
      .prepare(
        `UPDATE acp_turns
          SET state = ?, reason = COALESCE(?, reason), heartbeat_at = ?, ended_at = ?
          WHERE project_id = ? AND path = ? AND message_date = ?
            AND owner_instance_id = ? AND state = 'running'
            AND attempt_id = ? AND attempt_gen = ?`,
      )
      .run(
        state,
        args.reason ?? null,
        now,
        now,
        args.turn.project_id,
        args.turn.path,
        args.turn.message_date,
        args.owner_instance_id,
        args.attempt_id,
        args.attempt_gen,
      ).changes;
    if (Number(changes) !== 1) {
      // The precheck held in this transaction, so this can't happen; roll
      // back rather than leave a winner without its lease ending.
      throw new Error("c7: lease finalization matched no row");
    }
    return { ended: true, stale: false, winner: decided.winner, state };
  });
}

// The fence (§2.2, point 3): a dead worker's running leases are aborted, and
// each turn gets an error winner in the same transaction.
export function fenceC7Project(args: {
  project_id: string;
  reason: string;
  projector: C7Projector;
  now?: number;
}): number {
  const db = database();
  const now = args.now ?? Date.now();
  return transaction(db, () => {
    const leases = db
      .prepare(
        `SELECT project_id, path, message_date, message_id, thread_id
         FROM acp_turns WHERE project_id = ? AND state = 'running'`,
      )
      .all(args.project_id) as Array<{
      project_id: string;
      path: string;
      message_date: string;
      message_id: string | null;
      thread_id: string | null;
    }>;
    for (const lease of leases) {
      if (!lease.message_id || !lease.thread_id) continue;
      const turn: C7TurnContext = {
        project_id: lease.project_id,
        path: lease.path,
        message_date: lease.message_date,
        thread_id: lease.thread_id,
        turn_id: lease.message_id,
      };
      const current = readLease(db, turn);
      if (!current?.attempt_id) continue;
      decideCloseInTx(db, {
        turn,
        caller: "arbiter",
        candidate: { outcome: "error", code: "aborted" },
        projector: args.projector,
        now,
      });
      fault("fence:after-decide");
    }
    fault("fence:before-update");
    return Number(
      db
        .prepare(
          `UPDATE acp_turns
           SET state = 'aborted', reason = ?, heartbeat_at = ?, ended_at = ?
           WHERE project_id = ? AND state = 'running'`,
        )
        .run(args.reason, now, now, args.project_id).changes,
    );
  });
}

// ---------------------------------------------------------------------------
// Reading the log and objects

export function readC7Log(args: {
  project_id: string;
  path: string;
  thread_id: string;
  after_seq: number;
  max_events: number;
  max_bytes: number;
}): { events: unknown[] } | { reset: true } {
  const rows = database()
    .prepare(
      `SELECT event FROM c7_log
       WHERE project_id = ? AND path = ? AND thread_id = ? AND seq > ?
       ORDER BY seq ASC LIMIT ?`,
    )
    .all(
      args.project_id,
      args.path,
      args.thread_id,
      args.after_seq,
      args.max_events + 1,
    ) as Array<{ event: string }>;
  if (rows.length > args.max_events) return { reset: true };
  let bytes = 0;
  const events: unknown[] = [];
  for (const row of rows) {
    bytes += Buffer.byteLength(row.event, "utf8");
    if (bytes > args.max_bytes) return { reset: true };
    events.push(JSON.parse(row.event));
  }
  return { events };
}

export const DERIVED_TTL_MS = 24 * 60 * 60 * 1000;

// One read: the whole committed body, or nothing. A derived object (a page
// or a reset snapshot) older than 24 hours is gone at read time, whether or
// not the sweeper has run yet.
export function readC7Object(
  object_id: string,
  thread: { project_id: string; path: string; thread_id: string },
  now: number = Date.now(),
): { bytes: number; sha256: string; body: Uint8Array } | undefined {
  const row = database()
    .prepare(
      `SELECT bytes, sha256, body FROM c7_object
       WHERE object_id = ? AND project_id = ? AND path = ? AND thread_id = ?
         AND NOT (class IN ('page', 'reset') AND created_at <= ?)`,
    )
    .get(
      object_id,
      thread.project_id,
      thread.path,
      thread.thread_id,
      now - DERIVED_TTL_MS,
    ) as { bytes: number; sha256: string; body: Uint8Array } | undefined;
  return row;
}

// Every object depending on a deleted turn goes in the same transaction
// (§2.6).
export function deleteC7TurnObjects(key: C7TurnKey): number {
  const db = database();
  return transaction(db, () => {
    const ids = db
      .prepare(
        `SELECT DISTINCT object_id FROM c7_object_dep
         WHERE project_id = ? AND path = ? AND message_date = ?`,
      )
      .all(key.project_id, key.path, key.message_date) as Array<{
      object_id: string;
    }>;
    for (const { object_id } of ids) {
      db.prepare(`DELETE FROM c7_object WHERE object_id = ?`).run(object_id);
      db.prepare(`DELETE FROM c7_object_dep WHERE object_id = ?`).run(
        object_id,
      );
    }
    return ids.length;
  });
}

const EXPIRE_BATCH = 200;

// Pages and reset snapshots are derived and expire after 24 hours (§2.6).
// The sweeper deletes in small transactions, so it never holds the write lock
// for long; reads already refuse expired objects (readC7Object).
export function expireC7DerivedObjects(now: number = Date.now()): number {
  const db = database();
  let total = 0;
  for (;;) {
    const deleted = transaction(db, () => {
      fault("expire:batch");
      const ids = db
        .prepare(
          `SELECT object_id FROM c7_object
           WHERE class IN ('page', 'reset') AND created_at <= ?
           LIMIT ?`,
        )
        .all(now - DERIVED_TTL_MS, EXPIRE_BATCH) as Array<{
        object_id: string;
      }>;
      for (const { object_id } of ids) {
        db.prepare(`DELETE FROM c7_object WHERE object_id = ?`).run(object_id);
        db.prepare(`DELETE FROM c7_object_dep WHERE object_id = ?`).run(
          object_id,
        );
      }
      fault(`expire:deleted:${ids.length}`);
      return ids.length;
    });
    total += deleted;
    if (deleted < EXPIRE_BATCH) return total;
  }
}
