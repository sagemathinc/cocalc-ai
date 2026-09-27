/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { uuidsha1 } from "@cocalc/util/misc";
import type { HumanRoomSyncDB } from "./collaborators-room";
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function collaborationIdentityNamespace(
  rows: readonly unknown[],
): string | undefined {
  if (rows.some((row) => !row || typeof row !== "object" || Array.isArray(row)))
    throw Error("invalid copied chat row");
  const markers = (rows as readonly Record<string, any>[]).filter(
    (row) => row.event === "collaborators-identity",
  );
  if (!markers.length) return;
  if (
    markers.length !== 1 ||
    !UUID.test(markers[0].identity_namespace) ||
    markers[0].schema_version !== 1
  )
    throw Error("invalid collaboration copy namespace");
  return markers[0].identity_namespace;
}

/** Order-independent source witness; only hashes leave the project data plane. */
export function collaborationCopyFingerprint(rows: readonly unknown[]): string {
  if (rows.length > 100_000) throw Error("copy source row capacity exceeded");
  function canonical(value: any): any {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key])]),
      );
    return value;
  }
  const input = JSON.stringify(
    rows.map((row) => JSON.stringify(canonical(row))).sort(),
  );
  if (input.length > 32 * 1024 * 1024)
    throw Error("copy source byte capacity exceeded");
  return uuidsha1(input);
}

/** Changes one marker only, never message IDs, artifacts, authors, config or text. */
export async function initializeCollaborationCopy(
  db: HumanRoomSyncDB,
  opts: { operation_id: string; fingerprint: string },
) {
  if (!UUID.test(opts.operation_id) || !UUID.test(opts.fingerprint))
    throw Error("invalid collaboration copy intent");
  const rows = db.get();
  const namespace = collaborationIdentityNamespace(rows);
  if (namespace !== opts.operation_id) {
    if (collaborationCopyFingerprint(rows) !== opts.fingerprint)
      throw Error("copied source changed; reconciliation required");
    const existing = rows.find((row) => row.event === "collaborators-identity");
    db.set({
      ...(existing ?? {
        event: "collaborators-identity",
        sender_id: "__collaborators__",
        date: "1970-01-01T00:00:00.000Z",
        thread_id: "__collaborators_identity__",
      }),
      identity_namespace: opts.operation_id,
      schema_version: 1,
    });
  }
  // A lost save ACK reuses the same marker and retries the normal service save.
  db.commit();
  await db.save();
  await db.save_to_disk();
}
