// Board submissions admitted as agent guidance or turns. Two jobs:
//
// - The hub's bound on how many new Sagebrush board submissions one account
//   sends one thread an hour, whatever page, tab or channel they come from
//   (daybreak2, LIMIT-A4B-1).
// - Each submission's identity (its user message) and outcome, so a retry
//   after a lost acknowledgement never steers the same guidance into a
//   turn twice (astra2, CORR-D1-1): an admitted one answers with its
//   recorded state; an unknown one is resolved before it is sent again.
//
// Rows older than the window are deleted at each admission, so the table
// holds at most the last hour's admissions.

import { getAcpDatabase } from "./acp-database";

const TABLE = "acp_board_submissions";

/** New board submissions one account may send one thread in WINDOW_MS. */
export const BOARD_SUBMISSIONS_PER_THREAD_PER_HOUR = 30;
export const BOARD_SUBMISSION_WINDOW_MS = 60 * 60_000;
/** An attempt with no recorded outcome for this long is taken to have
 * ended (the hub restarted, or it failed): a retry may take over. */
export const BOARD_SUBMISSION_ATTEMPT_MS = 2 * 60_000;

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
      attempt_at INTEGER NOT NULL,
      outcome TEXT,
      PRIMARY KEY (project_id, path, user_message_id)
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_thread_idx ON ${TABLE}(account_id, project_id, path, thread_id, admitted_at)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_admitted_idx ON ${TABLE}(admitted_at)`,
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
  /** A new submission, admitted under the bound: send it. */
  | { ok: true; kind: "new" }
  /** Sent before, and the agent took it: answer with this state. */
  | { ok: true; kind: "admitted"; state: string }
  /** Sent before, outcome unknown: resolve before sending again. */
  | { ok: true; kind: "unknown"; attempt_at: number }
  | { ok: false; retry_after_ms: number };

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

/** Admit one board submission message, atomically. A submission seen before
 * takes no new slot; a new one is admitted only while the account has sent
 * this thread fewer than the limit in the window. */
export function admitBoardSubmission(
  key: BoardSubmissionKey,
  {
    now = Date.now(),
    limit = BOARD_SUBMISSIONS_PER_THREAD_PER_HOUR,
    window_ms = BOARD_SUBMISSION_WINDOW_MS,
  }: { now?: number; limit?: number; window_ms?: number } = {},
): BoardSubmissionAdmission {
  checkKey(key);
  ensureInit();
  const db = getAcpDatabase();
  const { account_id, project_id, path, thread_id, user_message_id } = key;
  return inTransaction((): BoardSubmissionAdmission => {
    db.prepare(`DELETE FROM ${TABLE} WHERE admitted_at <= ?`).run(
      now - window_ms,
    );
    const existing = db
      .prepare(
        `SELECT account_id, outcome, attempt_at FROM ${TABLE}
          WHERE project_id = ? AND path = ? AND user_message_id = ?`,
      )
      .get(project_id, path, user_message_id) as
      | { account_id: string; outcome: string | null; attempt_at: number }
      | undefined;
    if (existing) {
      // Only its own sender's retry is the same submission.
      if (existing.account_id !== account_id) {
        throw new Error("this board submission was sent by another account");
      }
      return existing.outcome
        ? { ok: true, kind: "admitted", state: existing.outcome }
        : { ok: true, kind: "unknown", attempt_at: existing.attempt_at };
    }
    const recent = db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(admitted_at) AS oldest FROM ${TABLE}
          WHERE account_id = ? AND project_id = ? AND path = ? AND thread_id = ?`,
      )
      .get(account_id, project_id, path, thread_id) as {
      n: number;
      oldest: number | null;
    };
    if (recent.n >= limit) {
      return {
        ok: false,
        retry_after_ms: Math.max(0, (recent.oldest ?? now) + window_ms - now),
      };
    }
    db.prepare(
      `INSERT INTO ${TABLE}
        (project_id, path, user_message_id, account_id, thread_id, admitted_at, attempt_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(project_id, path, user_message_id, account_id, thread_id, now, now);
    return { ok: true, kind: "new" };
  });
}

/** Record that the agent took the submission, with the state to answer
 * retries with ("steered", "queued", "running"). */
export function markBoardSubmissionAdmitted(
  key: BoardSubmissionKey,
  state: string,
): void {
  checkKey(key);
  ensureInit();
  getAcpDatabase()
    .prepare(
      `UPDATE ${TABLE} SET outcome = ?
        WHERE project_id = ? AND path = ? AND user_message_id = ? AND account_id = ?`,
    )
    .run(
      state || "steered",
      key.project_id,
      key.path,
      key.user_message_id,
      key.account_id,
    );
}

/** An attempt that failed with no outcome: a retry may take over at once
 * (after its evidence check). */
export function endBoardSubmissionAttempt(key: BoardSubmissionKey): void {
  checkKey(key);
  ensureInit();
  getAcpDatabase()
    .prepare(
      `UPDATE ${TABLE} SET attempt_at = 0
        WHERE project_id = ? AND path = ? AND user_message_id = ? AND account_id = ?
          AND outcome IS NULL`,
    )
    .run(key.project_id, key.path, key.user_message_id, key.account_id);
}

/** Take over the attempt of a submission with an unknown outcome, if the
 * last attempt has ended (or is older than BOARD_SUBMISSION_ATTEMPT_MS);
 * false while one may still be in flight. */
export function claimBoardSubmissionRetry(
  key: BoardSubmissionKey,
  { now = Date.now(), attempt_ms = BOARD_SUBMISSION_ATTEMPT_MS } = {},
): boolean {
  checkKey(key);
  ensureInit();
  const result = getAcpDatabase()
    .prepare(
      `UPDATE ${TABLE} SET attempt_at = ?
        WHERE project_id = ? AND path = ? AND user_message_id = ? AND account_id = ?
          AND outcome IS NULL AND (attempt_at = 0 OR attempt_at <= ?)`,
    )
    .run(
      now,
      key.project_id,
      key.path,
      key.user_message_id,
      key.account_id,
      now - attempt_ms,
    ) as { changes?: number | bigint };
  return Number(result?.changes ?? 0) > 0;
}
