// Board submissions admitted as agent guidance or turns. Two jobs:
//
// - The hub's bound on how many new Sagebrush board submissions one account
//   sends one thread an hour, whatever page, tab or channel they come from
//   (daybreak2, LIMIT-A4B-1).
// - Each submission's identity (its user message) and its delivery, sent at
//   most once (astra2/astra, CORR-D1-1, CORR-E69-2). An attempt holds a
//   token; it may hand the guidance to a live turn only while its token is
//   current, and only it can record how that ended. Once a hand-off has
//   started, nothing sends the submission again unless the outcome is known:
//   a lost reply or a timeout is not proof it wasn't injected.
//
// Two lifecycles (daybreak2/astra, ROBUST-E69-1, CORR-E69-1): the bound
// counts only the last hour's admissions, while a submission's record is
// kept for BOARD_SUBMISSION_RETENTION_MS and never deleted while its attempt
// may be live. A record that is gone is still checked against the hub's
// durable traces before it is sent again (lite/hub/acp/index.ts). An
// uncertain submission leaves no such trace by itself, so the hub writes
// one, on its chat message; its record is deleted only once that marker is
// written (uncertain_recorded), so "uncertain" never expires
// (ROBUST-F386-1).

import { randomUUID } from "node:crypto";
import { getAcpDatabase } from "./acp-database";

const TABLE = "acp_board_submissions";

/** New board submissions one account may send one thread in WINDOW_MS. */
export const BOARD_SUBMISSIONS_PER_THREAD_PER_HOUR = 30;
export const BOARD_SUBMISSION_WINDOW_MS = 60 * 60_000;
/** An attempt that hasn't reached its hand-off for this long is taken to
 * have stopped (the hub restarted): a retry may take over. */
export const BOARD_SUBMISSION_ATTEMPT_MS = 2 * 60_000;
/** How long a submission's record (its identity and outcome) is kept. */
export const BOARD_SUBMISSION_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** Submissions one account may hold that are, or may become, uncertain
 * without a marker on their message: unmarked uncertain ones, and ones whose
 * attempt hasn't ended (a reservation, released by a definite outcome).
 * Past that its new board submissions are refused until they are
 * reconciled (daybreak2, LIMIT-A65-1; astra2, LIMIT-268-1). */
export const BOARD_UNMARKED_UNCERTAIN_PER_ACCOUNT = 100;
/** The outcome of a submission whose hand-off to a live turn started but
 * never answered: it is never sent again. */
export const BOARD_SUBMISSION_UNCERTAIN = "uncertain";

let initialized = false;

function ensureInit(): void {
  if (initialized) return;
  const db = getAcpDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      admitted_at INTEGER NOT NULL,
      attempt_token TEXT,
      attempt_at INTEGER NOT NULL,
      injected_at INTEGER,
      outcome TEXT,
      uncertain_recorded INTEGER,
      PRIMARY KEY (project_id, path, user_message_id)
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_thread_idx ON ${TABLE}(account_id, project_id, path, thread_id, admitted_at)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_admitted_idx ON ${TABLE}(admitted_at)`,
  );
  // An account's uncertain submissions not yet marked on their messages:
  // what its cap counts and reconciliation reads (LIMIT-A65-1).
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_unmarked_idx ON ${TABLE}(account_id, admitted_at)
      WHERE outcome = 'uncertain' AND uncertain_recorded IS NULL`,
  );
  // An account's submissions with no outcome yet: the cap's reservations.
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_pending_idx ON ${TABLE}(account_id)
      WHERE outcome IS NULL`,
  );
  // Only hand-offs still unresolved: what the silence check reads, without
  // scanning the table (LIMIT-F386-2).
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_injecting_idx ON ${TABLE}(injected_at)
      WHERE outcome IS NULL AND injected_at IS NOT NULL`,
  );
  initialized = true;
}

/** For tests, after the database is replaced. */
export function resetBoardSubmissionsForTests(): void {
  initialized = false;
}

export interface BoardSubmissionKey {
  account_id: string;
  project_id: string;
  path: string;
  thread_id: string;
  user_message_id: string;
}

export type BoardSubmissionAdmission =
  /** A new submission, admitted under the bound: send it, as `token`. */
  | { ok: true; kind: "new"; token: string }
  /** Sent before, and how it ended is recorded: answer with this state
   * (BOARD_SUBMISSION_UNCERTAIN: refuse, and never send it again; record
   * its marker if `recorded` is false). */
  | { ok: true; kind: "admitted"; state: string; recorded: boolean }
  /** Sent before, still unresolved; `injecting` if its hand-off started. */
  | { ok: true; kind: "unknown"; attempt_at: number; injecting: boolean }
  | { ok: false; retry_after_ms: number; reason?: "unresolved" };

function checkKey(key: BoardSubmissionKey): void {
  if (
    !key.account_id ||
    !key.project_id ||
    !key.path ||
    !key.thread_id ||
    !key.user_message_id
  ) {
    throw new Error("a board submission needs its account and chat identity");
  }
}

function inTransaction<T>(fn: () => T): T {
  // One write transaction (the database is shared by the hub's processes):
  // a check and its write can't interleave with another admission.
  const db = getAcpDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// Every write of an attempt names its key and, where it must be the
// current attempt, its token (compare-and-set).
const KEY_WHERE = `project_id = ? AND path = ? AND user_message_id = ? AND account_id = ?`;
const keyArgs = (key: BoardSubmissionKey) => [
  key.project_id,
  key.path,
  key.user_message_id,
  key.account_id,
];
const changed = (result: unknown) =>
  Number((result as { changes?: number | bigint })?.changes ?? 0) > 0;

/** Admit one board submission message, atomically. A submission seen before
 * takes no new slot; a new one is admitted only while the account has sent
 * this thread fewer than the limit in the window. */
export function admitBoardSubmission(
  key: BoardSubmissionKey,
  {
    now = Date.now(),
    limit = BOARD_SUBMISSIONS_PER_THREAD_PER_HOUR,
    unmarked_limit = BOARD_UNMARKED_UNCERTAIN_PER_ACCOUNT,
    window_ms = BOARD_SUBMISSION_WINDOW_MS,
    retention_ms = BOARD_SUBMISSION_RETENTION_MS,
    attempt_ms = BOARD_SUBMISSION_ATTEMPT_MS,
  }: {
    now?: number;
    limit?: number;
    unmarked_limit?: number;
    window_ms?: number;
    retention_ms?: number;
    attempt_ms?: number;
  } = {},
): BoardSubmissionAdmission {
  checkKey(key);
  ensureInit();
  const db = getAcpDatabase();
  const { account_id, project_id, path, thread_id, user_message_id } = key;
  return inTransaction((): BoardSubmissionAdmission => {
    // A hand-off silent for longer than an attempt may take is uncertain.
    db.prepare(
      `UPDATE ${TABLE} SET outcome = ?
        WHERE outcome IS NULL AND injected_at IS NOT NULL AND injected_at <= ?`,
    ).run(BOARD_SUBMISSION_UNCERTAIN, now - attempt_ms);
    // Records past their retention: resolved ones (an uncertain one only once
    // its marker is on its message), and ones whose hand-off never started
    // and whose attempt has ended (a retry finds nothing to lose). Never one
    // that may be in flight.
    db.prepare(
      `DELETE FROM ${TABLE}
        WHERE admitted_at <= ?
          AND ((outcome IS NOT NULL
                AND (outcome <> ? OR uncertain_recorded IS NOT NULL))
               OR (outcome IS NULL AND injected_at IS NULL
                   AND (attempt_at = 0 OR attempt_at <= ?)))`,
    ).run(now - retention_ms, BOARD_SUBMISSION_UNCERTAIN, now - attempt_ms);
    const existing = db
      .prepare(
        `SELECT account_id, outcome, attempt_at, injected_at, uncertain_recorded
           FROM ${TABLE}
          WHERE project_id = ? AND path = ? AND user_message_id = ?`,
      )
      .get(project_id, path, user_message_id) as
      | {
          account_id: string;
          outcome: string | null;
          attempt_at: number;
          injected_at: number | null;
          uncertain_recorded: number | null;
        }
      | undefined;
    if (existing) {
      // Only its own sender's retry is the same submission.
      if (existing.account_id !== account_id) {
        throw new Error("this board submission was sent by another account");
      }
      return existing.outcome
        ? {
            ok: true,
            kind: "admitted",
            state: existing.outcome,
            recorded: existing.uncertain_recorded != null,
          }
        : {
            ok: true,
            kind: "unknown",
            attempt_at: existing.attempt_at,
            injecting: existing.injected_at != null,
          };
    }
    // Fail closed while too many of this account's submissions are, or may
    // become, uncertain without a marker: they are kept until reconciled,
    // so they must be bounded, counting attempts still in flight.
    if (potentialUncertain(db, account_id) >= unmarked_limit) {
      return { ok: false, retry_after_ms: attempt_ms, reason: "unresolved" };
    }
    const recent = db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(admitted_at) AS oldest FROM ${TABLE}
          WHERE account_id = ? AND project_id = ? AND path = ? AND thread_id = ?
            AND admitted_at > ?`,
      )
      .get(account_id, project_id, path, thread_id, now - window_ms) as {
      n: number;
      oldest: number | null;
    };
    if (recent.n >= limit) {
      return {
        ok: false,
        retry_after_ms: Math.max(0, (recent.oldest ?? now) + window_ms - now),
      };
    }
    const token = randomUUID();
    db.prepare(
      `INSERT INTO ${TABLE}
        (project_id, path, user_message_id, account_id, thread_id, admitted_at,
         attempt_token, attempt_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      project_id,
      path,
      user_message_id,
      account_id,
      thread_id,
      now,
      token,
      now,
    );
    return { ok: true, kind: "new", token };
  });
}

/** The account's submissions that are, or may become, uncertain without a
 * marker: unmarked uncertain ones, and ones whose attempt hasn't ended. */
function potentialUncertain(
  db: ReturnType<typeof getAcpDatabase>,
  account_id: string,
): number {
  const unmarked = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ${TABLE}
        WHERE account_id = ? AND outcome = 'uncertain'
          AND uncertain_recorded IS NULL`,
    )
    .get(account_id) as { n: number };
  const pending = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ${TABLE}
        WHERE account_id = ? AND outcome IS NULL
          AND (attempt_at <> 0 OR injected_at IS NOT NULL)`,
    )
    .get(account_id) as { n: number };
  return unmarked.n + pending.n;
}

/** Take over an unresolved submission whose attempt never started its
 * hand-off and has ended (or stopped BOARD_SUBMISSION_ATTEMPT_MS ago): its
 * new token; "busy" if one is in flight or its hand-off started; "capped"
 * if taking it over (it counts again) would pass the account's cap. Atomic
 * with that count: no release/reacquire gap (LIMIT-268-1). */
export function claimBoardSubmissionRetry(
  key: BoardSubmissionKey,
  {
    now = Date.now(),
    attempt_ms = BOARD_SUBMISSION_ATTEMPT_MS,
    unmarked_limit = BOARD_UNMARKED_UNCERTAIN_PER_ACCOUNT,
  } = {},
): { token: string } | { refused: "busy" | "capped" } {
  checkKey(key);
  ensureInit();
  const db = getAcpDatabase();
  return inTransaction(() => {
    const row = db
      .prepare(
        `SELECT attempt_at, injected_at, outcome FROM ${TABLE} WHERE ${KEY_WHERE}`,
      )
      .get(...keyArgs(key)) as
      | {
          attempt_at: number;
          injected_at: number | null;
          outcome: string | null;
        }
      | undefined;
    if (
      !row ||
      row.outcome != null ||
      row.injected_at != null ||
      !(row.attempt_at === 0 || row.attempt_at <= now - attempt_ms)
    ) {
      return { refused: "busy" as const };
    }
    // An ended attempt holds no reservation; taking it over takes one.
    const holds = row.attempt_at !== 0;
    if (!holds && potentialUncertain(db, key.account_id) >= unmarked_limit) {
      return { refused: "capped" as const };
    }
    const token = randomUUID();
    db.prepare(
      `UPDATE ${TABLE} SET attempt_token = ?, attempt_at = ? WHERE ${KEY_WHERE}`,
    ).run(token, now, ...keyArgs(key));
    return { token };
  });
}

/** The current attempt is about to hand its guidance to a live turn (at), or
 * its hand-off answered without injecting it (null). False if `token` is no
 * longer current: then it must not hand anything over. */
export function setBoardSubmissionInjecting(
  key: BoardSubmissionKey,
  token: string,
  at: number | null,
): boolean {
  checkKey(key);
  ensureInit();
  return changed(
    getAcpDatabase()
      .prepare(
        `UPDATE ${TABLE} SET injected_at = ?
          WHERE ${KEY_WHERE} AND attempt_token = ? AND outcome IS NULL`,
      )
      .run(at, ...keyArgs(key), token),
  );
}

/** The current attempt failed: uncertain for good if its hand-off had
 * started (then true: write its marker), else ended (a retry may take
 * over). A stale token changes nothing. */
export function failBoardSubmissionAttempt(
  key: BoardSubmissionKey,
  token: string,
): boolean {
  checkKey(key);
  ensureInit();
  const db = getAcpDatabase();
  db.prepare(
    `UPDATE ${TABLE}
          SET outcome = CASE WHEN injected_at IS NOT NULL THEN ? ELSE NULL END,
              attempt_at = 0
        WHERE ${KEY_WHERE} AND attempt_token = ? AND outcome IS NULL`,
  ).run(BOARD_SUBMISSION_UNCERTAIN, ...keyArgs(key), token);
  const row = db
    .prepare(
      `SELECT outcome FROM ${TABLE} WHERE ${KEY_WHERE} AND attempt_token = ?`,
    )
    .get(...keyArgs(key), token) as { outcome: string | null } | undefined;
  return row?.outcome === BOARD_SUBMISSION_UNCERTAIN;
}

/** The uncertain marker is on the submission's message: its record may now
 * expire like any other. */
export function markBoardSubmissionUncertainRecorded(
  key: BoardSubmissionKey,
  at = Date.now(),
): void {
  checkKey(key);
  ensureInit();
  getAcpDatabase()
    .prepare(
      `UPDATE ${TABLE} SET uncertain_recorded = ?
        WHERE ${KEY_WHERE} AND outcome = ?`,
    )
    .run(at, ...keyArgs(key), BOARD_SUBMISSION_UNCERTAIN);
}

/** The agent took the submission: answer retries with `state` ("steered",
 * "queued", "running"). With a token, only if it is the current attempt;
 * without one (found from a durable trace), whatever attempt is current. */
export function markBoardSubmissionAdmitted(
  key: BoardSubmissionKey,
  state: string,
  token?: string,
): void {
  checkKey(key);
  ensureInit();
  getAcpDatabase()
    .prepare(
      `UPDATE ${TABLE} SET outcome = ?
        WHERE ${KEY_WHERE} AND outcome IS NULL
          AND (? IS NULL OR attempt_token = ?)`,
    )
    .run(state || "steered", ...keyArgs(key), token ?? null, token ?? null);
}

/** Some of an account's uncertain submissions whose marker is not yet on
 * their message, oldest first: what reconciliation retries. */
export function listUnmarkedUncertainBoardSubmissions(
  account_id: string,
  limit = 5,
): BoardSubmissionKey[] {
  ensureInit();
  return getAcpDatabase()
    .prepare(
      `SELECT account_id, project_id, path, thread_id, user_message_id
         FROM ${TABLE}
        WHERE account_id = ? AND outcome = 'uncertain'
          AND uncertain_recorded IS NULL
        ORDER BY admitted_at LIMIT ?`,
    )
    .all(account_id, limit) as unknown as BoardSubmissionKey[];
}
