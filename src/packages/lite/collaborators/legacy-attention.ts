/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { DatabaseSync } from "node:sqlite";
import type { CollaborationResource } from "@cocalc/util/collaborators";

export interface LocalLegacyAttention {
  following: boolean;
  muted: boolean;
}
export type LocalResource = CollaborationResource & {
  lite_legacy_attention?: LocalLegacyAttention;
};

/** Only the trusted bounded source reader constructs this local-account summary. */
export function attachLegacyAttention<
  T extends { resources: CollaborationResource[] },
>(
  extraction: T,
  rows: readonly unknown[],
  account_id: string,
): T & { resources: LocalResource[] } {
  const configs = new Map<string, Record<string, unknown>>();
  const copied = rows.some(
    (row: any) => row?.event === "collaborators-identity",
  );
  for (const row of rows as Record<string, unknown>[])
    if (
      row?.event === "chat-thread-config" &&
      typeof row.thread_id === "string"
    )
      configs.set(row.thread_id, row);
  const includes = (value: unknown): boolean => {
    if (value === undefined) return false;
    if (!Array.isArray(value) || value.length > 100_000)
      throw Error("legacy attention source exceeds capacity");
    return value.some(
      (id) =>
        typeof id === "string" && id.toLowerCase() === account_id.toLowerCase(),
    );
  };
  return {
    ...extraction,
    resources: extraction.resources.map((resource) => {
      if (resource.kind === "artifact") return resource;
      const config = copied ? undefined : configs.get(resource.thread_id);
      return {
        ...resource,
        lite_legacy_attention: {
          following: includes(config?.notification_followers),
          muted: includes(config?.notification_muted),
        },
      };
    }),
  };
}

export function initializeLegacyAttention(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS collaboration_attention_choices (
    resource_key TEXT PRIMARY KEY REFERENCES collaboration_resources(resource_key),
    following_explicit INTEGER NOT NULL DEFAULT 0, muted_explicit INTEGER NOT NULL DEFAULT 0,
    legacy_migrated INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO collaboration_attention_choices(resource_key,following_explicit,muted_explicit)
    SELECT resource_key,1,1 FROM collaboration_personal;`);
}

export function recordAttentionChoice(
  db: DatabaseSync,
  key: string,
  patch: { following?: boolean; muted?: boolean },
): void {
  db.prepare(
    `INSERT INTO collaboration_attention_choices(resource_key,following_explicit,muted_explicit) VALUES(?,?,?)
    ON CONFLICT(resource_key) DO UPDATE SET following_explicit=max(following_explicit,excluded.following_explicit),
    muted_explicit=max(muted_explicit,excluded.muted_explicit)`,
  ).run(key, +(patch.following !== undefined), +(patch.muted !== undefined));
}

/** Only for a newly observed conversation, never an existing or retained identity. */
export function initializeReadBoundary(
  db: DatabaseSync,
  key: string,
  activity: number,
): void {
  recordAttentionChoice(db, key, {});
  db.prepare(
    "INSERT INTO collaboration_personal(resource_key,kind,read_through) VALUES(?,'conversation',?) ON CONFLICT(resource_key) DO NOTHING",
  ).run(key, activity);
}

/** Called with metadata ingestion under the source epoch/sequence transaction. */
export function migrateLegacyAttention(
  db: DatabaseSync,
  key: string,
  kind: string,
  legacy?: LocalLegacyAttention,
): void {
  if (!legacy) return;
  recordAttentionChoice(db, key, {});
  const choice = db
    .prepare(
      "SELECT * FROM collaboration_attention_choices WHERE resource_key=?",
    )
    .get(key)!;
  if (choice.legacy_migrated) return;
  db.prepare(
    `INSERT INTO collaboration_personal(resource_key,kind,following,muted) VALUES(?,?,?,?)
    ON CONFLICT(resource_key) DO UPDATE SET following=CASE WHEN ? THEN following ELSE excluded.following END,
    muted=CASE WHEN ? THEN muted ELSE excluded.muted END`,
  ).run(
    key,
    kind,
    +legacy.following,
    +legacy.muted,
    choice.following_explicit,
    choice.muted_explicit,
  );
  db.prepare(
    "UPDATE collaboration_attention_choices SET legacy_migrated=1 WHERE resource_key=?",
  ).run(key);
}
