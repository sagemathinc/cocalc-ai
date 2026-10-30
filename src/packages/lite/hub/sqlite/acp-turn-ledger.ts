/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The ACP turn ledger: the durable record behind each agent turn's typed
// event stream. Every input a turn feeds into the stream is admitted here, in
// one SQLite transaction per input, together with its queue row, its
// projection and the thread's next seq. The end of a turn is decided here
// too: one winner per turn, shared by the chat and by the event stream.
//
// The projector itself (what events an input produces) is pluggable: this
// module only stores what it returns.

import { randomBytes } from "node:crypto";
import type { AcpChatContext } from "@cocalc/conat/ai/acp/types";
import { getAcpDatabase } from "./acp-database";
import type { SqliteDatabase } from "./acp-database";
import { ensureAcpTurnsSchema } from "./acp-turns";
import { canonicalJson, sha256Bytes, sha256Hex } from "./acp-canonical-json";

export const ACP_LEDGER_VERSION = "1.0";

// ---------------------------------------------------------------------------
// Types

export interface AcpLedgerTurnKey {
  project_id: string;
  path: string;
  message_date: string;
}

// What the ledger needs to know about a turn besides its key.
export interface AcpLedgerTurnContext extends AcpLedgerTurnKey {
  thread_id: string;
  // The assistant reply's chat message id: the event stream's turn_id.
  turn_id: string;
}

export type AcpLedgerOrigin = "source" | "local";

// An immutable hub-ingress envelope. `n` and `time` are assigned
// inside admission; `body` is the payload exactly as received, taken once as
// canonical JSON. Every consumer (the hash, the queue row, the projector and
// the hub) gets its own parse of that one text.
export interface AcpLedgerEnvelope {
  kind: "in";
  project_id: string;
  path: string;
  message_date: string;
  attempt_id: string;
  attempt_gen: number;
  n: number;
  origin: AcpLedgerOrigin;
  time: number;
  body: unknown;
}

export type AcpLedgerOutcome = "completed" | "interrupted" | "error";

export interface AcpLedgerCloseCandidate {
  outcome: AcpLedgerOutcome;
  // The authoritative final text, for a completed close only.
  F?: string;
  code?: string;
  // For an integrity refusal: the input that was refused.
  cause?: { attempt_id: string; kind: "in" | "close"; n: number };
}

export interface AcpLedgerWinner extends AcpLedgerCloseCandidate {
  attempt_id: string;
  attempt_gen: number;
  h_close: string;
}

// A stored close candidate. Closes are keyed (K, attempt, "close", k): `k`
// numbers an attempt's close candidates in their own namespace, never shared
// with input ordinals: a close is never an ordinal.
export interface AcpLedgerCloseEnvelope {
  kind: "close";
  project_id: string;
  path: string;
  message_date: string;
  attempt_id: string;
  attempt_gen: number;
  k: number;
  candidate: AcpLedgerCloseCandidate;
}

// An event as the projector returns it: the store adds thread_id, seq,
// turn_id and v.
export interface AcpLedgerEventDraft {
  type: string;
  [field: string]: unknown;
}

export type AcpLedgerObjectClass = "diff" | "tool_body" | "page" | "reset";

export interface AcpLedgerObjectDraft {
  object_id: string;
  class: AcpLedgerObjectClass;
  body: Uint8Array;
  // The turns (message_date of each) this object depends on.
  deps: string[];
}

export interface AcpLedgerProjection {
  state: unknown;
  events: AcpLedgerEventDraft[];
  objects: AcpLedgerObjectDraft[];
}

export interface AcpLedgerProjectionContext {
  turn: AcpLedgerTurnContext;
  attempt_gen: number;
  // True at the first admitted input of a new current attempt.
  cutover: boolean;
  newObjectId: () => string;
}

export type AcpLedgerRefusalCode =
  | "source_conflict"
  | "source_gap"
  | "source_malformed";

export interface AcpLedgerProjector {
  // Is this input well-formed against the turn's state?
  validate(state: unknown, envelope: AcpLedgerEnvelope): "ok" | "malformed";
  // A live, admitted input.
  input(
    state: unknown,
    envelope: AcpLedgerEnvelope,
    ctx: AcpLedgerProjectionContext,
  ): AcpLedgerProjection;
  // The turn's winner, the first time it is recorded.
  close(
    state: unknown,
    winner: AcpLedgerWinner,
    ctx: AcpLedgerProjectionContext,
  ): AcpLedgerProjection;
  // An integrity refusal after the winner: one turn_invalidated.
  invalidate(
    state: unknown,
    code: AcpLedgerRefusalCode,
    ctx: AcpLedgerProjectionContext,
  ): AcpLedgerProjection;
}

// The class an input was given at admission. Only `live` inputs are ever
// processed by the hub, at admission or on replay.
export type AcpLedgerInputClass = "live" | "stale" | "late" | "malformed";

export type AcpLedgerAdmitResult =
  | { result: "admitted"; envelope: AcpLedgerEnvelope }
  | {
      result: "refused";
      reason: "stale" | "late" | "malformed" | "no_attempt";
    }
  | { result: "storage_failed"; error: unknown };

export type AcpLedgerReplayResult =
  // A stored row that matches its record exactly: a live input (processable,
  // with its own parse of the stored text), or a close candidate (never
  // processed).
  | {
      result: "duplicate";
      kind: "in";
      class: "live";
      process: true;
      envelope: AcpLedgerEnvelope;
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

export type AcpLedgerDecideResult =
  | { role: "winner"; winner: AcpLedgerWinner }
  | { role: "loser"; winner: AcpLedgerWinner }
  | { role: "stale"; winner: null };

// ---------------------------------------------------------------------------
// Fault injection (tests only): called at named points inside transactions.

let faultHook: ((point: string) => void) | undefined;

export function __setAcpLedgerFaultHook(hook?: (point: string) => void): void {
  faultHook = hook;
}

function fault(point: string): void {
  faultHook?.(point);
}

// Mutation switch (tests only): lets a test break one handler on purpose, to
// prove that its control detects the breakage. Off by default; nothing
// outside the tests may set it (a test checks both).
export type AcpLedgerMutation = "skip-commit-rollback";

let mutation: AcpLedgerMutation | undefined;

export function __setAcpLedgerMutationForTests(
  value?: AcpLedgerMutation,
): void {
  mutation = value;
}

export function __getAcpLedgerMutationForTests():
  | AcpLedgerMutation
  | undefined {
  return mutation;
}

// ---------------------------------------------------------------------------
// The process-level pending flags: turns whose admission failed and
// whose durable ledger_incomplete write hasn't committed yet. An entry outlives
// the writer that recorded it; it is removed only after a transaction that
// wrote the flag to the turn's lease row has committed.

const pendingIncomplete = new Set<string>();

function turnKeyString(key: AcpLedgerTurnKey): string {
  return JSON.stringify([key.project_id, key.path, key.message_date]);
}

export function markPendingIncomplete(key: AcpLedgerTurnKey): void {
  pendingIncomplete.add(turnKeyString(key));
}

export function hasPendingIncomplete(key: AcpLedgerTurnKey): boolean {
  return pendingIncomplete.has(turnKeyString(key));
}

// Writes K's pending flag durably, if there is one. Returns true when nothing
// is pending any more. A failure, or a missing lease row, keeps the entry.
export function flushPendingIncomplete(key: AcpLedgerTurnKey): boolean {
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

export function __resetAcpLedgerInitForTests(): void {
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
  if (!has("ledger_incomplete")) {
    db.exec(
      `ALTER TABLE acp_turns ADD COLUMN ledger_incomplete INTEGER NOT NULL DEFAULT 0`,
    );
  }
  // One record per admitted input (kind "in", by ordinal n) and per close
  // candidate (kind "close", by candidate index k), with the attempt_gen it
  // was admitted under, its commit position qseq, its hash and its class.
  db.exec(`
    CREATE TABLE IF NOT EXISTS acp_ledger_input (
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
    CREATE TABLE IF NOT EXISTS acp_ledger_queue (
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
    `CREATE INDEX IF NOT EXISTS acp_ledger_queue_order_idx ON acp_ledger_queue(project_id, path, message_date, qseq)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_ledger_queue_created_idx ON acp_ledger_queue(created_at)`,
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS acp_ledger_turn (
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
    CREATE TABLE IF NOT EXISTS acp_ledger_close (
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      message_date TEXT NOT NULL,
      record TEXT NOT NULL,
      h_close TEXT NOT NULL,
      PRIMARY KEY (project_id, path, message_date)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS acp_ledger_thread (
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      next_seq INTEGER NOT NULL,
      PRIMARY KEY (project_id, path, thread_id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS acp_ledger_log (
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
    CREATE TABLE IF NOT EXISTS acp_ledger_object (
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
    `CREATE INDEX IF NOT EXISTS acp_ledger_object_class_created_idx ON acp_ledger_object(class, created_at)`,
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS acp_ledger_object_dep (
      object_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      message_date TEXT NOT NULL,
      PRIMARY KEY (object_id, project_id, path, message_date)
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_ledger_object_dep_turn_idx ON acp_ledger_object_dep(project_id, path, message_date)`,
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
    if (mutation !== "skip-commit-rollback") {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore
      }
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
  ledger_incomplete: number;
  state: string;
  owner_instance_id: string;
}

function readLease(
  db: SqliteDatabase,
  key: AcpLedgerTurnKey,
): LeaseRow | undefined {
  return db
    .prepare(
      `SELECT attempt_id, attempt_gen, ledger_incomplete, state, owner_instance_id
       FROM acp_turns
       WHERE project_id = ? AND path = ? AND message_date = ?`,
    )
    .get(key.project_id, key.path, key.message_date) as LeaseRow | undefined;
}

function readWinner(
  db: SqliteDatabase,
  key: AcpLedgerTurnKey,
): AcpLedgerWinner | undefined {
  const row = db
    .prepare(
      `SELECT record FROM acp_ledger_close
       WHERE project_id = ? AND path = ? AND message_date = ?`,
    )
    .get(key.project_id, key.path, key.message_date) as
    | { record: string }
    | undefined;
  return row ? (JSON.parse(row.record) as AcpLedgerWinner) : undefined;
}

export function getAcpLedgerWinner(
  key: AcpLedgerTurnKey,
): AcpLedgerWinner | undefined {
  return readWinner(database(), key);
}

interface TurnRow {
  state: string | null;
  last_attempt_gen: number;
  next_qseq: number;
  invalidated_code: string | null;
}

function readTurn(
  db: SqliteDatabase,
  key: AcpLedgerTurnKey,
): TurnRow | undefined {
  return db
    .prepare(
      `SELECT state, last_attempt_gen, next_qseq, invalidated_code FROM acp_ledger_turn
       WHERE project_id = ? AND path = ? AND message_date = ?`,
    )
    .get(key.project_id, key.path, key.message_date) as TurnRow | undefined;
}

function ensureTurn(db: SqliteDatabase, turn: AcpLedgerTurnContext): TurnRow {
  db.prepare(
    `INSERT INTO acp_ledger_turn (project_id, path, message_date, thread_id, turn_id)
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
  key: AcpLedgerTurnKey,
  state: unknown,
  last_attempt_gen?: number,
): void {
  const text = state === undefined ? null : JSON.stringify(state);
  if (last_attempt_gen == null) {
    db.prepare(
      `UPDATE acp_ledger_turn SET state = ?
       WHERE project_id = ? AND path = ? AND message_date = ?`,
    ).run(text, key.project_id, key.path, key.message_date);
  } else {
    db.prepare(
      `UPDATE acp_ledger_turn SET state = ?, last_attempt_gen = ?
       WHERE project_id = ? AND path = ? AND message_date = ?`,
    ).run(text, last_attempt_gen, key.project_id, key.path, key.message_date);
  }
}

function countLate(db: SqliteDatabase, key: AcpLedgerTurnKey): void {
  db.prepare(
    `UPDATE acp_ledger_turn SET late_count = late_count + 1
     WHERE project_id = ? AND path = ? AND message_date = ?`,
  ).run(key.project_id, key.path, key.message_date);
}

function nextIndex(
  db: SqliteDatabase,
  key: AcpLedgerTurnKey,
  attempt_id: string,
  kind: "in" | "close",
): number {
  const row = db
    .prepare(
      `SELECT MAX(n) AS n FROM acp_ledger_input
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
  key: AcpLedgerTurnKey,
  attempt_id: string,
  kind: "in" | "close",
  n: number,
  attempt_gen: number,
  qseq: number,
  origin: AcpLedgerOrigin | null,
  h: string,
  klass: string,
): void {
  db.prepare(
    `INSERT INTO acp_ledger_input
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
// committed, inputs and closes merged. It is recorded in acp_ledger_input as well as
// the queue, and replay requires the two to agree.
function allocQseq(db: SqliteDatabase, turn: AcpLedgerTurnContext): number {
  const row = ensureTurn(db, turn);
  const qseq = Number(row.next_qseq);
  db.prepare(
    `UPDATE acp_ledger_turn SET next_qseq = ?
     WHERE project_id = ? AND path = ? AND message_date = ?`,
  ).run(qseq + 1, turn.project_id, turn.path, turn.message_date);
  return qseq;
}

// Insert-once, at the commit position allocQseq gave.
function writeQueueRow(
  db: SqliteDatabase,
  turn: AcpLedgerTurnContext,
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
      `INSERT INTO acp_ledger_queue
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
    throw new Error(
      "acp turn ledger: queue row already exists for a new input",
    );
  }
}

// Returns true when exactly the turn's lease row now carries the flag.
function writeIncompleteInTx(
  db: SqliteDatabase,
  key: AcpLedgerTurnKey,
): boolean {
  const changes = db
    .prepare(
      `UPDATE acp_turns SET ledger_incomplete = 1
       WHERE project_id = ? AND path = ? AND message_date = ?`,
    )
    .run(key.project_id, key.path, key.message_date).changes;
  return Number(changes) === 1;
}

// ---------------------------------------------------------------------------
// The projected log and objects

function appendProjection(
  db: SqliteDatabase,
  turn: AcpLedgerTurnContext,
  projection: AcpLedgerProjection,
  now: number,
): void {
  for (const object of projection.objects) {
    db.prepare(
      `INSERT INTO acp_ledger_object
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
        `INSERT INTO acp_ledger_object_dep (object_id, project_id, path, message_date)
         VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      ).run(object.object_id, turn.project_id, turn.path, dep);
    }
    fault("projection:after-object");
  }
  if (projection.events.length === 0) return;
  db.prepare(
    `INSERT INTO acp_ledger_thread (project_id, path, thread_id, next_seq)
     VALUES (?, ?, ?, 1) ON CONFLICT DO NOTHING`,
  ).run(turn.project_id, turn.path, turn.thread_id);
  const row = db
    .prepare(
      `SELECT next_seq FROM acp_ledger_thread
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
      v: ACP_LEDGER_VERSION,
    };
    db.prepare(
      `INSERT INTO acp_ledger_log (project_id, path, thread_id, seq, message_date, event)
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
    `UPDATE acp_ledger_thread SET next_seq = ?
     WHERE project_id = ? AND path = ? AND thread_id = ?`,
  ).run(seq, turn.project_id, turn.path, turn.thread_id);
}

function newObjectId(): string {
  return randomBytes(16).toString("hex");
}

function projectionContext(
  turn: AcpLedgerTurnContext,
  attempt_gen: number,
  cutover: boolean,
): AcpLedgerProjectionContext {
  return { turn, attempt_gen, cutover, newObjectId };
}

// ---------------------------------------------------------------------------
// The terminal arbiter

export type AcpLedgerCaller = "ordinary" | "arbiter";

interface DecideArgs {
  turn: AcpLedgerTurnContext;
  caller: AcpLedgerCaller;
  // For an ordinary caller, the caller's own attempt. An arbiter caller acts
  // for K and records its winner under the lease's current attempt.
  attempt_id?: string;
  candidate: AcpLedgerCloseCandidate;
  projector: AcpLedgerProjector;
  now: number;
}

function decideCloseInTx(
  db: SqliteDatabase,
  args: DecideArgs,
): AcpLedgerDecideResult {
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
  const closeEnvelope: AcpLedgerCloseEnvelope = {
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
  if (
    Number(lease?.ledger_incomplete ?? 0) === 1 ||
    hasPendingIncomplete(turn)
  ) {
    candidate = { outcome: "error", code: "admission_failed" };
  }
  const base = {
    ...candidate,
    attempt_id,
    attempt_gen,
  };
  const h_close = sha256Hex(canonicalJson(base));
  const winner: AcpLedgerWinner = { ...base, h_close };
  db.prepare(
    `INSERT INTO acp_ledger_close (project_id, path, message_date, record, h_close)
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
): AcpLedgerDecideResult {
  const db = database();
  flushPendingIncomplete(args.turn);
  return transaction(db, () =>
    decideCloseInTx(db, { ...args, now: args.now ?? Date.now() }),
  );
}

// An integrity refusal: through the arbiter, in the caller's
// transaction. Before the winner it becomes the error winner; after it, a
// collision or a gap invalidates the turn, once.
function refuseInTx(
  db: SqliteDatabase,
  turn: AcpLedgerTurnContext,
  code: AcpLedgerRefusalCode,
  cause: { attempt_id: string; kind: "in" | "close"; n: number },
  projector: AcpLedgerProjector,
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
    `UPDATE acp_ledger_turn SET invalidated_code = ?
     WHERE project_id = ? AND path = ? AND message_date = ?`,
  ).run(code, turn.project_id, turn.path, turn.message_date);
}

// ---------------------------------------------------------------------------
// Admission

function inputHash(e: {
  origin: AcpLedgerOrigin;
  n: number;
  time: number;
  body: unknown;
}): string {
  return sha256Hex(
    canonicalJson({ origin: e.origin, n: e.n, time: e.time, body: e.body }),
  );
}

export function admitInitial(args: {
  turn: AcpLedgerTurnContext;
  attempt_id: string;
  origin: AcpLedgerOrigin;
  body: unknown;
  hub_seq?: number | null;
  projector: AcpLedgerProjector;
  now?: number;
}): AcpLedgerAdmitResult {
  const { turn, attempt_id, origin, projector } = args;
  const now = args.now ?? Date.now();
  try {
    // One owned snapshot of the body: its canonical text is taken once, and
    // every consumer below gets its own parse of that text.
    const bodyText = canonicalJson(args.body);
    const db = database();
    flushPendingIncomplete(turn);
    return transaction(db, (): AcpLedgerAdmitResult => {
      const lease = readLease(db, turn);
      if (!lease?.attempt_id) {
        return { result: "refused", reason: "no_attempt" };
      }
      const current = lease.attempt_id === attempt_id;
      const attempt_gen = current ? Number(lease.attempt_gen) : 0;
      const n = nextIndex(db, turn, attempt_id, "in");
      const envelope: AcpLedgerEnvelope = {
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
      let klass: AcpLedgerInputClass;
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
          JSON.parse(text) as AcpLedgerEnvelope,
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

export interface AcpLedgerQueueRow {
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
  turn: AcpLedgerTurnKey,
  row: AcpLedgerQueueRow,
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

// Replay of a stored queue row: a duplicate, or an integrity refusal.
// A refused row is never processed, and only a duplicate of a live input is
// processable.
export function replayRow(args: {
  turn: AcpLedgerTurnContext;
  row: AcpLedgerQueueRow;
  projector: AcpLedgerProjector;
  now?: number;
}): AcpLedgerReplayResult {
  const { turn, row, projector } = args;
  const now = args.now ?? Date.now();
  try {
    const db = database();
    return transaction(db, (): AcpLedgerReplayResult => {
      const identity = storedIdentity(turn, row);
      const recorded = db
        .prepare(
          `SELECT attempt_gen, qseq, h, class FROM acp_ledger_input
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
            envelope: JSON.parse(row.envelope) as AcpLedgerEnvelope,
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
export function listAcpLedgerQueueRows(
  key: AcpLedgerTurnKey,
): AcpLedgerQueueRow[] {
  return database()
    .prepare(
      `SELECT attempt_gen, attempt_id, kind, n, qseq, envelope, h, hub_seq
       FROM acp_ledger_queue
       WHERE project_id = ? AND path = ? AND message_date = ?
       ORDER BY qseq ASC`,
    )
    .all(key.project_id, key.path, key.message_date) as AcpLedgerQueueRow[];
}

export function clearAcpLedgerQueueRows(key: AcpLedgerTurnKey): void {
  database()
    .prepare(
      `DELETE FROM acp_ledger_queue WHERE project_id = ? AND path = ? AND message_date = ?`,
    )
    .run(key.project_id, key.path, key.message_date);
}

const QUEUE_RETENTION_MS = 24 * 60 * 60 * 1000;

export function pruneAcpLedgerQueue(
  retentionMs: number = QUEUE_RETENTION_MS,
): void {
  database()
    .prepare(`DELETE FROM acp_ledger_queue WHERE created_at < ?`)
    .run(Date.now() - retentionMs);
}

// ---------------------------------------------------------------------------
// The lease: cutover, heartbeat and finalization, compare-and-swap on
// the attempt.

export function startAcpLedgerLeaseAttempt(args: {
  context: AcpChatContext;
  attempt_id: string;
  owner_instance_id: string;
  pid: number;
  session_id?: string;
  approver_account_id: string;
  now?: number;
}): { attempt_gen: number } {
  const db = database();
  const key: AcpLedgerTurnKey = {
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
         attempt_id, attempt_gen, ledger_incomplete)
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
          ledger_incomplete = MAX(acp_turns.ledger_incomplete, excluded.ledger_incomplete)`,
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
      throw new Error("acp turn ledger: cutover did not take effect");
    }
    return { attempt_gen: Number(lease.attempt_gen) };
  });
  // Only after the commit: the inherited flag is durable now.
  if (inherited) pendingIncomplete.delete(turnKeyString(key));
  return result;
}

// Returns false when the caller's attempt is no longer the lease's current
// one: the caller must stop its heartbeat timer.
export function heartbeatAcpLedgerLease(args: {
  key: AcpLedgerTurnKey;
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
  winner: AcpLedgerWinner,
): "completed" | "error" | "aborted" {
  if (winner.outcome === "error") {
    return winner.code === "aborted" ? "aborted" : "error";
  }
  return "completed";
}

// The lease ends only with a winner, never because of a stale writer, and
// only for its own owner while it is still running. The lease state follows
// the winner, not the caller's local decision.
export function finalizeAcpLedgerLease(args: {
  turn: AcpLedgerTurnContext;
  owner_instance_id: string;
  attempt_id: string;
  attempt_gen: number;
  reason?: string;
  projector: AcpLedgerProjector;
  now?: number;
}): {
  ended: boolean;
  stale: boolean;
  winner: AcpLedgerWinner | null;
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
      throw new Error("acp turn ledger: lease finalization matched no row");
    }
    return { ended: true, stale: false, winner: decided.winner, state };
  });
}

// The fence: each of a dead worker's running ledger turns gets its winner (an
// aborted error, unless one was already recorded), and its lease ends with
// that winner's state, in one transaction. A running lease the ledger can't
// decide (no message or thread id, or never cut over to an attempt) is left
// running: it isn't a ledger turn, and the caller's legacy fence ends it.
// Returns the number of leases ended.
export function fenceAcpLedgerProject(args: {
  project_id: string;
  reason: string;
  projector: AcpLedgerProjector;
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
    let ended = 0;
    for (const lease of leases) {
      if (!lease.message_id || !lease.thread_id) continue;
      const turn: AcpLedgerTurnContext = {
        project_id: lease.project_id,
        path: lease.path,
        message_date: lease.message_date,
        thread_id: lease.thread_id,
        turn_id: lease.message_id,
      };
      const current = readLease(db, turn);
      if (!current?.attempt_id) continue;
      const decided = decideCloseInTx(db, {
        turn,
        caller: "arbiter",
        candidate: { outcome: "error", code: "aborted" },
        projector: args.projector,
        now,
      });
      fault("fence:after-decide");
      if (!decided.winner) continue;
      fault("fence:before-update");
      const changes = db
        .prepare(
          `UPDATE acp_turns
           SET state = ?, reason = ?, heartbeat_at = ?, ended_at = ?
           WHERE project_id = ? AND path = ? AND message_date = ?
             AND state = 'running' AND attempt_id = ? AND attempt_gen = ?`,
        )
        .run(
          leaseStateForWinner(decided.winner),
          args.reason,
          now,
          now,
          turn.project_id,
          turn.path,
          turn.message_date,
          current.attempt_id,
          current.attempt_gen,
        ).changes;
      if (Number(changes) !== 1) {
        // The row was read as running in this transaction; roll back rather
        // than leave a winner whose lease didn't end.
        throw new Error("acp turn ledger: fence matched no lease row");
      }
      ended += 1;
    }
    return ended;
  });
}

// ---------------------------------------------------------------------------
// Reading the log and objects

export function readAcpLedgerLog(args: {
  project_id: string;
  path: string;
  thread_id: string;
  after_seq: number;
  max_events: number;
  max_bytes: number;
}): { events: unknown[] } | { reset: true } {
  const rows = database()
    .prepare(
      `SELECT event FROM acp_ledger_log
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
export function readAcpLedgerObject(
  object_id: string,
  thread: { project_id: string; path: string; thread_id: string },
  now: number = Date.now(),
): { bytes: number; sha256: string; body: Uint8Array } | undefined {
  const row = database()
    .prepare(
      `SELECT bytes, sha256, body FROM acp_ledger_object
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

// Every object depending on a deleted turn goes in the same transaction.
export function deleteAcpLedgerTurnObjects(key: AcpLedgerTurnKey): number {
  const db = database();
  return transaction(db, () => {
    const ids = db
      .prepare(
        `SELECT DISTINCT object_id FROM acp_ledger_object_dep
         WHERE project_id = ? AND path = ? AND message_date = ?`,
      )
      .all(key.project_id, key.path, key.message_date) as Array<{
      object_id: string;
    }>;
    for (const { object_id } of ids) {
      db.prepare(`DELETE FROM acp_ledger_object WHERE object_id = ?`).run(
        object_id,
      );
      db.prepare(`DELETE FROM acp_ledger_object_dep WHERE object_id = ?`).run(
        object_id,
      );
    }
    return ids.length;
  });
}

const EXPIRE_BATCH = 200;

// Pages and reset snapshots are derived and expire after 24 hours.
// The sweeper deletes in small transactions, so it never holds the write lock
// for long; reads already refuse expired objects (readAcpLedgerObject).
export function expireAcpLedgerDerivedObjects(
  now: number = Date.now(),
): number {
  const db = database();
  let total = 0;
  for (;;) {
    const deleted = transaction(db, () => {
      fault("expire:batch");
      const ids = db
        .prepare(
          `SELECT object_id FROM acp_ledger_object
           WHERE class IN ('page', 'reset') AND created_at <= ?
           LIMIT ?`,
        )
        .all(now - DERIVED_TTL_MS, EXPIRE_BATCH) as Array<{
        object_id: string;
      }>;
      for (const { object_id } of ids) {
        db.prepare(`DELETE FROM acp_ledger_object WHERE object_id = ?`).run(
          object_id,
        );
        db.prepare(`DELETE FROM acp_ledger_object_dep WHERE object_id = ?`).run(
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
