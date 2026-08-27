/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash, randomUUID } from "node:crypto";

import { getLogger } from "@cocalc/backend/logger";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import centralLog from "@cocalc/database/postgres/central-log";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import type {
  CrmOutreachBatch,
  CrmOutreachDelivery,
} from "@cocalc/util/crm-outreach";
import {
  addActivity,
  batchRow,
  deliveryRow,
  loadOutreachConfiguration,
  outreachFollowupIneligibilityReason,
} from "./store";
import {
  recordOutreachEngagement,
  recordOutreachProviderOperation,
  recordOutreachWebhookLag,
} from "./observability";
import {
  addOutreachComment,
  classifyZendeskError,
  createOutreachTicket,
  findOutreachTicketByExternalId,
  getOutreachTicket,
  hasPublicCommentBody,
  type OutreachZendeskConfig,
  type OutreachZendeskTicket,
} from "./zendesk";

const logger = getLogger("server:crm:outreach:worker");
const INTERVAL_MS = 10_000;
const LEASE_MS = 2 * 60_000;
const RECONCILIATION_ABSENCE_GRACE_MS = 5 * 60_000;
const RECONCILIATION_ABSENCE_RETRY_MS = 60_000;
const RECONCILIATION_ABSENCE_MIN_OBSERVATIONS = 3;
const WORKER_KEY = "zendesk";
const WORKER_OWNER = `${process.pid}:${randomUUID()}`;
let timer: NodeJS.Timeout | undefined;
let running = false;

interface ClaimedOperation {
  operation_id: string;
  operation: "create_ticket" | "add_comment" | "reconcile_ticket";
  attempt_number: number;
  request_payload: Record<string, unknown>;
  delivery: CrmOutreachDelivery;
  batch: CrmOutreachBatch;
  customer_number: string;
}

interface WorkerQueryable {
  query: (
    text: string,
    values?: any[],
  ) => Promise<{ rows: any[]; rowCount: number | null }>;
}

export interface ReconciliationAbsenceObservation {
  definitive: boolean;
  next_not_before: string;
  request_payload: Record<string, unknown>;
}

export function observeCreateTicketAbsence(
  requestPayload: Record<string, unknown>,
  now = Date.now(),
): ReconciliationAbsenceObservation {
  const parsedFirst = Date.parse(
    `${requestPayload.absence_first_observed_at ?? ""}`,
  );
  const firstObservedAt = Number.isFinite(parsedFirst) ? parsedFirst : now;
  const previousCount = Number(requestPayload.absence_observation_count);
  const observationCount =
    (Number.isInteger(previousCount) && previousCount >= 0
      ? previousCount
      : 0) + 1;
  return {
    definitive:
      observationCount >= RECONCILIATION_ABSENCE_MIN_OBSERVATIONS &&
      now - firstObservedAt >= RECONCILIATION_ABSENCE_GRACE_MS,
    next_not_before: new Date(
      now + RECONCILIATION_ABSENCE_RETRY_MS,
    ).toISOString(),
    request_payload: {
      ...requestPayload,
      absence_first_observed_at: new Date(firstObservedAt).toISOString(),
      absence_last_observed_at: new Date(now).toISOString(),
      absence_observation_count: observationCount,
    },
  };
}

export async function recoverExpiredProviderOperations(
  db: WorkerQueryable = getPool() as unknown as WorkerQueryable,
): Promise<{
  effectful_indeterminate: number;
  reconciliation_requeued: number;
}> {
  const effectful = await db.query(
    `UPDATE crm_outreach_provider_operations SET state='indeterminate',
      provider_status='worker_lease_expired',error_category='indeterminate',
      error_text='Worker lease expired after the provider effect may have started',
      lease_owner=NULL,lease_expires_at=NULL,not_before=NOW(),finished_at=NOW(),updated_at=NOW()
     WHERE state='started' AND operation IN ('create_ticket','add_comment')
       AND lease_expires_at IS NOT NULL AND lease_expires_at<NOW()
     RETURNING id`,
  );
  const reconciliation = await db.query(
    `UPDATE crm_outreach_provider_operations SET state='queued',
      provider_status='worker_lease_expired_requeued',error_category=NULL,
      error_text=NULL,lease_owner=NULL,lease_expires_at=NULL,not_before=NOW(),
      started_at=NULL,finished_at=NULL,updated_at=NOW()
     WHERE state='started' AND operation='reconcile_ticket'
       AND lease_expires_at IS NOT NULL AND lease_expires_at<NOW()
     RETURNING id`,
  );
  return {
    effectful_indeterminate: effectful.rowCount ?? 0,
    reconciliation_requeued: reconciliation.rowCount ?? 0,
  };
}

export async function reclaimStaleWebhookEvents(
  db: WorkerQueryable = getPool() as unknown as WorkerQueryable,
): Promise<number> {
  const result = await db.query(
    `UPDATE crm_outreach_zendesk_events SET state='failed',next_attempt_at=NOW(),
      last_error='Webhook worker lease expired; retrying safely',updated_at=NOW()
     WHERE state='processing'
       AND updated_at<NOW()-($1::int * INTERVAL '1 millisecond')
     RETURNING event_id`,
    [LEASE_MS],
  );
  return result.rowCount ?? 0;
}

function assertSeed(): void {
  if (getConfiguredBayId() !== getConfiguredClusterSeedBayId()) {
    throw Error("CRM outreach worker must run on seed authority");
  }
}

function zendeskConfig(config: any): OutreachZendeskConfig {
  return {
    submitter_id: config.submitter_id,
    group_id: config.group_id,
    form_id: config.form_id,
    support_address: config.support_address,
    read_receipts_enabled: config.read_receipts_enabled,
    read_receipts_mode: config.read_receipts_mode,
    read_receipts_ticket_field_ids: config.read_receipts_ticket_field_ids,
    read_receipts_integration_id: config.read_receipts_integration_id,
  };
}

async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function touchHeartbeat(
  result?: Record<string, unknown>,
  error?: unknown,
): Promise<void> {
  await getPool().query(
    `INSERT INTO crm_outreach_worker_state
      (provider,heartbeat_at,last_success_at,last_error,last_result,updated_at)
     VALUES($1,NOW(),CASE WHEN $2::text IS NULL THEN NOW() ELSE NULL END,$2,$3,NOW())
     ON CONFLICT(provider) DO UPDATE SET heartbeat_at=NOW(),
       last_success_at=CASE WHEN $2::text IS NULL THEN NOW() ELSE crm_outreach_worker_state.last_success_at END,
       last_error=$2,last_result=$3,updated_at=NOW()`,
    [
      WORKER_KEY,
      error == null ? null : `${error}`.slice(0, 5_000),
      result ?? {},
    ],
  );
}

export async function cancelIneligibleQueuedFollowups(
  retryMaxAttempts: number,
  db: WorkerQueryable = getPool() as unknown as WorkerQueryable,
): Promise<number> {
  const result = await db.query(
    `UPDATE crm_outreach_provider_operations p SET state='cancelled',
      provider_status='cancelled_preflight',error_category='ineligible_followup',
      error_text=CASE
        WHEN d.replied_at IS NOT NULL THEN 'Recipient already replied'
        WHEN d.state<>'notification_requested' THEN 'Delivery is no longer waiting for a response'
        WHEN d.follow_up_attempt_count>=d.max_followups THEN 'Maximum reviewed follow-ups reached'
        WHEN p.attempt_number>$1 THEN 'Maximum provider attempts reached'
        WHEN NOT EXISTS(SELECT 1 FROM crm_tasks t WHERE t.id=d.task_id AND t.state IN ('open','waiting'))
          THEN 'Follow-up task is no longer open or waiting'
        ELSE 'Recipient is suppressed' END,
      lease_owner=NULL,lease_expires_at=NULL,finished_at=NOW(),updated_at=NOW()
     FROM crm_outreach_deliveries d
    WHERE p.delivery_id=d.id AND p.operation='add_comment' AND p.state='queued' AND (
      d.replied_at IS NOT NULL OR d.state<>'notification_requested' OR
      d.follow_up_attempt_count>=d.max_followups OR p.attempt_number>$1 OR
      NOT EXISTS(SELECT 1 FROM crm_tasks t WHERE t.id=d.task_id AND t.state IN ('open','waiting')) OR
      EXISTS(SELECT 1 FROM crm_contact_suppressions s WHERE s.active AND (
        (s.scope='email' AND s.normalized_scope_value=d.normalized_email) OR
        (s.scope='domain' AND s.normalized_scope_value=d.recipient_domain) OR
        (s.scope='person' AND s.person_id=d.person_id) OR
        (s.scope='organization' AND s.organization_id=d.organization_id) OR
        s.person_email_id=d.person_email_id)))
    RETURNING p.id`,
    [retryMaxAttempts],
  );
  return result.rowCount ?? 0;
}

async function claimOneEffectful(): Promise<ClaimedOperation | undefined> {
  assertSeed();
  return await transaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('crm-outreach-provider-rate-v1'))",
    );
    const config = await loadOutreachConfiguration();
    if (!config.enabled || !config.delivery_enabled) return;
    await cancelIneligibleQueuedFollowups(
      config.retry_max_attempts,
      client as unknown as WorkerQueryable,
    );
    const backoff = await client.query(
      "SELECT not_before FROM crm_outreach_worker_state WHERE provider=$1 FOR UPDATE",
      [WORKER_KEY],
    );
    if (
      backoff.rows[0]?.not_before &&
      new Date(backoff.rows[0].not_before) > new Date()
    )
      return;
    const usage = await client.query(
      `SELECT
         count(*) FILTER (WHERE p.started_at>=NOW()-INTERVAL '1 minute')::int AS minute,
         count(*) FILTER (WHERE p.started_at>=NOW()-INTERVAL '1 hour')::int AS hour,
         count(*) FILTER (WHERE p.started_at>=NOW()-INTERVAL '24 hours')::int AS day
       FROM crm_outreach_provider_operations p
       WHERE p.operation IN ('create_ticket','add_comment')
         AND p.started_at IS NOT NULL
         AND p.state IN ('started','succeeded','indeterminate')`,
    );
    if (
      usage.rows[0].minute >= config.send_per_minute ||
      usage.rows[0].hour >= config.send_per_hour ||
      usage.rows[0].day >= config.send_per_day
    ) {
      return;
    }

    const existingOperation = await client.query(
      `SELECT p.*,to_jsonb(d) AS delivery,to_jsonb(b) AS batch,
        o.customer_number,t.state AS task_state,
        (SELECT count(*)::int FROM crm_outreach_provider_operations used
          JOIN crm_outreach_deliveries used_delivery ON used_delivery.id=used.delivery_id
         WHERE used.operation IN ('create_ticket','add_comment')
           AND used.started_at>=NOW()-INTERVAL '24 hours'
           AND used.state IN ('started','succeeded','indeterminate')
           AND used_delivery.recipient_domain=d.recipient_domain) AS domain_usage
         FROM crm_outreach_provider_operations p
         JOIN crm_outreach_deliveries d ON d.id=p.delivery_id
         JOIN crm_outreach_batches b ON b.id=d.batch_id
         JOIN crm_organizations o ON o.id=d.organization_id
         JOIN crm_tasks t ON t.id=d.task_id AND t.state IN ('open','waiting')
        WHERE p.state='queued' AND p.not_before<=NOW()
          AND (p.lease_expires_at IS NULL OR p.lease_expires_at<NOW())
          AND p.operation='add_comment' AND p.attempt_number<=$2
          AND d.state='notification_requested' AND d.replied_at IS NULL
          AND d.follow_up_attempt_count<d.max_followups
          AND NOT EXISTS(SELECT 1 FROM crm_contact_suppressions s WHERE s.active AND (
            (s.scope='email' AND s.normalized_scope_value=d.normalized_email) OR
            (s.scope='domain' AND s.normalized_scope_value=d.recipient_domain) OR
            (s.scope='person' AND s.person_id=d.person_id) OR
            (s.scope='organization' AND s.organization_id=d.organization_id) OR
            s.person_email_id=d.person_email_id))
          AND (SELECT count(*) FROM crm_outreach_provider_operations used
            JOIN crm_outreach_deliveries used_delivery ON used_delivery.id=used.delivery_id
           WHERE used.operation IN ('create_ticket','add_comment')
             AND used.started_at>=NOW()-INTERVAL '24 hours'
             AND used.state IN ('started','succeeded','indeterminate')
             AND used_delivery.recipient_domain=d.recipient_domain)<$1
        ORDER BY p.not_before,p.created_at,p.id
        FOR UPDATE OF p,d,t SKIP LOCKED LIMIT 1`,
      [config.send_per_domain_per_day, config.retry_max_attempts],
    );
    let operation = existingOperation.rows[0];
    if (!operation) {
      const deliveryResult = await client.query(
        `SELECT to_jsonb(d) AS delivery,to_jsonb(b) AS batch,o.customer_number,
          (SELECT count(*)::int FROM crm_outreach_provider_operations used
            JOIN crm_outreach_deliveries used_delivery ON used_delivery.id=used.delivery_id
           WHERE used.operation IN ('create_ticket','add_comment')
             AND used.started_at>=NOW()-INTERVAL '24 hours'
             AND used.state IN ('started','succeeded','indeterminate')
             AND used_delivery.recipient_domain=d.recipient_domain) AS domain_usage
           FROM crm_outreach_deliveries d
           JOIN crm_outreach_batches b ON b.id=d.batch_id
           JOIN crm_organizations o ON o.id=d.organization_id
           JOIN crm_people p ON p.id=d.person_id AND p.status='active'
           JOIN crm_person_emails e ON e.id=d.person_email_id AND e.person_id=d.person_id AND e.verified
           JOIN crm_organization_people op ON op.organization_id=d.organization_id AND op.person_id=d.person_id AND op.state='active'
          WHERE d.state='queued' AND d.next_attempt_at<=NOW() AND b.state IN ('queued','sending')
            AND NOT EXISTS(
              SELECT 1 FROM crm_outreach_provider_operations prior
               WHERE prior.delivery_id=d.id AND prior.operation='create_ticket'
                 AND prior.state IN ('queued','started','indeterminate','succeeded'))
            AND NOT EXISTS(
              SELECT 1 FROM crm_contact_suppressions s WHERE s.active AND (
                (s.scope='email' AND s.normalized_scope_value=d.normalized_email) OR
                (s.scope='domain' AND s.normalized_scope_value=d.recipient_domain) OR
                (s.scope='person' AND s.person_id=d.person_id) OR
                (s.scope='organization' AND s.organization_id=d.organization_id) OR
                s.person_email_id=d.person_email_id))
            AND (SELECT count(*) FROM crm_outreach_provider_operations used
              JOIN crm_outreach_deliveries used_delivery ON used_delivery.id=used.delivery_id
             WHERE used.operation IN ('create_ticket','add_comment')
               AND used.started_at>=NOW()-INTERVAL '24 hours'
               AND used.state IN ('started','succeeded','indeterminate')
               AND used_delivery.recipient_domain=d.recipient_domain)<$1
          ORDER BY d.next_attempt_at,d.id FOR UPDATE OF d SKIP LOCKED LIMIT 1`,
        [config.send_per_domain_per_day],
      );
      const selected = deliveryResult.rows[0];
      if (!selected) return;
      const delivery = deliveryRow(selected.delivery);
      const operationId = randomUUID();
      const attemptNumber = delivery.attempt_count + 1;
      const snapshot = {
        send_per_minute: config.send_per_minute,
        send_per_hour: config.send_per_hour,
        send_per_day: config.send_per_day,
        send_per_domain_per_day: config.send_per_domain_per_day,
        rolling_usage: { ...usage.rows[0], domain: selected.domain_usage },
      };
      await client.query(
        `INSERT INTO crm_outreach_provider_operations
          (id,delivery_id,operation,idempotency_key,payload_hash,state,attempt_number,provider_external_id,
           rate_limit_snapshot,request_payload,lease_owner,lease_expires_at,not_before,started_at,updated_at)
         VALUES($1,$2,'create_ticket',$3,$4,'started',$5,$6,$7,'{}'::jsonb,$8,$9,NOW(),NOW(),NOW())`,
        [
          operationId,
          delivery.id,
          `create-ticket:${delivery.id}:${attemptNumber}`,
          createHash("sha256")
            .update(
              JSON.stringify({
                id: delivery.id,
                subject: delivery.subject,
                email: delivery.normalized_email,
              }),
            )
            .digest("hex"),
          attemptNumber,
          delivery.provider_external_id,
          snapshot,
          WORKER_OWNER,
          new Date(Date.now() + LEASE_MS),
        ],
      );
      await client.query(
        "UPDATE crm_outreach_deliveries SET state='creating_ticket',attempt_count=$1,provider_submitted_at=NOW(),updated_at=NOW(),version=version+1 WHERE id=$2",
        [attemptNumber, delivery.id],
      );
      await client.query(
        "UPDATE crm_outreach_batches SET state='sending',started_at=COALESCE(started_at,NOW()),updated_at=NOW(),version=version+1 WHERE id=$1 AND state='queued'",
        [delivery.batch_id],
      );
      return {
        operation_id: operationId,
        operation: "create_ticket",
        attempt_number: attemptNumber,
        request_payload: {},
        delivery: {
          ...delivery,
          state: "creating_ticket",
          attempt_count: attemptNumber,
        },
        batch: batchRow(selected.batch),
        customer_number: selected.customer_number,
      };
    }

    const delivery = deliveryRow(operation.delivery);
    const ineligible = outreachFollowupIneligibilityReason({
      delivery_state: delivery.state,
      replied_at: delivery.replied_at,
      task_state: operation.task_state,
      follow_up_attempt_count: delivery.follow_up_attempt_count,
      max_followups: delivery.max_followups,
      suppressed: false,
      provider_attempt_number: operation.attempt_number,
      provider_retry_max_attempts: config.retry_max_attempts,
    });
    if (ineligible) {
      await client.query(
        `UPDATE crm_outreach_provider_operations SET state='cancelled',
          provider_status='cancelled_preflight',error_category='ineligible_followup',
          error_text=$1,finished_at=NOW(),updated_at=NOW() WHERE id=$2`,
        [ineligible, operation.id],
      );
      return;
    }
    const updated = await client.query(
      `UPDATE crm_outreach_provider_operations SET state='started',lease_owner=$1,lease_expires_at=$2,
        started_at=NOW(),updated_at=NOW(),rate_limit_snapshot=$3 WHERE id=$4 AND state='queued' RETURNING *`,
      [
        WORKER_OWNER,
        new Date(Date.now() + LEASE_MS),
        {
          send_per_minute: config.send_per_minute,
          send_per_hour: config.send_per_hour,
          send_per_day: config.send_per_day,
          send_per_domain_per_day: config.send_per_domain_per_day,
          rolling_usage: {
            ...usage.rows[0],
            domain: operation.domain_usage,
          },
        },
        operation.id,
      ],
    );
    if (!updated.rows[0]) return;
    return {
      operation_id: operation.id,
      operation: operation.operation,
      attempt_number: operation.attempt_number,
      request_payload: operation.request_payload ?? {},
      delivery,
      batch: batchRow(operation.batch),
      customer_number: operation.customer_number,
    };
  });
}

async function claimOneReconciliation(): Promise<ClaimedOperation | undefined> {
  assertSeed();
  return await transaction(async (client) => {
    const config = await loadOutreachConfiguration();
    if (!config.enabled) return;
    const backoff = await client.query(
      "SELECT not_before FROM crm_outreach_worker_state WHERE provider=$1",
      [WORKER_KEY],
    );
    if (
      backoff.rows[0]?.not_before &&
      new Date(backoff.rows[0].not_before) > new Date()
    ) {
      return;
    }
    const selected = await client.query(
      `SELECT p.*,to_jsonb(d) AS delivery,to_jsonb(b) AS batch,o.customer_number
         FROM crm_outreach_provider_operations p
         JOIN crm_outreach_deliveries d ON d.id=p.delivery_id
         JOIN crm_outreach_batches b ON b.id=d.batch_id
         JOIN crm_organizations o ON o.id=d.organization_id
        WHERE p.state='queued' AND p.operation='reconcile_ticket'
          AND p.not_before<=NOW()
          AND (p.lease_expires_at IS NULL OR p.lease_expires_at<NOW())
        ORDER BY p.not_before,p.created_at,p.id
        FOR UPDATE OF p SKIP LOCKED LIMIT 1`,
    );
    const operation = selected.rows[0];
    if (!operation) return;
    const updated = await client.query(
      `UPDATE crm_outreach_provider_operations SET state='started',lease_owner=$1,
        lease_expires_at=$2,started_at=NOW(),finished_at=NULL,updated_at=NOW(),
        rate_limit_snapshot=jsonb_build_object('lane','reconciliation')
       WHERE id=$3 AND state='queued' RETURNING id`,
      [WORKER_OWNER, new Date(Date.now() + LEASE_MS), operation.id],
    );
    if (!updated.rows[0]) return;
    return {
      operation_id: operation.id,
      operation: "reconcile_ticket",
      attempt_number: operation.attempt_number,
      request_payload: operation.request_payload ?? {},
      delivery: deliveryRow(operation.delivery),
      batch: batchRow(operation.batch),
      customer_number: operation.customer_number,
    };
  });
}

async function revalidateStartedFollowupClaim(
  claim: ClaimedOperation,
): Promise<boolean> {
  const config = await loadOutreachConfiguration();
  return await transaction(async (client) => {
    const current = await client.query(
      `SELECT p.state AS operation_state,p.lease_owner,to_jsonb(d) AS delivery
         FROM crm_outreach_provider_operations p
         JOIN crm_outreach_deliveries d ON d.id=p.delivery_id
        WHERE p.id=$1 FOR UPDATE OF p,d`,
      [claim.operation_id],
    );
    if (
      !current.rows[0] ||
      current.rows[0].operation_state !== "started" ||
      current.rows[0].lease_owner !== WORKER_OWNER
    ) {
      return false;
    }
    if (!config.enabled || !config.delivery_enabled) {
      await client.query(
        `UPDATE crm_outreach_provider_operations SET state='queued',
          provider_status='delivery_disabled',lease_owner=NULL,lease_expires_at=NULL,
          started_at=NULL,finished_at=NULL,error_category=NULL,error_text=NULL,updated_at=NOW()
         WHERE id=$1 AND state='started'`,
        [claim.operation_id],
      );
      return false;
    }
    const delivery = deliveryRow(current.rows[0].delivery);
    const task = delivery.task_id
      ? await client.query(
          "SELECT state FROM crm_tasks WHERE id=$1 FOR UPDATE",
          [delivery.task_id],
        )
      : { rows: [] };
    const suppression = await client.query(
      `SELECT EXISTS(SELECT 1 FROM crm_contact_suppressions s WHERE s.active AND (
        (s.scope='email' AND s.normalized_scope_value=$1) OR
        (s.scope='domain' AND s.normalized_scope_value=$2) OR
        (s.scope='person' AND s.person_id=$3) OR
        (s.scope='organization' AND s.organization_id=$4) OR
        s.person_email_id=$5)) AS suppressed`,
      [
        delivery.normalized_email,
        delivery.recipient_domain,
        delivery.person_id,
        delivery.organization_id,
        delivery.person_email_id,
      ],
    );
    const ineligible = outreachFollowupIneligibilityReason({
      delivery_state: delivery.state,
      replied_at: delivery.replied_at,
      task_state: task.rows[0]?.state,
      follow_up_attempt_count: delivery.follow_up_attempt_count,
      max_followups: delivery.max_followups,
      suppressed: suppression.rows[0]?.suppressed === true,
      provider_attempt_number: claim.attempt_number,
      provider_retry_max_attempts: config.retry_max_attempts,
    });
    if (!ineligible) return true;
    await client.query(
      `UPDATE crm_outreach_provider_operations SET state='cancelled',
        provider_status='cancelled_preflight',error_category='ineligible_followup',
        error_text=$1,lease_owner=NULL,lease_expires_at=NULL,finished_at=NOW(),updated_at=NOW()
       WHERE id=$2 AND state='started'`,
      [ineligible, claim.operation_id],
    );
    return false;
  });
}

async function createFollowUpTask(
  client: PoolClient,
  delivery: CrmOutreachDelivery,
  batch: CrmOutreachBatch,
  ticket: OutreachZendeskTicket,
): Promise<string | null> {
  if (delivery.follow_up_policy !== "no_response") return null;
  const locked = await client.query(
    "SELECT task_id FROM crm_outreach_deliveries WHERE id=$1 FOR UPDATE",
    [delivery.id],
  );
  if (locked.rows[0]?.task_id) return locked.rows[0].task_id;
  const owner = await client.query(
    `SELECT COALESCE(op.owner_account_id,o.relationship_owner_account_id,$3::uuid) AS account_id
       FROM crm_organizations o LEFT JOIN crm_opportunities op ON op.id=$2
      WHERE o.id=$1`,
    [
      delivery.organization_id,
      delivery.opportunity_id ?? null,
      batch.owner_account_id,
    ],
  );
  const taskId = randomUUID();
  const dueAt = new Date(
    Date.now() + delivery.follow_up_after_days * 86_400_000,
  );
  await client.query(
    `INSERT INTO crm_tasks
      (id,organization_id,person_id,opportunity_id,zendesk_ticket_id,type,state,assignee_account_id,due_at,priority,
       subject,details,created_by_account_id,updated_by_account_id)
     VALUES($1,$2,$3,$4,$5,'contact','waiting',$6,$7,'normal',$8,$9,$10,$10)`,
    [
      taskId,
      delivery.organization_id,
      delivery.person_id,
      delivery.opportunity_id ?? null,
      ticket.id,
      owner.rows[0].account_id,
      dueAt,
      `Follow up on ${delivery.kind.replace(/_/g, "-")} offer`,
      "Waiting for a response to reviewed CRM outreach. View observations are prioritization context only.",
      delivery.approved_by_account_id ?? delivery.created_by_account_id,
    ],
  );
  await client.query(
    "UPDATE crm_outreach_deliveries SET task_id=$1,follow_up_due_at=$2 WHERE id=$3",
    [taskId, dueAt, delivery.id],
  );
  return taskId;
}

async function applyTicketSnapshot(
  client: PoolClient,
  delivery: CrmOutreachDelivery,
  batch: CrmOutreachBatch,
  ticket: OutreachZendeskTicket,
): Promise<void> {
  if (
    ticket.external_id &&
    ticket.external_id !== delivery.provider_external_id
  ) {
    throw Error("Zendesk ticket external ID does not match outreach delivery");
  }
  const taskId = await createFollowUpTask(client, delivery, batch, ticket);
  await client.query(
    `UPDATE crm_outreach_deliveries SET zendesk_ticket_id=$1,
      opening_zendesk_comment_id=COALESCE(opening_zendesk_comment_id,$2),last_zendesk_comment_id=$3,
      last_zendesk_status=$4,zendesk_sync_metadata=$5,
      state=CASE WHEN $6::timestamptz IS NOT NULL THEN 'replied'
                 WHEN $7::timestamptz IS NOT NULL THEN 'closed'
                 WHEN state IN ('creating_ticket','queued','approved','failed') THEN 'notification_requested'
                 ELSE state END,
      notification_requested_at=COALESCE(notification_requested_at,NOW()),
      replied_at=COALESCE(replied_at,$6),closed_at=COALESCE(closed_at,$7),
      follow_up_suggested_action=CASE WHEN $6::timestamptz IS NOT NULL THEN 'await_response' ELSE follow_up_suggested_action END,
      last_error=NULL,updated_at=NOW(),version=version+1 WHERE id=$8`,
    [
      ticket.id,
      ticket.opening_comment_id ?? null,
      ticket.last_comment_id ?? null,
      ticket.status,
      {
        synced_at: new Date().toISOString(),
        comment_count: ticket.comment_ids.length,
      },
      ticket.requester_reply_at ?? null,
      ticket.closed_at ?? null,
      delivery.id,
    ],
  );
  const actorId =
    delivery.approved_by_account_id ?? delivery.created_by_account_id;
  await client.query(
    `INSERT INTO crm_external_references
      (id,organization_id,person_id,opportunity_id,provider,object_kind,external_id,label,metadata,
       verification_state,created_by_account_id,updated_by_account_id)
     VALUES($1,$2,$3,$4,'zendesk','ticket',$5,$6,$7,'verified',$8,$8)
     ON CONFLICT(provider,object_kind,external_id) DO UPDATE SET
       organization_id=EXCLUDED.organization_id,person_id=EXCLUDED.person_id,
       opportunity_id=EXCLUDED.opportunity_id,label=EXCLUDED.label,metadata=EXCLUDED.metadata,
       verification_state='verified',updated_by_account_id=EXCLUDED.updated_by_account_id,
       updated_at=NOW(),version=crm_external_references.version+1`,
    [
      randomUUID(),
      delivery.organization_id,
      delivery.person_id,
      delivery.opportunity_id ?? null,
      `${ticket.id}`,
      `CRM outreach ${batch.outreach_number}`,
      { delivery_id: delivery.id, batch_id: batch.id },
      actorId,
    ],
  );
  await addActivity(client, {
    organization_id: delivery.organization_id,
    person_id: delivery.person_id,
    opportunity_id: delivery.opportunity_id,
    task_id: taskId,
    zendesk_ticket_id: ticket.id,
    source_id: `notification-requested:${delivery.id}`,
    summary: `Zendesk notification requested for ${delivery.recipient_name}`,
    metadata: {
      delivery_id: delivery.id,
      batch_id: batch.id,
      opening_comment_id: ticket.opening_comment_id,
    },
  });
  for (const observation of ticket.view_observations) {
    const inserted = await client.query(
      `INSERT INTO crm_outreach_engagement_events
        (id,delivery_id,kind,provider,provider_event_id,zendesk_ticket_id,zendesk_comment_id,observed_at,provenance)
       VALUES($1,$2,'view_observed','my_read_receipts',$3,$4,$5,$6,$7)
       ON CONFLICT(provider,provider_event_id) DO NOTHING RETURNING id`,
      [
        randomUUID(),
        delivery.id,
        observation.provider_event_id,
        ticket.id,
        observation.comment_id,
        observation.observed_at,
        observation.provenance,
      ],
    );
    if (inserted.rows[0]) {
      recordOutreachEngagement("view_observed");
      await addActivity(client, {
        organization_id: delivery.organization_id,
        person_id: delivery.person_id,
        opportunity_id: delivery.opportunity_id,
        task_id: taskId,
        zendesk_ticket_id: ticket.id,
        source_id: `view-observed:${observation.provider_event_id}`,
        summary: "View observed for outreach opening message",
        metadata: {
          delivery_id: delivery.id,
          zendesk_comment_id: observation.comment_id,
          caveat: "May be caused by an email proxy, preview, or scanner.",
        },
      });
    }
  }
  await client.query(
    `UPDATE crm_outreach_deliveries d SET
       first_view_observed_at=e.first_at,last_view_observed_at=e.last_at,
       view_observation_count=e.count,updated_at=NOW()
      FROM (SELECT delivery_id,min(observed_at) AS first_at,max(observed_at) AS last_at,count(*)::int AS count
              FROM crm_outreach_engagement_events WHERE delivery_id=$1 GROUP BY delivery_id) e
     WHERE d.id=e.delivery_id`,
    [delivery.id],
  );
  if (ticket.requester_reply_at && taskId) {
    await client.query(
      `UPDATE crm_tasks SET state='completed',completed_at=COALESCE(completed_at,$1),completed_by_account_id=$2,
        updated_by_account_id=$2,updated_at=NOW(),version=version+1
       WHERE id=$3 AND state IN ('open','waiting')`,
      [ticket.requester_reply_at, actorId, taskId],
    );
    await addActivity(client, {
      organization_id: delivery.organization_id,
      person_id: delivery.person_id,
      opportunity_id: delivery.opportunity_id,
      task_id: taskId,
      zendesk_ticket_id: ticket.id,
      source_id: `requester-reply:${delivery.id}`,
      summary: "Prospect replied to outreach",
      metadata: { delivery_id: delivery.id, outcome: "response_received" },
    });
  }
}

async function finishSuccess(
  claim: ClaimedOperation,
  ticket: OutreachZendeskTicket,
): Promise<void> {
  await transaction(async (client) => {
    const operation = await client.query(
      "SELECT state FROM crm_outreach_provider_operations WHERE id=$1 FOR UPDATE",
      [claim.operation_id],
    );
    if (!operation.rows[0]) {
      throw Error("CRM outreach provider operation disappeared during success");
    }
    if (operation.rows[0].state === "succeeded") return;
    const current = await client.query(
      "SELECT * FROM crm_outreach_deliveries WHERE id=$1 FOR UPDATE",
      [claim.delivery.id],
    );
    const delivery = deliveryRow(current.rows[0]);
    await applyTicketSnapshot(client, delivery, claim.batch, ticket);
    if (claim.operation === "add_comment") {
      await client.query(
        `UPDATE crm_outreach_provider_operations SET state='cancelled',
          provider_status='superseded_by_confirmed_effect',
          error_category=NULL,error_text=NULL,finished_at=NOW(),updated_at=NOW()
         WHERE delivery_id=$1 AND operation='add_comment' AND state='queued' AND id<>$2`,
        [delivery.id, claim.operation_id],
      );
    }
    await client.query(
      `UPDATE crm_outreach_provider_operations SET state='succeeded',zendesk_ticket_id=$1,
        provider_status=$2,lease_owner=NULL,lease_expires_at=NULL,finished_at=NOW(),updated_at=NOW(),error_category=NULL,error_text=NULL
       WHERE id=$3`,
      [ticket.id, ticket.status, claim.operation_id],
    );
    if (claim.operation === "reconcile_ticket") {
      await client.query(
        `UPDATE crm_outreach_provider_operations SET state='succeeded',zendesk_ticket_id=$1,
          provider_status='reconciled',lease_owner=NULL,lease_expires_at=NULL,finished_at=NOW(),updated_at=NOW(),
          error_category=NULL,error_text=NULL
         WHERE delivery_id=$2 AND operation='create_ticket' AND state='indeterminate'`,
        [ticket.id, delivery.id],
      );
    }
    if (claim.operation === "add_comment") {
      const nextDue = `${claim.request_payload.next_due_at ?? ""}`;
      await client.query(
        `UPDATE crm_outreach_deliveries SET last_follow_up_at=NOW(),follow_up_attempt_count=follow_up_attempt_count+1,
          follow_up_due_at=$1,follow_up_suggested_action='await_response',updated_at=NOW(),version=version+1 WHERE id=$2`,
        [nextDue, delivery.id],
      );
      if (delivery.task_id) {
        await client.query(
          `UPDATE crm_tasks SET state='waiting',due_at=$1,updated_by_account_id=$2,updated_at=NOW(),version=version+1 WHERE id=$3 AND state IN ('open','waiting')`,
          [
            nextDue,
            claim.request_payload.actor_account_id ??
              delivery.updated_by_account_id,
            delivery.task_id,
          ],
        );
      }
      await addActivity(client, {
        organization_id: delivery.organization_id,
        person_id: delivery.person_id,
        opportunity_id: delivery.opportunity_id,
        task_id: delivery.task_id,
        zendesk_ticket_id: ticket.id,
        source_id: `followup-sent:${claim.operation_id}`,
        summary: "Sent reviewed outreach follow-up in Zendesk",
        metadata: {
          delivery_id: delivery.id,
          attempt: delivery.follow_up_attempt_count + 1,
        },
      });
    }
    await updateBatchCompletion(client, delivery.batch_id);
  });
}

async function updateBatchCompletion(
  client: PoolClient,
  batchId: string,
): Promise<void> {
  const outstanding = await client.query(
    `SELECT count(*)::int AS count FROM crm_outreach_deliveries
      WHERE batch_id=$1 AND state IN ('draft','approved','queued','creating_ticket','failed')`,
    [batchId],
  );
  if (!outstanding.rows[0].count) {
    await client.query(
      "UPDATE crm_outreach_batches SET state='complete',completed_at=COALESCE(completed_at,NOW()),updated_at=NOW(),version=version+1 WHERE id=$1 AND state IN ('queued','sending')",
      [batchId],
    );
  }
}

async function finishFailure(
  claim: ClaimedOperation,
  error: unknown,
): Promise<void> {
  const config = await loadOutreachConfiguration();
  const classified = classifyZendeskError(error);
  const retrySeconds = Math.min(
    config.retry_base_seconds * 2 ** Math.max(0, claim.attempt_number - 1),
    6 * 60 * 60,
  );
  await transaction(async (client) => {
    const operation = await client.query(
      "SELECT state FROM crm_outreach_provider_operations WHERE id=$1 FOR UPDATE",
      [claim.operation_id],
    );
    if (!operation.rows[0] || operation.rows[0].state !== "started") return;
    if (classified.category === "rate_limited") {
      const notBefore = new Date(
        Date.now() + (classified.retry_after_seconds ?? 60) * 1_000,
      );
      await client.query(
        `INSERT INTO crm_outreach_worker_state(provider,not_before,last_error,updated_at)
         VALUES($1,$2,$3,NOW()) ON CONFLICT(provider) DO UPDATE SET not_before=$2,last_error=$3,updated_at=NOW()`,
        [WORKER_KEY, notBefore, classified.message],
      );
    }
    const indeterminate = classified.category === "indeterminate";
    const permanent =
      classified.category === "rejected" ||
      claim.attempt_number >= config.retry_max_attempts;
    const reconciliationRetry =
      claim.operation === "reconcile_ticket" &&
      classified.category !== "rejected" &&
      !permanent;
    const followupRetry =
      claim.operation === "add_comment" &&
      (classified.category === "rate_limited" ||
        classified.category === "unavailable") &&
      !permanent;
    const operationRetry = reconciliationRetry || followupRetry;
    const operationState = operationRetry
      ? "queued"
      : indeterminate
        ? "indeterminate"
        : "failed";
    await client.query(
      `UPDATE crm_outreach_provider_operations SET state=$1,error_category=$2,error_text=$3,
        provider_status=$4,not_before=$5,lease_owner=NULL,lease_expires_at=NULL,
        attempt_number=attempt_number+CASE WHEN $7::boolean THEN 1 ELSE 0 END,
        finished_at=CASE WHEN $7::boolean THEN NULL ELSE NOW() END,updated_at=NOW()
       WHERE id=$6`,
      [
        operationState,
        classified.category,
        classified.message,
        "provider_error",
        new Date(Date.now() + retrySeconds * 1_000),
        claim.operation_id,
        operationRetry,
      ],
    );
    if (claim.operation === "create_ticket") {
      const deliveryState = indeterminate
        ? "creating_ticket"
        : permanent
          ? "failed"
          : "queued";
      await client.query(
        "UPDATE crm_outreach_deliveries SET state=$1,last_error=$2,next_attempt_at=$3,updated_at=NOW(),version=version+1 WHERE id=$4",
        [
          deliveryState,
          classified.message,
          new Date(Date.now() + retrySeconds * 1_000),
          claim.delivery.id,
        ],
      );
    }
    await addActivity(client, {
      organization_id: claim.delivery.organization_id,
      person_id: claim.delivery.person_id,
      opportunity_id: claim.delivery.opportunity_id,
      task_id: claim.delivery.task_id,
      zendesk_ticket_id: claim.delivery.zendesk_ticket_id,
      source_id: `provider-failure:${claim.operation_id}`,
      summary: indeterminate
        ? "Zendesk outreach result is indeterminate; reconciliation required"
        : "Zendesk outreach provider operation failed",
      details: classified.message,
      metadata: {
        delivery_id: claim.delivery.id,
        operation: claim.operation,
        category: classified.category,
      },
    });
  });
}

async function finishReconciliation(
  claim: ClaimedOperation,
  providerStatus: string,
): Promise<void> {
  await getPool().query(
    `UPDATE crm_outreach_provider_operations SET state='succeeded',provider_status=$1,
      lease_owner=NULL,lease_expires_at=NULL,finished_at=NOW(),updated_at=NOW(),
      error_category=NULL,error_text=NULL WHERE id=$2`,
    [providerStatus, claim.operation_id],
  );
}

async function resolveTargetedReconciliation(
  claim: ClaimedOperation,
  config: OutreachZendeskConfig,
): Promise<boolean> {
  const targetOperationId = `${claim.request_payload.target_operation_id ?? ""}`;
  if (!targetOperationId) return false;
  const { rows } = await getPool().query(
    "SELECT * FROM crm_outreach_provider_operations WHERE id=$1 AND delivery_id=$2",
    [targetOperationId, claim.delivery.id],
  );
  const target = rows[0];
  if (!target || target.state !== "indeterminate") {
    await finishReconciliation(claim, "target_already_resolved");
    return true;
  }

  let ticket: OutreachZendeskTicket | undefined;
  if (target.operation === "create_ticket") {
    ticket = await findOutreachTicketByExternalId(
      claim.delivery.provider_external_id,
      config,
    );
  } else if (target.operation === "add_comment") {
    if (!claim.delivery.zendesk_ticket_id)
      throw Error("delivery has no Zendesk ticket during reconciliation");
    const body = `${target.request_payload?.body ?? ""}`.trim();
    if (!body)
      throw Error("indeterminate follow-up operation has no reviewed body");
    if (await hasPublicCommentBody(claim.delivery.zendesk_ticket_id, body)) {
      ticket = await getOutreachTicket(
        claim.delivery.zendesk_ticket_id,
        config,
      );
    }
  } else {
    throw Error(`unsupported reconciliation target ${target.operation}`);
  }

  if (ticket) {
    await finishSuccess(
      {
        ...claim,
        operation_id: target.id,
        operation: target.operation,
        attempt_number: target.attempt_number,
        request_payload: target.request_payload ?? {},
      },
      ticket,
    );
    await finishReconciliation(claim, "effect_found");
    return true;
  }

  if (target.operation === "create_ticket") {
    const observation = observeCreateTicketAbsence(claim.request_payload);
    if (!observation.definitive) {
      await getPool().query(
        `UPDATE crm_outreach_provider_operations SET state='queued',
          provider_status='effect_not_found_observing',request_payload=$1,
          not_before=$2,lease_owner=NULL,lease_expires_at=NULL,finished_at=NULL,
          error_category=NULL,error_text=NULL,updated_at=NOW() WHERE id=$3`,
        [
          observation.request_payload,
          observation.next_not_before,
          claim.operation_id,
        ],
      );
      return true;
    }
  }

  const outreachConfig = await loadOutreachConfiguration();
  await transaction(async (client) => {
    let retryQueued = false;
    await client.query(
      `UPDATE crm_outreach_provider_operations SET state='failed',provider_status='effect_absent',
        error_category='reconciled_absent',error_text='Provider effect was absent after reconciliation',
        lease_owner=NULL,lease_expires_at=NULL,finished_at=NOW(),updated_at=NOW() WHERE id=$1`,
      [target.id],
    );
    await client.query(
      `UPDATE crm_outreach_provider_operations SET state='succeeded',provider_status='effect_absent',
        lease_owner=NULL,lease_expires_at=NULL,finished_at=NOW(),updated_at=NOW(),
        error_category=NULL,error_text=NULL WHERE id=$1`,
      [claim.operation_id],
    );
    if (target.operation === "create_ticket") {
      const exhausted =
        target.attempt_number >= outreachConfig.retry_max_attempts;
      retryQueued = !exhausted;
      await client.query(
        `UPDATE crm_outreach_deliveries SET state=$1,last_error=$2,next_attempt_at=NOW(),
          updated_at=NOW(),version=version+1 WHERE id=$3`,
        [
          exhausted ? "failed" : "queued",
          exhausted
            ? "Zendesk ticket creation remained absent after the maximum attempts"
            : null,
          claim.delivery.id,
        ],
      );
    } else if (target.attempt_number < outreachConfig.retry_max_attempts) {
      const eligibility = await client.query(
        `SELECT to_jsonb(d) AS delivery,t.state AS task_state,
          EXISTS(SELECT 1 FROM crm_contact_suppressions s WHERE s.active AND (
            (s.scope='email' AND s.normalized_scope_value=d.normalized_email) OR
            (s.scope='domain' AND s.normalized_scope_value=d.recipient_domain) OR
            (s.scope='person' AND s.person_id=d.person_id) OR
            (s.scope='organization' AND s.organization_id=d.organization_id) OR
            s.person_email_id=d.person_email_id)) AS suppressed
         FROM crm_outreach_deliveries d LEFT JOIN crm_tasks t ON t.id=d.task_id
        WHERE d.id=$1 FOR UPDATE OF d`,
        [claim.delivery.id],
      );
      const currentDelivery = eligibility.rows[0]
        ? deliveryRow(eligibility.rows[0].delivery)
        : claim.delivery;
      const ineligible = outreachFollowupIneligibilityReason({
        delivery_state: currentDelivery.state,
        replied_at: currentDelivery.replied_at,
        task_state: eligibility.rows[0]?.task_state,
        follow_up_attempt_count: currentDelivery.follow_up_attempt_count,
        max_followups: currentDelivery.max_followups,
        suppressed: eligibility.rows[0]?.suppressed === true,
        provider_attempt_number: target.attempt_number + 1,
        provider_retry_max_attempts: outreachConfig.retry_max_attempts,
      });
      if (!ineligible) {
        const retryId = randomUUID();
        const attempt = target.attempt_number + 1;
        const inserted = await client.query(
          `INSERT INTO crm_outreach_provider_operations
            (id,delivery_id,operation,idempotency_key,payload_hash,state,attempt_number,
             provider_external_id,rate_limit_snapshot,request_payload,not_before)
           VALUES($1,$2,'add_comment',$3,$4,'queued',$5,$6,'{}'::jsonb,$7,NOW())
           ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`,
          [
            retryId,
            claim.delivery.id,
            `retry-add-comment:${target.id}:${attempt}`,
            target.payload_hash,
            attempt,
            target.provider_external_id,
            target.request_payload ?? {},
          ],
        );
        retryQueued = !!inserted.rows[0];
      }
    }
    await addActivity(client, {
      organization_id: claim.delivery.organization_id,
      person_id: claim.delivery.person_id,
      opportunity_id: claim.delivery.opportunity_id,
      task_id: claim.delivery.task_id,
      zendesk_ticket_id: claim.delivery.zendesk_ticket_id,
      source_id: `provider-effect-absent:${target.id}`,
      summary: "Zendesk outreach effect was absent after reconciliation",
      metadata: {
        delivery_id: claim.delivery.id,
        operation: target.operation,
        retry_queued: retryQueued,
      },
    });
  });
  return true;
}

async function processClaim(claim: ClaimedOperation): Promise<void> {
  const config = zendeskConfig(await loadOutreachConfiguration());
  const startedAt = Date.now();
  try {
    let ticket: OutreachZendeskTicket;
    if (claim.operation === "create_ticket") {
      ticket =
        (await findOutreachTicketByExternalId(
          claim.delivery.provider_external_id,
          config,
        )) ??
        (await createOutreachTicket({
          delivery: claim.delivery,
          batch: claim.batch,
          customerNumber: claim.customer_number,
          config,
        }));
    } else if (claim.operation === "add_comment") {
      if (!(await revalidateStartedFollowupClaim(claim))) {
        recordOutreachProviderOperation(
          claim.operation,
          "preflight_not_sent",
          Date.now() - startedAt,
        );
        return;
      }
      if (!claim.delivery.zendesk_ticket_id)
        throw Error("delivery has no Zendesk ticket");
      const body = `${claim.request_payload.body ?? ""}`.trim();
      if (!body) throw Error("reviewed follow-up operation has no body");
      ticket = (await hasPublicCommentBody(
        claim.delivery.zendesk_ticket_id,
        body,
      ))
        ? await getOutreachTicket(claim.delivery.zendesk_ticket_id, config)
        : await addOutreachComment({
            ticketId: claim.delivery.zendesk_ticket_id,
            body,
            config,
          });
    } else if (await resolveTargetedReconciliation(claim, config)) {
      recordOutreachProviderOperation(
        claim.operation,
        "success",
        Date.now() - startedAt,
      );
      return;
    } else {
      ticket = claim.delivery.zendesk_ticket_id
        ? await getOutreachTicket(claim.delivery.zendesk_ticket_id, config)
        : ((await findOutreachTicketByExternalId(
            claim.delivery.provider_external_id,
            config,
          )) ??
          (() => {
            throw Error("Zendesk ticket was not found during reconciliation");
          })());
    }
    await finishSuccess(claim, ticket);
    recordOutreachProviderOperation(
      claim.operation,
      "success",
      Date.now() - startedAt,
    );
  } catch (err) {
    const classified = classifyZendeskError(err);
    await finishFailure(claim, err);
    recordOutreachProviderOperation(
      claim.operation,
      classified.category,
      Date.now() - startedAt,
    );
    throw err;
  }
}

async function enqueueIndeterminateReconciliation(): Promise<number> {
  const { rowCount } = await getPool().query(
    `INSERT INTO crm_outreach_provider_operations
      (id,delivery_id,operation,idempotency_key,payload_hash,state,attempt_number,provider_external_id,
       rate_limit_snapshot,request_payload,not_before)
     SELECT gen_random_uuid(),p.delivery_id,'reconcile_ticket','reconcile-indeterminate:'||p.id,
       md5('reconcile:'||p.id),'queued',p.attempt_number,
       p.provider_external_id,'{}'::jsonb,
       jsonb_build_object('target_operation_id',p.id,'target_operation',p.operation),NOW()
       FROM crm_outreach_provider_operations p
      WHERE p.state='indeterminate' AND p.not_before<=NOW()
        AND NOT EXISTS(SELECT 1 FROM crm_outreach_provider_operations r
          WHERE r.idempotency_key='reconcile-indeterminate:'||p.id)
      ON CONFLICT(idempotency_key) DO NOTHING`,
  );
  return rowCount ?? 0;
}

async function enqueuePeriodicReconciliation(limit: number): Promise<number> {
  const { rowCount } = await getPool().query(
    `INSERT INTO crm_outreach_provider_operations
      (id,delivery_id,operation,idempotency_key,payload_hash,state,attempt_number,provider_external_id,
       rate_limit_snapshot,request_payload,not_before)
     SELECT gen_random_uuid(),d.id,'reconcile_ticket',
       'periodic-reconcile:'||d.id||':'||floor(extract(epoch from NOW())/900)::bigint,
       md5('periodic:'||d.id),'queued',1,d.provider_external_id,
       '{}'::jsonb,'{}'::jsonb,NOW()
       FROM crm_outreach_deliveries d
      WHERE d.state IN ('notification_requested','replied') AND d.zendesk_ticket_id IS NOT NULL
        AND (d.zendesk_sync_metadata->>'synced_at' IS NULL OR (d.zendesk_sync_metadata->>'synced_at')::timestamptz<NOW()-INTERVAL '15 minutes')
      ORDER BY d.updated_at LIMIT $1 ON CONFLICT(idempotency_key) DO NOTHING`,
    [limit],
  );
  return rowCount ?? 0;
}

async function updateFollowUpSuggestions(): Promise<number> {
  const { rowCount } = await getPool().query(
    `UPDATE crm_outreach_deliveries d SET follow_up_suggested_action=CASE
       WHEN d.follow_up_attempt_count>=d.max_followups THEN 'close_no_response'
       WHEN d.view_observation_count>0 THEN 'review_and_follow_up'
       ELSE 'verify_delivery' END,updated_at=NOW()
      FROM crm_tasks t WHERE t.id=d.task_id AND t.state IN ('open','waiting')
       AND t.due_at<=NOW() AND d.replied_at IS NULL AND d.state='notification_requested'
       AND d.follow_up_suggested_action IS DISTINCT FROM CASE
         WHEN d.follow_up_attempt_count>=d.max_followups THEN 'close_no_response'
         WHEN d.view_observation_count>0 THEN 'review_and_follow_up'
         ELSE 'verify_delivery' END`,
  );
  return rowCount ?? 0;
}

async function claimWebhookEvent(): Promise<any | undefined> {
  return await transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM crm_outreach_zendesk_events
        WHERE state IN ('pending','failed') AND next_attempt_at<=NOW()
        ORDER BY received_at,event_id FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    if (!rows[0]) return;
    const updated = await client.query(
      `UPDATE crm_outreach_zendesk_events SET state='processing',attempt_count=attempt_count+1,updated_at=NOW()
        WHERE event_id=$1 RETURNING *`,
      [rows[0].event_id],
    );
    return updated.rows[0];
  });
}

async function processWebhookQueue(limit: number): Promise<{
  processed: number;
  failed: number;
  ignored: number;
}> {
  const config = zendeskConfig(await loadOutreachConfiguration());
  let processed = 0;
  let failed = 0;
  let ignored = 0;
  while (processed + failed + ignored < limit) {
    const event = await claimWebhookEvent();
    if (!event) break;
    try {
      const linked = await getPool().query(
        `SELECT to_jsonb(d) AS delivery,to_jsonb(b) AS batch
          FROM crm_outreach_deliveries d
          JOIN crm_outreach_batches b ON b.id=d.batch_id WHERE d.zendesk_ticket_id=$1`,
        [event.zendesk_ticket_id],
      );
      if (!linked.rows[0]) {
        await getPool().query(
          `UPDATE crm_outreach_zendesk_events SET state='ignored',processed_at=NOW(),updated_at=NOW(),last_error=NULL
            WHERE event_id=$1`,
          [event.event_id],
        );
        ignored += 1;
        continue;
      }
      const ticket = await getOutreachTicket(event.zendesk_ticket_id, config);
      await transaction(async (client) => {
        const current = await client.query(
          "SELECT * FROM crm_outreach_deliveries WHERE id=$1 FOR UPDATE",
          [linked.rows[0].delivery.id],
        );
        await applyTicketSnapshot(
          client,
          deliveryRow(current.rows[0]),
          batchRow(linked.rows[0].batch),
          ticket,
        );
        await client.query(
          `UPDATE crm_outreach_zendesk_events SET state='processed',processed_at=NOW(),updated_at=NOW(),last_error=NULL
            WHERE event_id=$1`,
          [event.event_id],
        );
      });
      processed += 1;
      recordOutreachWebhookLag(event.occurred_at);
    } catch (err) {
      failed += 1;
      const maxAttempts = 8;
      const dead = event.attempt_count >= maxAttempts;
      const delay = Math.min(
        60 * 2 ** Math.max(0, event.attempt_count - 1),
        21_600,
      );
      await getPool().query(
        `UPDATE crm_outreach_zendesk_events SET state=$1,last_error=$2,
          next_attempt_at=NOW()+($3::int * INTERVAL '1 second'),
          dead_lettered_at=CASE WHEN $1='dead_letter' THEN NOW() ELSE NULL END,
          processed_at=CASE WHEN $1='dead_letter' THEN NOW() ELSE NULL END,updated_at=NOW()
         WHERE event_id=$4`,
        [
          dead ? "dead_letter" : "failed",
          `${err}`.slice(0, 5_000),
          delay,
          event.event_id,
        ],
      );
    }
  }
  return { processed, failed, ignored };
}

export async function runOutreachWorkerCycle(): Promise<
  Record<string, unknown>
> {
  assertSeed();
  const config = await loadOutreachConfiguration();
  if (!config.enabled) {
    const result = { disabled: true };
    await touchHeartbeat(result);
    return result;
  }
  const recoveredOperations = await recoverExpiredProviderOperations();
  const staleWebhookEventsReclaimed = await reclaimStaleWebhookEvents();
  const ineligibleFollowupsCancelled = await cancelIneligibleQueuedFollowups(
    config.retry_max_attempts,
  );
  const indeterminateQueued = await enqueueIndeterminateReconciliation();
  const periodicQueued = await enqueuePeriodicReconciliation(
    config.worker_batch_size,
  );
  const suggestions = await updateFollowUpSuggestions();
  const webhook = config.webhook_enabled
    ? await processWebhookQueue(config.worker_batch_size)
    : { processed: 0, failed: 0, ignored: 0, disabled: true };
  let reconciled = 0;
  let reconciliationFailed = 0;
  while (reconciled + reconciliationFailed < config.worker_batch_size) {
    const claim = await claimOneReconciliation();
    if (!claim) break;
    try {
      await processClaim(claim);
      reconciled += 1;
    } catch (err) {
      reconciliationFailed += 1;
      logger.warn("CRM outreach reconciliation failed", {
        operation_id: claim.operation_id,
        delivery_id: claim.delivery.id,
        error: `${err}`.slice(0, 2_000),
      });
    }
  }
  let processed = 0;
  let failed = 0;
  if (config.delivery_enabled) {
    while (processed + failed < config.worker_batch_size) {
      const claim = await claimOneEffectful();
      if (!claim) break;
      try {
        await processClaim(claim);
        processed += 1;
      } catch (err) {
        failed += 1;
        logger.warn("CRM outreach provider operation failed", {
          operation_id: claim.operation_id,
          delivery_id: claim.delivery.id,
          operation: claim.operation,
          error: `${err}`.slice(0, 2_000),
        });
      }
    }
  }
  const result = {
    processed,
    failed,
    reconciled,
    reconciliation_failed: reconciliationFailed,
    recovered_provider_operations: recoveredOperations,
    stale_webhook_events_reclaimed: staleWebhookEventsReclaimed,
    ineligible_followups_cancelled: ineligibleFollowupsCancelled,
    indeterminate_reconciliations_queued: indeterminateQueued,
    periodic_reconciliations_queued: periodicQueued,
    follow_up_suggestions_updated: suggestions,
    webhook,
    delivery_enabled: config.delivery_enabled,
  };
  await touchHeartbeat(result);
  await centralLog({ event: "crm_outreach_worker", value: result });
  return result;
}

async function run(): Promise<void> {
  if (running || getConfiguredBayId() !== getConfiguredClusterSeedBayId())
    return;
  running = true;
  try {
    await runOutreachWorkerCycle();
  } catch (err) {
    logger.warn("CRM outreach worker cycle failed", { error: `${err}` });
    try {
      await touchHeartbeat(undefined, err);
    } catch (heartbeatError) {
      logger.warn("CRM outreach worker heartbeat failed", {
        error: `${heartbeatError}`,
      });
    }
  } finally {
    running = false;
  }
}

export function startCrmOutreachWorker(): void {
  if (timer || getConfiguredBayId() !== getConfiguredClusterSeedBayId()) return;
  void run();
  timer = setInterval(() => void run(), INTERVAL_MS);
  timer.unref?.();
}

export function stopCrmOutreachWorkerForTests(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  running = false;
}
