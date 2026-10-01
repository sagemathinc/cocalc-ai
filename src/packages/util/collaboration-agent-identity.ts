/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { CollaborationResource } from "./collaborators";

/** Read from the project owner's existing registry, never from chat metadata. */
export interface CollaborationAgentIdentity {
  agent_id: string;
  project_id: string;
  path: string;
  thread_id: string;
  conversation_history?: { thread_id: string }[] | null;
}

export interface CollaborationAgentBinding {
  resource: CollaborationResource;
  agent_resource_ids: string[];
  agent_source_activity: number;
}

export const MAX_AGENT_REFERENCE_IDS = 1001;
export const MAX_AGENT_REFERENCE_BYTES = 64 * 1024;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

export function agentThreadResourceId(thread_id: string): string {
  return `agent-thread:${thread_id}`;
}

export function agentReferenceIds(ids: readonly string[]): string[] {
  if (
    ids.length > MAX_AGENT_REFERENCE_IDS ||
    ids.some(
      (id) =>
        typeof id !== "string" ||
        !id.length ||
        id.length > 256 ||
        id.startsWith("copy:") ||
        /[\u0000-\u001f\u007f]/.test(id),
    )
  )
    throw Error("invalid collaboration agent reference lineage");
  const result = [...new Set(ids)].sort();
  if (
    new TextEncoder().encode(JSON.stringify(result)).length >
    MAX_AGENT_REFERENCE_BYTES
  )
    throw Error("collaboration agent reference lineage capacity exceeded");
  return result;
}

/** Only owner-verified resources may be passed here. Public targets carry no agent_id. */
export function canonicalAgentResource<T extends CollaborationResource>(
  resource: T,
): T {
  return resource.kind === "agent" &&
    resource.agent_id &&
    !resource.resource_id.startsWith("copy:")
    ? { ...resource, resource_id: resource.agent_id }
    : resource;
}

/** A copy's native thread IDs/configuration never identify the original agent. */
export function matchesAgentIdentity(
  resource: CollaborationResource,
  identity: CollaborationAgentIdentity,
): boolean {
  return (
    resource.kind === "agent" &&
    resource.project_id === identity.project_id &&
    resource.chat_path === identity.path &&
    !resource.resource_id.startsWith("copy:") &&
    (resource.resource_id === agentThreadResourceId(resource.thread_id) ||
      resource.resource_id === identity.agent_id) &&
    (resource.thread_id === identity.thread_id ||
      !!identity.conversation_history?.some(
        ({ thread_id }) => thread_id === resource.thread_id,
      ))
  );
}

/** Collapse a registered agent's source threads without creating an identity or name. */
export function bindCollaborationAgent(
  identity: CollaborationAgentIdentity,
  resources: readonly CollaborationResource[],
  previous?: CollaborationAgentBinding,
): CollaborationAgentBinding {
  if (!UUID.test(identity.agent_id) || !UUID.test(identity.project_id))
    throw Error("invalid registered collaboration agent identity");
  const matches = resources.filter((resource) =>
    matchesAgentIdentity(resource, identity),
  );
  const current = matches.find(
    (resource) => resource.thread_id === identity.thread_id,
  );
  const fallback = previous?.resource ?? matches[0];
  if (!fallback) throw Error("registered agent has no collaboration source");
  const resource = current ?? fallback;
  const ids = agentReferenceIds(
    [
      ...new Set([
        ...(previous?.agent_resource_ids ?? []),
        ...matches.map(({ resource_id }) => resource_id),
        agentThreadResourceId(identity.thread_id),
        ...(identity.conversation_history ?? []).map(({ thread_id }) =>
          agentThreadResourceId(thread_id),
        ),
      ]),
    ].filter((id) => id !== identity.agent_id),
  );
  const sameThread = previous?.resource.thread_id === identity.thread_id;
  const sourceActivity = Math.max(
    current?.activity ?? 0,
    sameThread ? previous!.agent_source_activity : 0,
  );
  const activity = previous
    ? previous.resource.activity +
      Math.max(
        0,
        sourceActivity - (sameThread ? previous.agent_source_activity : 0),
      )
    : resource.activity;
  if (!Number.isSafeInteger(activity) || activity < 0)
    throw Error("invalid collaboration agent activity");
  return {
    resource: {
      ...resource,
      resource_id: identity.agent_id,
      agent_id: identity.agent_id,
      chat_path: identity.path,
      thread_id: identity.thread_id,
      created_at: previous?.resource.created_at ?? resource.created_at,
      updated_at: Math.max(
        previous?.resource.updated_at ?? 0,
        resource.updated_at,
      ),
      activity,
      // Historical archived threads must not archive their active successor.
      ...(current || sameThread ? {} : { archived: false }),
    },
    agent_resource_ids: ids,
    agent_source_activity: sourceActivity,
  };
}
