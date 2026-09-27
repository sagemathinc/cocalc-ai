/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { PoolClient } from "@cocalc/database/pool";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import {
  bindCollaborationAgent,
  matchesAgentIdentity,
  agentThreadResourceId,
  agentReferenceIds,
} from "@cocalc/util/collaboration-agent-identity";
import type {
  CollaborationAgentBinding,
  CollaborationAgentIdentity,
} from "@cocalc/util/collaboration-agent-identity";
import { entryKey, sourceKey, validateResource } from "./collaborators-common";

/** Only persisted owner metadata may use the legacy ID as proof of its original thread. */
export function normalizeOwnedCollaborationAgent(
  resource: CollaborationResource,
  identity: CollaborationAgentIdentity,
): CollaborationResource {
  if (
    resource.kind !== "agent" ||
    resource.agent_id !== identity.agent_id ||
    resource.project_id !== identity.project_id ||
    !resource.resource_id.startsWith("agent-thread:")
  )
    return resource;
  const thread_id = resource.resource_id.slice("agent-thread:".length);
  const normalized = { ...resource, thread_id, chat_path: identity.path };
  return matchesAgentIdentity(normalized, identity) ? normalized : resource;
}

/** Caller holds the owning project's lock and has authenticated the source writer. */
export async function adaptCollaborationAgents(
  db: Pick<PoolClient, "query">,
  source: { project_id: string; chat_path: string },
  input: readonly CollaborationResource[],
) {
  const budget = (
    await db.query(
      `SELECT count(*) AS n,COALESCE(sum(octet_length(conversation_history::text)),0) AS bytes
    FROM agent_identities WHERE project_id=$1 AND path=$2 AND disabled_at IS NULL`,
      [source.project_id, source.chat_path],
    )
  ).rows[0];
  if (Number(budget.n) > 5000 || Number(budget.bytes) > 2 * 1024 * 1024)
    throw Error("collaboration agent registry metadata capacity exceeded");
  const identities: CollaborationAgentIdentity[] = (
    await db.query(
      `SELECT agent_id,project_id,path,thread_id,conversation_history FROM agent_identities
      WHERE project_id=$1 AND path=$2 AND disabled_at IS NULL ORDER BY agent_id LIMIT 5001`,
      [source.project_id, source.chat_path],
    )
  ).rows;
  if (identities.length > 5000)
    throw Error("collaboration agent source capacity exceeded");
  const byThread = new Map<string, CollaborationAgentIdentity[]>();
  let references = 0;
  for (const identity of identities) {
    for (const thread_id of new Set([
      identity.thread_id,
      ...(identity.conversation_history ?? []).map((entry) => entry.thread_id),
    ])) {
      if (++references > 10000)
        throw Error("collaboration agent binding batch capacity exceeded");
      byThread.set(thread_id, [...(byThread.get(thread_id) ?? []), identity]);
    }
  }
  const candidates = input.filter(
    (r) => r.kind === "agent" && !r.resource_id.startsWith("copy:"),
  );
  const keys = [
    ...new Set([
      ...candidates.map(entryKey),
      ...identities.map((identity) =>
        entryKey({
          project_id: source.project_id,
          kind: "agent",
          resource_id: identity.agent_id,
        }),
      ),
      ...identities
        .flatMap((identity) => [
          identity.thread_id,
          ...(identity.conversation_history ?? []).map(
            (entry) => entry.thread_id,
          ),
        ])
        .map((thread_id) =>
          entryKey({
            project_id: source.project_id,
            kind: "agent",
            resource_id: agentThreadResourceId(thread_id),
          }),
        ),
    ]),
  ];
  if (keys.length > 10000)
    throw Error("collaboration agent binding batch capacity exceeded");
  const rows = (
    await db.query(
      `SELECT entry_key,source_id,resource_id,metadata,agent_resource_ids,agent_source_activity,activity_floor
      FROM collaboration_catalog WHERE project_id=$1 AND kind='agent'
      AND (source_id=$2 OR entry_key=ANY($3::text[]) OR agent_resource_ids && $4::text[]) LIMIT 10001`,
      [
        source.project_id,
        sourceKey(source),
        keys,
        [
          ...new Set([
            ...candidates.map((r) => r.resource_id),
            ...[...byThread.keys()].map(agentThreadResourceId),
          ]),
        ],
      ],
    )
  ).rows;
  if (rows.length > 10000)
    throw Error("collaboration agent catalog capacity exceeded");
  const catalog = new Map(rows.map((row) => [row.entry_key, row]));
  const claims = new Map<string, string>();
  for (const row of rows) {
    for (const id of row.agent_resource_ids ?? []) {
      const old = claims.get(id);
      if (old && old !== row.resource_id)
        throw Error("conflicting collaboration agent reference binding");
      claims.set(id, row.resource_id);
    }
  }
  const groups = new Map<string, CollaborationResource[]>();
  const resources: CollaborationResource[] = [];
  for (const item of input) {
    // Host metadata is not proof of an agent identity, including in copied chats.
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
    const identity = matches[0];
    const claimed = claims.get(resource.resource_id);
    if (claimed && identity?.agent_id !== claimed) {
      const previous = catalog.get(
        entryKey({ ...resource, resource_id: claimed }),
      );
      if (
        previous?.metadata &&
        previous.metadata.chat_path !== source.chat_path
      )
        throw Error("agent endpoint moved; stale source metadata");
      // A disabled identity stays unavailable rather than becoming a new unnamed agent.
      if (!identity) continue;
      throw Error("collaboration agent reference belongs to another identity");
    }
    if (!identity) {
      const previous = catalog.get(entryKey(resource));
      if (
        previous?.agent_resource_ids?.length &&
        resource.resource_id === previous.resource_id
      )
        continue;
      resources.push(resource);
      continue;
    }
    const group = groups.get(identity.agent_id) ?? [];
    group.push(resource);
    groups.set(identity.agent_id, group);
  }
  const bindings: CollaborationAgentBinding[] = [];
  for (const identity of identities) {
    const group = groups.get(identity.agent_id);
    if (!group?.length) continue;
    const canonical = catalog.get(
      entryKey({
        project_id: source.project_id,
        kind: "agent",
        resource_id: identity.agent_id,
      }),
    );
    const legacy = group
      .map((r) => catalog.get(entryKey(r)))
      .find((row) => row?.metadata);
    const old = canonical ?? legacy;
    const previous = old?.metadata
      ? {
          resource: normalizeOwnedCollaborationAgent(old.metadata, identity),
          agent_resource_ids: old.agent_resource_ids ?? [],
          agent_source_activity:
            old.resource_id === identity.agent_id
              ? Number(old.agent_source_activity ?? 0)
              : Number(old.metadata.activity),
        }
      : undefined;
    const binding = bindCollaborationAgent(identity, group, previous);
    binding.agent_resource_ids = agentReferenceIds([
      ...new Set<string>([
        ...(canonical?.agent_resource_ids ?? []),
        ...binding.agent_resource_ids,
      ]),
    ]);
    if (!previous && canonical)
      binding.resource.activity = Math.max(
        binding.resource.activity,
        Number(canonical.activity_floor),
      );
    for (const id of binding.agent_resource_ids) {
      const claimed = claims.get(id);
      if (claimed && claimed !== identity.agent_id)
        throw Error(
          "collaboration agent reference belongs to another identity",
        );
      const legacy = catalog.get(
        entryKey({ ...binding.resource, resource_id: id }),
      );
      if (
        legacy &&
        ((legacy.source_id !== sourceKey(source) &&
          legacy.metadata?.agent_id !== identity.agent_id &&
          claimed !== identity.agent_id) ||
          (legacy.metadata?.agent_id &&
            legacy.metadata.agent_id !== identity.agent_id))
      )
        throw Error("conflicting collaboration agent source identity");
    }
    binding.resource = validateResource(binding.resource);
    bindings.push(binding);
    resources.push(binding.resource);
  }
  return { resources, bindings };
}

/** Same transaction/revision as the canonical upsert. Keep compatibility through deletion. */
export async function saveCollaborationAgentBindings(
  db: Pick<PoolClient, "query">,
  bindings: readonly CollaborationAgentBinding[],
  revision: number,
) {
  for (const binding of bindings) {
    const key = entryKey(binding.resource);
    await db.query(
      "UPDATE collaboration_catalog SET agent_resource_ids=$2,agent_source_activity=$3 WHERE entry_key=$1",
      [key, binding.agent_resource_ids, binding.agent_source_activity],
    );
    await db.query(
      `UPDATE collaboration_catalog SET metadata=NULL,deleted_at=now(),revision=$3
      WHERE project_id=$1 AND kind='agent' AND entry_key=ANY($2::text[]) AND deleted_at IS NULL`,
      [
        binding.resource.project_id,
        binding.agent_resource_ids.map((resource_id) =>
          entryKey({ ...binding.resource, resource_id }),
        ),
        revision,
      ],
    );
  }
}

export async function upsertCollaborationAgent(
  db: Pick<PoolClient, "query">,
  binding: CollaborationAgentBinding,
  source_id: string,
  revision: number,
) {
  const r = binding.resource;
  await db.query(
    `INSERT INTO collaboration_catalog(entry_key,source_id,project_id,kind,resource_id,activity_floor,metadata,revision,activity)
    VALUES($1,$2,$3,'agent',$4,$5,$6::jsonb,$7,$8)
    ON CONFLICT(entry_key) DO UPDATE SET source_id=excluded.source_id,metadata=excluded.metadata,
    activity_floor=GREATEST(collaboration_catalog.activity_floor,excluded.activity_floor),
    revision=excluded.revision,activity=excluded.activity,deleted_at=NULL`,
    [
      entryKey(r),
      source_id,
      r.project_id,
      r.resource_id,
      r.activity,
      JSON.stringify(r),
      revision,
      r.updated_at,
    ],
  );
  await saveCollaborationAgentBindings(db, [binding], revision);
}
