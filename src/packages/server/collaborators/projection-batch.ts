/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type {
  CollaborationProjectionRequest,
  CollaborationProjectionPage,
  CollaborationSharedProjectionRequest,
  CollaborationSharedProjectionPage,
} from "@cocalc/conat/inter-bay/collaborators";

/** Per-pass coalescing only: no cross-pass cache of authorization or metadata. */
export function createSharedProjectionFetcher(
  jobs: readonly CollaborationProjectionRequest[],
  fetch: (
    request: CollaborationSharedProjectionRequest,
  ) => Promise<CollaborationSharedProjectionPage>,
): (
  job: CollaborationProjectionRequest,
) => Promise<CollaborationProjectionPage> {
  if (jobs.length > 16) throw Error("projection batch limit exceeded");
  const key = (j: CollaborationProjectionRequest) =>
    JSON.stringify([
      j.project_id,
      j.generation,
      j.revision,
      j.after_key,
      j.relation_after ?? null,
    ]);
  const groups = new Map<
    string,
    {
      request: CollaborationSharedProjectionRequest;
      pending?: Promise<CollaborationSharedProjectionPage>;
    }
  >();
  for (const job of jobs) {
    const k = key(job);
    let group = groups.get(k);
    if (!group) {
      group = {
        request: {
          project_id: job.project_id,
          generation: job.generation,
          revision: job.revision,
          after_key: job.after_key,
          ...(job.relation_after ? { relation_after: job.relation_after } : {}),
          account_ids: [],
        },
      };
      groups.set(k, group);
    }
    if (!group.request.account_ids.includes(job.account_id.toLowerCase()))
      group.request.account_ids.push(job.account_id.toLowerCase());
  }
  return async (job) => {
    const group = groups.get(key(job));
    const account_id = job.account_id.toLowerCase();
    if (!group || !group.request.account_ids.includes(account_id))
      throw Error("job outside projection batch");
    // Store even a rejected promise: all jobs share the same unknown outcome,
    // rather than retrying the owner once per recipient in this pass.
    group.pending ??= Promise.resolve().then(() => fetch(group.request));
    const page = await group.pending;
    const recipients = page.recipients.filter(
      (r) => r.account_id === account_id,
    );
    if (recipients.length !== 1)
      throw Error("missing or duplicate projection recipient");
    const recipient = recipients[0];
    if (!recipient.allowed) return { allowed: false };
    if (!page.catalog) throw Error("missing authorized shared catalog");
    // Consumers retain independent page objects and recipient floors.
    const catalog = structuredClone(page.catalog);
    return {
      allowed: true,
      ...catalog,
      attention_generation: recipient.attention_generation,
      items: catalog.items.map((item) => ({
        ...item,
        ...(item.resource
          ? { initial_activity: recipient.floors[item.resource.resource_id] }
          : {}),
      })),
    };
  };
}
