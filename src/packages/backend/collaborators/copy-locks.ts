/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { CollaborationSource } from "./journal";
const active = new Set<string>();

/** Short process-local exclusion, not a lease. Durable intent remains in SQLite. */
export async function withCollaborationCopyLock<T>(
  sources: CollaborationSource[],
  run: () => Promise<T>,
): Promise<T> {
  const keys = [
    ...new Set(
      sources.map((source) =>
        JSON.stringify([source.project_id, source.chat_path]),
      ),
    ),
  ];
  if (keys.some((key) => active.has(key)))
    throw Error(
      "collaboration copy reconciliation busy; retry filesystem operation",
    );
  for (const key of keys) active.add(key);
  try {
    return await run();
  } finally {
    for (const key of keys) active.delete(key);
  }
}
