/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  COLLABORATION_NOTIFICATION_BATCH_LIMIT,
  collaborationAccountId,
  validateCollaborationMessageEvent,
  validateCollaborationNotificationAttention,
} from "@cocalc/util/collaboration-attention";
import type {
  CollaborationNotificationJob,
  CollaborationNotificationPage,
  CollaborationNotificationOutboxStore,
} from "@cocalc/util/collaboration-attention";
export type {
  CollaborationNotificationJob,
  CollaborationNotificationPage,
  CollaborationNotificationOutboxStore,
} from "@cocalc/util/collaboration-attention";
import { receiveCollaborationMessageNotification } from "./collaboration";
import type { CollaborationNotificationHooks } from "./collaboration";

export const COLLABORATION_NOTIFICATION_JOB_LIMIT = 8;
export const COLLABORATION_NOTIFICATION_PAGE_BYTES = 256 * 1024;
export const COLLABORATION_NOTIFICATION_AUTHORITY_LEASE_MS = 60_000;

/** Concrete DB adapters belong with owner/account projections, not a second
 * notification queue. The source journal's immutable notification_events must
 * commit to the owner event log IN the existing ingest transaction before ACK.
 * That log's resumable per-account cursor is the durable input to this worker;
 * the existing notification graph/outbox remains the only notification output.
 */
export interface CollaborationNotificationPassResult {
  claimed: number;
  acknowledged: number;
  created: number;
  duplicate: number;
  suppressed: number;
  revoked: number;
  failed: number;
}

function boundedString(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 200 ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw Error(`invalid collaboration notification ${label}`);
  }
}

function validatePage(
  job: CollaborationNotificationJob,
  page: CollaborationNotificationPage,
): void {
  if (
    !page ||
    typeof page.allowed !== "boolean" ||
    Buffer.byteLength(JSON.stringify(page)) >
      COLLABORATION_NOTIFICATION_PAGE_BYTES
  ) {
    throw Error("invalid collaboration notification page");
  }
  if (!page.allowed) return;
  boundedString(page.generation, "generation");
  boundedString(page.access_generation, "access generation");
  boundedString(page.cursor, "cursor");
  if (
    typeof page.complete !== "boolean" ||
    typeof page.reset !== "boolean" ||
    !Array.isArray(page.entries) ||
    page.entries.length > COLLABORATION_NOTIFICATION_BATCH_LIMIT
  ) {
    throw Error("collaboration notification page exceeds capacity");
  }
  if (page.reset) {
    if (page.entries.length || !page.complete)
      throw Error(
        "notification history reset must contain only a complete boundary",
      );
    return;
  }
  if (job.generation !== page.generation || job.cursor == null)
    throw Error("notification page requires initial history handoff");
  if ((!page.complete || page.entries.length) && page.cursor === job.cursor)
    throw Error("notification page cursor did not advance");
  const ids = new Set<string>();
  for (const entry of page.entries) {
    const event = validateCollaborationMessageEvent(entry.event);
    if (
      entry.attention !== undefined &&
      validateCollaborationNotificationAttention(entry.attention).generation !==
        page.generation
    )
      throw Error("notification attention membership mismatch");
    const key = JSON.stringify([
      event.room_id,
      event.thread_id,
      event.message_id,
    ]);
    if (
      event.project_id !== job.project_id ||
      ids.has(key) ||
      entry.authority?.access_generation !== page.access_generation
    )
      throw Error("notification page event/authority mismatch");
    ids.add(key);
  }
}

/** Invoke from the existing collaborators maintenance lifecycle. No timer, public
 * endpoint, best-effort send, or in-memory delivery queue is created here.
 * A whole page is retried after a crash/partial commit; stable receiver identities
 * make that replay harmless. Fresh owner authorization has a bounded lease, while
 * lockAttention rechecks account-home membership under the delivery transaction.
 */
export async function runCollaborationNotificationOutboxPass({
  store,
  lockAttention,
  now = Date.now,
}: {
  store: CollaborationNotificationOutboxStore;
  lockAttention: CollaborationNotificationHooks["lockAttention"];
  now?: () => number;
}): Promise<CollaborationNotificationPassResult> {
  const jobs = await store.claim(COLLABORATION_NOTIFICATION_JOB_LIMIT);
  if (
    !Array.isArray(jobs) ||
    jobs.length > COLLABORATION_NOTIFICATION_JOB_LIMIT
  )
    throw Error("notification job claim exceeds capacity");
  const result: CollaborationNotificationPassResult = {
    claimed: jobs.length,
    acknowledged: 0,
    created: 0,
    duplicate: 0,
    suppressed: 0,
    revoked: 0,
    failed: 0,
  };
  for (const job of jobs) {
    try {
      collaborationAccountId(job.account_id);
      collaborationAccountId(job.project_id);
      boundedString(job.claim_id, "claim");
      if (job.grant_request_id !== null)
        collaborationAccountId(job.grant_request_id);
      const requestedAt = now();
      const page = await store.readPage(
        job,
        COLLABORATION_NOTIFICATION_BATCH_LIMIT,
      );
      validatePage(job, page);
      const assertFresh = () => {
        const age = now() - requestedAt;
        if (
          !Number.isFinite(age) ||
          age < 0 ||
          age >= COLLABORATION_NOTIFICATION_AUTHORITY_LEASE_MS
        )
          throw Error("notification owner authorization expired");
      };
      assertFresh();
      if (page.allowed && !page.reset) {
        for (const { event, authority, attention } of page.entries) {
          assertFresh();
          const delivered = await receiveCollaborationMessageNotification(
            {
              event,
              account_id: job.account_id,
              access_generation: page.access_generation,
              grant_request_id: job.grant_request_id,
              ...(attention === undefined ? {} : { attention }),
            },
            {
              authorize: async () => {
                assertFresh();
                return authority;
              },
              lockAttention: async (input) => {
                assertFresh();
                const attention = await lockAttention(input);
                assertFresh();
                return attention;
              },
            },
          );
          result[delivered.status]++;
        }
      }
      assertFresh();
      if (!(await store.acknowledge(job, page)))
        throw Error("notification delivery claim superseded");
      result.acknowledged++;
    } catch (err) {
      result.failed++;
      await store.fail(job, err);
    }
  }
  return result;
}
