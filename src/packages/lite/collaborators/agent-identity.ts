/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { DatabaseSync } from "node:sqlite";
import { collaborationTargetKey } from "@cocalc/util/collaborators";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import {
  bindCollaborationAgent,
  matchesAgentIdentity,
} from "@cocalc/util/collaboration-agent-identity";
import type {
  CollaborationAgentIdentity,
  CollaborationAgentBinding,
} from "@cocalc/util/collaboration-agent-identity";
import type { LocalResource } from "./legacy-attention";

export function initializeAgentReferences(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS collaboration_agent_references (
    legacy_key TEXT PRIMARY KEY, resource_key TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS collaboration_agent_reference_target ON collaboration_agent_references(resource_key);
    CREATE TABLE IF NOT EXISTS collaboration_agent_activity (
      resource_key TEXT PRIMARY KEY, source_activity INTEGER NOT NULL,
      collected_fallback INTEGER NOT NULL DEFAULT 0);`);
  if (
    !db
      .prepare("PRAGMA table_info(collaboration_agent_activity)")
      .all()
      .some((r) => r.name === "collected_fallback")
  )
    db.exec(
      "ALTER TABLE collaboration_agent_activity ADD COLUMN collected_fallback INTEGER NOT NULL DEFAULT 0",
    );
}

export function resolveAgentReference(db: DatabaseSync, key: string): string {
  return (
    (db
      .prepare(
        "SELECT resource_key FROM collaboration_agent_references WHERE legacy_key=?",
      )
      .get(key)?.resource_key as string) ?? key
  );
}

/** Registry access is service-local, synchronous and read-only; never infer identities from names/config. */
export function adaptLiteAgents(
  db: DatabaseSync,
  input: readonly LocalResource[],
  identities: readonly CollaborationAgentIdentity[],
) {
  if (identities.length > 5000)
    throw Error("collaboration agent registry capacity exceeded");
  const byThread = new Map<string, CollaborationAgentIdentity[]>();
  let references = 0;
  let bytes = 0;
  for (const identity of identities) {
    bytes += Buffer.byteLength(JSON.stringify(identity));
    if (bytes > 2 * 1024 * 1024)
      throw Error("collaboration agent registry capacity exceeded");
    for (const thread_id of new Set([
      identity.thread_id,
      ...(identity.conversation_history ?? []).map((r) => r.thread_id),
    ])) {
      if (++references > 10000)
        throw Error("collaboration agent binding batch capacity exceeded");
      byThread.set(thread_id, [...(byThread.get(thread_id) ?? []), identity]);
    }
  }
  const resources: LocalResource[] = [];
  const groups = new Map<string, LocalResource[]>();
  for (const item of input) {
    const { agent_id: _untrusted, ...resource } = item;
    if (resource.kind !== "agent") {
      resources.push(resource);
      continue;
    }
    const matches = (byThread.get(resource.thread_id) ?? []).filter(
      (identity) => matchesAgentIdentity(resource, identity),
    );
    if (matches.length > 1)
      throw Error("ambiguous registered collaboration agent thread");
    const key = collaborationTargetKey(resource);
    const claimed = resolveAgentReference(db, key);
    const identity = matches[0];
    if (!identity) {
      if (
        claimed !== key ||
        db
          .prepare(
            "SELECT 1 FROM collaboration_agent_activity WHERE resource_key=?",
          )
          .get(key)
      )
        continue;
      resources.push(resource);
      continue;
    }
    const canonical = collaborationTargetKey({
      ...resource,
      resource_id: identity.agent_id,
    });
    if (claimed !== key && claimed !== canonical)
      throw Error("collaboration agent reference belongs to another identity");
    const group = groups.get(identity.agent_id) ?? [];
    group.push(resource);
    groups.set(identity.agent_id, group);
  }
  const bindings: CollaborationAgentBinding[] = [];
  for (const identity of identities) {
    const group = groups.get(identity.agent_id);
    if (!group?.length) continue;
    const key = collaborationTargetKey({
      project_id: identity.project_id,
      kind: "agent",
      resource_id: identity.agent_id,
    });
    const lookup = db.prepare(
      "SELECT metadata,chat_path FROM collaboration_resources WHERE resource_key=?",
    );
    const canonical = lookup.get(key);
    const row =
      canonical ??
      group.map((r) => lookup.get(collaborationTargetKey(r))).find(Boolean);
    const old = row
      ? (JSON.parse(row.metadata as string) as CollaborationResource)
      : undefined;
    const lineage = db
      .prepare(
        "SELECT legacy_key FROM collaboration_agent_references WHERE resource_key=? ORDER BY legacy_key",
      )
      .all(key)
      .map((row) => JSON.parse(row.legacy_key as string)[2] as string);
    const previous = old
      ? {
          resource: old,
          agent_resource_ids: lineage,
          agent_source_activity: canonical
            ? Number(
                db
                  .prepare(
                    "SELECT source_activity FROM collaboration_agent_activity WHERE resource_key=?",
                  )
                  .get(key)?.source_activity ?? old.activity,
              )
            : old.activity,
        }
      : undefined;
    const binding = bindCollaborationAgent(identity, group, previous);
    for (const id of binding.agent_resource_ids) {
      const legacyKey = collaborationTargetKey({
        ...binding.resource,
        resource_id: id,
      });
      const claim = resolveAgentReference(db, legacyKey);
      const legacy = lookup.get(legacyKey);
      if (
        (claim !== legacyKey && claim !== key) ||
        (legacy && legacy.chat_path !== identity.path && claim !== key)
      )
        throw Error("conflicting collaboration agent source identity");
    }
    resources.push(binding.resource);
    bindings.push(binding);
  }
  return { resources, bindings };
}

/** Called after canonical resource insertion, in the same SQLite transaction. */
export function saveLiteAgentBindings(
  db: DatabaseSync,
  bindings: readonly CollaborationAgentBinding[],
) {
  for (const binding of bindings) {
    const key = collaborationTargetKey(binding.resource);
    const oldKeys = binding.agent_resource_ids.map((resource_id) =>
      collaborationTargetKey({ ...binding.resource, resource_id }),
    );
    for (const old of oldKeys) {
      const claim = resolveAgentReference(db, old);
      if (claim !== old && claim !== key)
        throw Error("conflicting collaboration agent reference");
      db.prepare(
        "INSERT OR IGNORE INTO collaboration_agent_references VALUES(?,?)",
      ).run(old, key);
      db.prepare(
        "DELETE FROM collaboration_search WHERE rowid IN (SELECT rowid FROM collaboration_resources WHERE resource_key=?)",
      ).run(old);
      db.prepare(
        "UPDATE collaboration_resources SET deleted=1 WHERE resource_key=?",
      ).run(old);
    }
    db.prepare(
      "INSERT INTO collaboration_agent_activity(resource_key,source_activity) VALUES(?,?) ON CONFLICT(resource_key) DO UPDATE SET source_activity=excluded.source_activity",
    ).run(key, binding.agent_source_activity);
    const lookup =
      db.prepare(`SELECT p.*,c.following_explicit,c.muted_explicit,c.legacy_migrated
      FROM collaboration_personal p LEFT JOIN collaboration_attention_choices c USING(resource_key) WHERE p.resource_key=?`);
    const current = lookup.get(key);
    const previous = oldKeys
      .map((old) => lookup.get(old))
      .filter((row) => row != null);
    if (!previous.length) continue;
    if (previous.some((row) => row.collected))
      db.prepare(
        "UPDATE collaboration_agent_activity SET collected_fallback=1 WHERE resource_key=?",
      ).run(key);
    const rows = [...(current ? [current] : []), ...previous];
    for (const old of oldKeys) {
      db.prepare("DELETE FROM collaboration_personal WHERE resource_key=?").run(
        old,
      );
      db.prepare(
        "DELETE FROM collaboration_attention_choices WHERE resource_key=?",
      ).run(old);
    }
    const flag = (field: string) => +rows.some((row) => row[field]);
    const choice = (field: string) =>
      rows.find((row) => row[`${field}_explicit`])?.[field] ?? flag(field);
    db.prepare(
      `INSERT INTO collaboration_personal(resource_key,kind,alias,collected,following,muted,read_through)
      VALUES(?,'agent',?,?,?,?,?) ON CONFLICT(resource_key) DO UPDATE SET alias=excluded.alias,collected=excluded.collected,
      following=excluded.following,muted=excluded.muted,read_through=excluded.read_through`,
    ).run(
      key,
      current ? current.alias : (rows.find((row) => row.alias)?.alias ?? null),
      flag("collected"),
      choice("following"),
      choice("muted"),
      Math.max(...rows.map((row) => Number(row.read_through))),
    );
    db.prepare(
      `INSERT INTO collaboration_attention_choices VALUES(?,?,?,?) ON CONFLICT(resource_key) DO UPDATE SET
      following_explicit=excluded.following_explicit,muted_explicit=excluded.muted_explicit,legacy_migrated=excluded.legacy_migrated`,
    ).run(
      key,
      flag("following_explicit"),
      flag("muted_explicit"),
      flag("legacy_migrated"),
    );
  }
  const size = db
    .prepare(
      "SELECT count(*) AS n,coalesce(sum(length(legacy_key)+length(resource_key)),0) AS bytes FROM collaboration_agent_references",
    )
    .get();
  if (Number(size?.n) > 100_000 || Number(size?.bytes) > 32 * 1024 * 1024)
    throw Error("collaboration agent reference capacity exceeded");
}
