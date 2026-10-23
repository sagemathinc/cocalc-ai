import { getAcpDatabase } from "./acp-database";

// Which version of the session instructions (the system prompt CoCalc gives
// a Claude Code session, with the CoCalc skill) each saved session last
// received. A resumed Claude Code session keeps the system prompt it started
// with, so newer instructions go with its next turn (see harness-client).

function database() {
  const db = getAcpDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS acp_session_instructions (
    session_id TEXT PRIMARY KEY, version TEXT NOT NULL,
    updated_at INTEGER NOT NULL)`);
  return db;
}

export function getSessionInstructionsVersion(
  session_id: string,
): string | undefined {
  const row = database()
    .prepare("SELECT version FROM acp_session_instructions WHERE session_id=?")
    .get(session_id);
  return typeof row?.version === "string" ? row.version : undefined;
}

export function setSessionInstructionsVersion(
  session_id: string,
  version: string,
): void {
  database()
    .prepare(
      `INSERT INTO acp_session_instructions(session_id,version,updated_at)
       VALUES(?,?,?) ON CONFLICT(session_id)
       DO UPDATE SET version=excluded.version, updated_at=excluded.updated_at`,
    )
    .run(session_id, version, Date.now());
  // Sessions unused for half a year: their next turn just sends the
  // instructions again.
  database()
    .prepare("DELETE FROM acp_session_instructions WHERE updated_at<?")
    .run(Date.now() - 180 * 24 * 60 * 60 * 1000);
}
