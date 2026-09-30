/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash } from "node:crypto";

import type { CreateOrUpdateTicket } from "node-zendesk/clients/core/tickets";

import getZendeskClient from "@cocalc/server/support/zendesk-client";
import type {
  CrmOutreachBatch,
  CrmOutreachDelivery,
} from "@cocalc/util/crm-outreach";

export interface OutreachZendeskConfig {
  submitter_id: string;
  group_id: string;
  form_id: string;
  support_address: string;
  read_receipts_enabled: boolean;
  read_receipts_mode: string;
  read_receipts_ticket_field_ids: string;
  read_receipts_integration_id: string;
}

export interface OutreachZendeskTicket {
  id: number;
  external_id: string;
  status: string;
  requester_id?: number;
  comment_ids: number[];
  opening_comment_id?: number;
  last_comment_id?: number;
  requester_reply_at?: string;
  closed_at?: string;
  view_observations: Array<{
    provider_event_id: string;
    comment_id: number;
    observed_at: string;
    provenance: Record<string, unknown>;
  }>;
}

function positiveId(
  value: string,
  name: string,
  optional = false,
): number | undefined {
  if (optional && !value) return;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw Error(`${name} must be a positive Zendesk ID`);
  return id;
}

export function zendeskTag(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function ticketResult(response: any): any {
  return (
    response?.result ??
    response?.response?.ticket ??
    response?.ticket ??
    response
  );
}

function listResult(response: any): any[] {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.result)) return response.result;
  if (Array.isArray(response?.results)) return response.results;
  return [];
}

async function commentsForTicket(
  client: any,
  ticketId: number,
): Promise<any[]> {
  const response = await client.tickets.get([
    "tickets",
    ticketId,
    "comments",
    { sort_order: "asc" },
  ]);
  return listResult(response);
}

function validDate(value: unknown): string | undefined {
  const date = new Date(`${value ?? ""}`);
  if (!Number.isFinite(date.valueOf())) return;
  return date.toISOString();
}

const READ_RECEIPT_PROVIDER = "my_read_receipts";

function readReceiptEventId({
  ticketId,
  openingCommentId,
  observedAt,
  sourceIdentity,
}: {
  ticketId: number;
  openingCommentId: number;
  observedAt: string;
  sourceIdentity:
    | { adapter: "ticket-fields-v1"; ticket_field_id: number }
    | {
        adapter: "private-comment-v1";
        integration_id: number;
        receipt_comment_id: number;
      };
}): string {
  if (!Number.isSafeInteger(ticketId) || ticketId <= 0) {
    throw Error("read receipt ticket ID must be a positive Zendesk ID");
  }
  if (!Number.isSafeInteger(openingCommentId) || openingCommentId <= 0) {
    throw Error(
      "read receipt opening comment ID must be a positive Zendesk ID",
    );
  }
  // The database uniqueness key is global, so bind every provider coordinate.
  const canonicalIdentity = JSON.stringify([
    READ_RECEIPT_PROVIDER,
    ticketId,
    openingCommentId,
    observedAt,
    sourceIdentity,
  ]);
  const digest = createHash("sha256")
    .update(canonicalIdentity, "utf8")
    .digest("hex");
  return `${READ_RECEIPT_PROVIDER}:v2:${digest}`;
}

export function structuredViewObservations({
  ticket,
  comments,
  config,
  openingCommentId,
}: {
  ticket: any;
  comments: any[];
  config: OutreachZendeskConfig;
  openingCommentId?: number;
}): OutreachZendeskTicket["view_observations"] {
  if (!config.read_receipts_enabled || !openingCommentId) return [];
  const ticketId = Number(ticket.id);
  if (config.read_receipts_mode === "ticket_fields") {
    const ids = new Set(
      config.read_receipts_ticket_field_ids
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isSafeInteger(value) && value > 0),
    );
    const result: OutreachZendeskTicket["view_observations"] = [];
    for (const field of ticket.custom_fields ?? []) {
      if (!ids.has(Number(field.id))) continue;
      const values = Array.isArray(field.value) ? field.value : [field.value];
      for (const value of values) {
        const observedAt = validDate(
          typeof value === "object" && value ? value.observed_at : value,
        );
        if (!observedAt) continue;
        result.push({
          provider_event_id: readReceiptEventId({
            ticketId,
            openingCommentId,
            observedAt,
            sourceIdentity: {
              adapter: "ticket-fields-v1",
              ticket_field_id: Number(field.id),
            },
          }),
          comment_id: openingCommentId,
          observed_at: observedAt,
          provenance: {
            adapter: "ticket-fields-v1",
            provider: READ_RECEIPT_PROVIDER,
            zendesk_ticket_id: ticketId,
            opening_comment_id: openingCommentId,
            ticket_field_id: Number(field.id),
          },
        });
      }
    }
    return result;
  }
  const integrationId = positiveId(
    config.read_receipts_integration_id,
    "read receipt integration ID",
    true,
  );
  if (!integrationId) return [];
  const result: OutreachZendeskTicket["view_observations"] = [];
  // This deliberately accepts only a pinned integration author and one
  // versioned machine format. Arbitrary private notes are never interpreted.
  const format = /^COCALC_MRR_V1\s+comment=(\d+)\s+view_observed_at=([^\s]+)$/;
  for (const comment of comments) {
    if (comment.public !== false || Number(comment.author_id) !== integrationId)
      continue;
    const match = format.exec(
      `${comment.plain_body ?? comment.body ?? ""}`.trim(),
    );
    if (!match || Number(match[1]) !== openingCommentId) continue;
    const observedAt = validDate(match[2]);
    if (!observedAt) continue;
    const receiptCommentId = Number(comment.id);
    if (!Number.isSafeInteger(receiptCommentId) || receiptCommentId <= 0)
      continue;
    result.push({
      provider_event_id: readReceiptEventId({
        ticketId,
        openingCommentId,
        observedAt,
        sourceIdentity: {
          adapter: "private-comment-v1",
          integration_id: integrationId,
          receipt_comment_id: receiptCommentId,
        },
      }),
      comment_id: openingCommentId,
      observed_at: observedAt,
      provenance: {
        adapter: "private-comment-v1",
        provider: READ_RECEIPT_PROVIDER,
        zendesk_ticket_id: ticketId,
        opening_comment_id: openingCommentId,
        integration_id: integrationId,
        receipt_comment_id: receiptCommentId,
      },
    });
  }
  return result;
}

function normalizeTicket(
  ticket: any,
  comments: any[],
  config: OutreachZendeskConfig,
): OutreachZendeskTicket {
  const id = Number(ticket.id);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw Error("Zendesk returned an invalid ticket ID");
  const publicComments = comments.filter((comment) => comment.public !== false);
  const opening = publicComments[0];
  const requesterReply = publicComments.find(
    (comment) =>
      opening &&
      Number(comment.id) !== Number(opening.id) &&
      Number(comment.author_id) === Number(ticket.requester_id),
  );
  const status = `${ticket.status ?? ""}`;
  return {
    id,
    external_id: `${ticket.external_id ?? ""}`,
    status,
    requester_id: Number(ticket.requester_id) || undefined,
    comment_ids: comments
      .map((comment) => Number(comment.id))
      .filter(Number.isSafeInteger),
    opening_comment_id: Number(opening?.id) || undefined,
    last_comment_id: Number(comments.at(-1)?.id) || undefined,
    requester_reply_at: validDate(requesterReply?.created_at),
    closed_at: ["closed", "solved"].includes(status)
      ? validDate(ticket.updated_at)
      : undefined,
    view_observations: structuredViewObservations({
      ticket,
      comments,
      config,
      openingCommentId: Number(opening?.id) || undefined,
    }),
  };
}

export async function findOutreachTicketByExternalId(
  externalId: string,
  config: OutreachZendeskConfig,
): Promise<OutreachZendeskTicket | undefined> {
  const client = await getZendeskClient();
  const tickets = listResult(
    await (client.search as any).queryAll(
      `type:ticket external_id:${externalId.replace(/[^a-zA-Z0-9:_-]/g, "")}`,
    ),
  );
  const exact = tickets.filter((ticket) => ticket.external_id === externalId);
  if (exact.length > 1)
    throw Error(`multiple Zendesk tickets use external_id ${externalId}`);
  if (!exact[0]) return;
  const comments = await commentsForTicket(client, Number(exact[0].id));
  return normalizeTicket(exact[0], comments, config);
}

export async function getOutreachTicket(
  ticketId: number,
  config: OutreachZendeskConfig,
): Promise<OutreachZendeskTicket> {
  const client = await getZendeskClient();
  const [response, comments] = await Promise.all([
    client.tickets.show(ticketId),
    commentsForTicket(client, ticketId),
  ]);
  return normalizeTicket(ticketResult(response), comments, config);
}

export async function createOutreachTicket({
  delivery,
  batch,
  customerNumber,
  config,
}: {
  delivery: CrmOutreachDelivery;
  batch: CrmOutreachBatch;
  customerNumber: string;
  config: OutreachZendeskConfig;
}): Promise<OutreachZendeskTicket> {
  const client = await getZendeskClient();
  const submitterId = positiveId(config.submitter_id, "Zendesk submitter ID")!;
  const groupId = positiveId(config.group_id, "Zendesk group ID")!;
  const formId = positiveId(config.form_id, "Zendesk form ID", true);
  if (!config.support_address)
    throw Error("Zendesk shared support address is not configured");
  const ticket: any = {
    ticket: {
      external_id: delivery.provider_external_id,
      requester: {
        name: delivery.recipient_name,
        email: delivery.normalized_email,
      },
      submitter_id: submitterId,
      recipient: config.support_address,
      subject: delivery.subject,
      comment: { public: true, body: delivery.body_plain_text },
      group_id: groupId,
      status: "pending",
      tags: [
        "cocalc_crm_outreach",
        zendeskTag(`crm_${customerNumber}`),
        zendeskTag(`outreach_${batch.outreach_number}`),
        zendeskTag(delivery.kind),
      ].filter(Boolean),
    },
  } satisfies CreateOrUpdateTicket;
  if (formId) ticket.ticket.ticket_form_id = formId;
  const response = await client.tickets.create(ticket);
  const created = ticketResult(response);
  const id = Number(created?.id);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw Error("Zendesk ticket creation returned no ticket ID");
  return await getOutreachTicket(id, config);
}

export async function addOutreachComment({
  ticketId,
  body,
  config,
}: {
  ticketId: number;
  body: string;
  config: OutreachZendeskConfig;
}): Promise<OutreachZendeskTicket> {
  const existing = await getOutreachTicket(ticketId, config);
  const client = await getZendeskClient();
  await client.tickets.update(ticketId, {
    ticket: { comment: { body, public: true }, status: "pending" },
  } as CreateOrUpdateTicket);
  const updated = await getOutreachTicket(ticketId, config);
  if (updated.comment_ids.length <= existing.comment_ids.length) {
    throw Error("Zendesk follow-up comment could not be verified");
  }
  return updated;
}

export async function hasPublicCommentBody(
  ticketId: number,
  body: string,
): Promise<boolean> {
  const client = await getZendeskClient();
  const comments = await commentsForTicket(client, ticketId);
  return comments.some(
    (comment) =>
      comment.public !== false &&
      `${comment.plain_body ?? comment.body ?? ""}`.trim() === body.trim(),
  );
}

export function classifyZendeskError(error: unknown): {
  category: "rate_limited" | "rejected" | "indeterminate" | "unavailable";
  retry_after_seconds?: number;
  message: string;
} {
  const value = error as any;
  const status = Number(
    value?.statusCode ??
      value?.status ??
      value?.response?.status ??
      value?.response?.statusCode,
  );
  const message = `${value?.message ?? error}`.slice(0, 2_000);
  const retryAfter = Number(
    value?.response?.headers?.["retry-after"] ??
      value?.headers?.["retry-after"],
  );
  if (status === 429) {
    return {
      category: "rate_limited",
      retry_after_seconds: Number.isFinite(retryAfter)
        ? Math.max(1, retryAfter)
        : 60,
      message,
    };
  }
  if (status >= 400 && status < 500) return { category: "rejected", message };
  if (
    /timeout|timed out|ECONNRESET|EPIPE|socket hang up|aborted/i.test(
      message,
    ) ||
    status >= 500
  ) {
    return { category: "indeterminate", message };
  }
  return { category: "unavailable", message };
}
