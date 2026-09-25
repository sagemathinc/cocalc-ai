import { randomUUID } from "node:crypto";
import { getAcpDatabase } from "./acp-database";

export type ThreadKey = { project_id: string; path: string; thread_id: string };

function database() {
  const db = getAcpDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS acp_thread_successors (
    project_id TEXT NOT NULL, path TEXT NOT NULL, thread_id TEXT NOT NULL,
    successor TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0,
    owner_pid INTEGER, owner_token TEXT,
    PRIMARY KEY(project_id,path,thread_id))`);
  return db;
}

// Triggers enforce the fence across every worker, including retry and recovery.
export function installThreadSuccessorFence(
  table: "acp_jobs" | "acp_turns" | "acp_steers",
) {
  const db = database();
  const states =
    table === "acp_steers" ? "'pending','processing'" : "'queued','running'";
  for (const event of ["INSERT", "UPDATE"] as const) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_successor_${event}
      BEFORE ${event} ON ${table}
      WHEN NEW.state IN (${states}) AND EXISTS (
        SELECT 1 FROM acp_thread_successors s WHERE s.project_id=NEW.project_id
          AND s.path=NEW.path AND s.thread_id=NEW.thread_id)
      BEGIN SELECT RAISE(ABORT, 'This conversation is closed; open the agent current conversation'); END`);
  }
}

export function reserveThreadSuccessor(key: ThreadKey): string {
  const db = database();
  const args = [key.project_id, key.path, key.thread_id];
  db.exec("BEGIN IMMEDIATE");
  try {
    const previous = db
      .prepare(
        `SELECT successor FROM acp_thread_successors
      WHERE project_id=? AND path=? AND thread_id=?`,
      )
      .get(...args);
    if (previous) {
      db.exec("COMMIT");
      return previous.successor;
    }
    for (const table of ["acp_jobs", "acp_turns", "acp_steers"] as const) {
      if (
        !db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
          )
          .get(table)
      )
        continue;
      installThreadSuccessorFence(table);
      const states =
        table === "acp_steers"
          ? "'pending','processing'"
          : "'queued','running'";
      if (
        db
          .prepare(
            `SELECT 1 FROM ${table} WHERE project_id=? AND path=? AND thread_id=? AND state IN (${states}) LIMIT 1`,
          )
          .get(...args)
      ) {
        throw new Error(
          "Finish or cancel this agent's running and queued work before starting fresh.",
        );
      }
    }
    const successor = randomUUID();
    db.prepare(
      "INSERT INTO acp_thread_successors(project_id,path,thread_id,successor) VALUES (?,?,?,?)",
    ).run(...args, successor);
    db.exec("COMMIT");
    return successor;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// A live writer must never be stolen merely because a save is slow. A crashed
// process can be reclaimed; PID reuse conservatively requires operator recovery.
export function claimThreadPreparation(key: ThreadKey): string | undefined {
  const db = database();
  const args = [key.project_id, key.path, key.thread_id];
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db
      .prepare(
        "SELECT * FROM acp_thread_successors WHERE project_id=? AND path=? AND thread_id=?",
      )
      .get(...args);
    if (!row) throw new Error("Missing conversation reservation");
    if (row.ready) {
      db.exec("COMMIT");
      return;
    }
    if (row.owner_pid) {
      let alive = true;
      try {
        process.kill(row.owner_pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
      if (alive)
        throw new Error(
          "A fresh conversation is already being prepared. Wait and retry.",
        );
    }
    const token = randomUUID();
    db.prepare(
      "UPDATE acp_thread_successors SET owner_pid=?,owner_token=? WHERE project_id=? AND path=? AND thread_id=?",
    ).run(process.pid, token, ...args);
    db.exec("COMMIT");
    return token;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function finishThreadPreparation(
  key: ThreadKey,
  token: string,
  ready: boolean,
) {
  database()
    .prepare(
      `UPDATE acp_thread_successors SET ready=?,owner_pid=NULL,owner_token=NULL
    WHERE project_id=? AND path=? AND thread_id=? AND owner_token=?`,
    )
    .run(ready ? 1 : 0, key.project_id, key.path, key.thread_id, token);
}
