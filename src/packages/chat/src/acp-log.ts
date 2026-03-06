import { join } from "path";

/**
 * Canonical identifiers for persisting and streaming ACP/Codex activity logs.
 *
 * These identifiers must be derived deterministically from:
 *   - `project_id` + `path` (chat file)           → AKV store name
 *   - `thread_id`                                 → per-thread namespace
 *   - `message_id` (assistant reply row id)       → per-turn namespace
 *
 * Both frontend and backend should use this helper so we never have to
 * "invent" subjects/keys in multiple places (which is fragile and can lead to
 * races and mis-associated logs).
 */

export type AcpLogRefs = Readonly<{
  store: string;
  thread: string;
  turn: string;
  key: string;
  subject: string;
}>;

export function deriveAcpLogStoreName(
  _project_id: string,
  path: string,
): string {
  // Historically we used sha1(project_id, path) via client_db.sha1, which for
  // string inputs is equivalent to sha1(project_id + path).
  return join("acp-log", path);
}

export function deriveAcpLogRefs(opts: {
  project_id: string;
  path: string;
  thread_id: string;
  message_id: string;
}): AcpLogRefs {
  const { project_id, path, thread_id, message_id } = opts;
  const store = deriveAcpLogStoreName(project_id, path);
  const thread = thread_id;
  const turn = message_id;
  const key = `${thread}:${turn}`;
  const subject = `project.${project_id}.acp-log.${thread}.${turn}`;
  return { store, thread, turn, key, subject };
}
