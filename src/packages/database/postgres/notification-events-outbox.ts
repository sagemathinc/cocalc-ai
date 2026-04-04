/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";

const DEFAULT_SINGLE_BAY_ID = "bay-0";
export const NOTIFICATION_MENTION_LOOKBACK_INTERVAL = "45 days";

export type NotificationOutboxKind = "mention";
export type NotificationOutboxEventType = "notification.mention_upserted";

export interface MentionNotificationKey {
  time: Date | string;
  project_id: string;
  path: string;
  target: string;
}

export interface MentionNotificationSourceRow extends MentionNotificationKey {
  source: string;
  priority: number | null;
  description: string | null;
  fragment_id: string | null;
  read_state?: Record<string, any> | null;
  owning_bay_id?: string | null;
}

export interface NotificationOutboxPayload {
  account_id: string;
  notification_id: string;
  kind: NotificationOutboxKind;
  project_id: string;
  owning_bay_id: string;
  summary: Record<string, any>;
  read_state: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface NotificationOutboxEventRow {
  event_id: string;
  account_id: string;
  notification_id: string;
  kind: NotificationOutboxKind;
  project_id: string | null;
  owning_bay_id: string;
  event_type: NotificationOutboxEventType;
  payload_json: NotificationOutboxPayload;
  created_at: Date;
  published_at: Date | null;
}

type Queryable = {
  query: (
    sql: string,
    params?: any[],
  ) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

function queryable(db?: Queryable): Queryable {
  return db ?? getPool();
}

function normalizeBayId(value?: string | null): string {
  const bay_id = `${value ?? ""}`.trim();
  return bay_id || DEFAULT_SINGLE_BAY_ID;
}

function normalizeUuid(value: string | undefined, label: string): string {
  const normalized = `${value ?? ""}`.trim();
  if (!isValidUUID(normalized)) {
    throw Error(`invalid ${label} '${value ?? ""}'`);
  }
  return normalized;
}

function normalizeTime(value: Date | string | undefined): string {
  const time = value instanceof Date ? value : new Date(`${value ?? ""}`);
  if (!Number.isFinite(time.getTime())) {
    throw Error(`invalid time '${value ?? ""}'`);
  }
  return time.toISOString();
}

function normalizePath(value: string | undefined): string {
  const path = `${value ?? ""}`;
  if (!path) {
    throw Error("path is required");
  }
  return path;
}

function normalizeReadState(
  value: Record<string, any> | null | undefined,
): Record<string, any> {
  const read = !!value?.read;
  const saved = !!value?.saved;
  return {
    read,
    saved,
  };
}

function stableUuidFromText(value: string): string {
  const chars = createHash("sha1")
    .update(value)
    .digest("hex")
    .slice(0, 32)
    .split("");
  chars[12] = "5";
  const variant = Number.parseInt(chars[16] ?? "0", 16);
  chars[16] = ((variant & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function mentionNotificationId(key: MentionNotificationKey): string {
  const project_id = normalizeUuid(key.project_id, "project id");
  const target = normalizeUuid(key.target, "account id");
  const path = normalizePath(key.path);
  const time = normalizeTime(key.time);
  return stableUuidFromText(
    ["mention", project_id, path, target, time].join("\u001f"),
  );
}

export function buildMentionNotificationPayload(
  row: MentionNotificationSourceRow,
  opts?: {
    default_bay_id?: string;
    updated_at?: Date | string;
  },
): NotificationOutboxPayload {
  const project_id = normalizeUuid(row.project_id, "project id");
  const account_id = normalizeUuid(row.target, "account id");
  const created_at = normalizeTime(row.time);
  return {
    account_id,
    notification_id: mentionNotificationId(row),
    kind: "mention",
    project_id,
    owning_bay_id: normalizeBayId(row.owning_bay_id ?? opts?.default_bay_id),
    summary: {
      path: normalizePath(row.path),
      source: normalizeUuid(row.source, "source account id"),
      target: account_id,
      priority: row.priority ?? 0,
      description: row.description ?? "",
      fragment_id: row.fragment_id ?? null,
    },
    read_state: normalizeReadState(row.read_state),
    created_at,
    updated_at: normalizeTime(opts?.updated_at ?? row.time),
  };
}

export async function loadMentionNotificationOutboxPayload(opts: {
  time: Date | string;
  project_id: string;
  path: string;
  target: string;
  db?: Queryable;
  default_bay_id?: string;
  updated_at?: Date | string;
}): Promise<NotificationOutboxPayload> {
  const db = queryable(opts.db);
  const time = normalizeTime(opts.time);
  const project_id = normalizeUuid(opts.project_id, "project id");
  const path = normalizePath(opts.path);
  const target = normalizeUuid(opts.target, "account id");
  const result = await db.query(
    `SELECT
       m.time,
       m.project_id,
       m.path,
       m.source,
       m.target,
       m.priority,
       m.description,
       m.fragment_id,
       COALESCE(m.users -> m.target, '{}'::JSONB) AS read_state,
       COALESCE(NULLIF(BTRIM(p.owning_bay_id), ''), $5::TEXT) AS owning_bay_id
     FROM mentions m
     LEFT JOIN projects p
       ON p.project_id = m.project_id
     WHERE m.time = $1
       AND m.project_id = $2
       AND m.path = $3
       AND m.target = $4
     LIMIT 1`,
    [time, project_id, path, target, normalizeBayId(opts.default_bay_id)],
  );
  const row = result.rows[0] as MentionNotificationSourceRow | undefined;
  if (!row) {
    throw Error(`mention '${project_id}:${path}:${target}:${time}' not found`);
  }
  return buildMentionNotificationPayload(row, {
    default_bay_id: opts.default_bay_id,
    updated_at: opts.updated_at,
  });
}

export async function appendNotificationOutboxEvent(opts: {
  event_type: NotificationOutboxEventType;
  payload: NotificationOutboxPayload;
  db?: Queryable;
  created_at?: Date | string;
}): Promise<string> {
  const db = queryable(opts.db);
  const created_at = normalizeTime(opts.created_at ?? new Date());
  const payload: NotificationOutboxPayload = {
    ...opts.payload,
    updated_at: created_at,
  };
  const result = await db.query(
    `INSERT INTO notification_events_outbox
       (event_id, account_id, notification_id, project_id, owning_bay_id,
        kind, event_type, payload_json, created_at, published_at)
     VALUES
       (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7::JSONB, $8, NULL)
     RETURNING event_id`,
    [
      normalizeUuid(payload.account_id, "account id"),
      normalizeUuid(payload.notification_id, "notification id"),
      normalizeUuid(payload.project_id, "project id"),
      normalizeBayId(payload.owning_bay_id),
      payload.kind,
      opts.event_type,
      JSON.stringify(payload),
      created_at,
    ],
  );
  const event_id = `${result.rows[0]?.event_id ?? ""}`.trim();
  if (!event_id) {
    throw Error("failed to create notification outbox event");
  }
  return event_id;
}

export async function appendMentionNotificationOutboxEvent(opts: {
  time: Date | string;
  project_id: string;
  path: string;
  target: string;
  db?: Queryable;
  default_bay_id?: string;
  created_at?: Date | string;
}): Promise<string | null> {
  const target = `${opts.target ?? ""}`.trim();
  if (!isValidUUID(target)) {
    return null;
  }
  const payload = await loadMentionNotificationOutboxPayload({
    time: opts.time,
    project_id: opts.project_id,
    path: opts.path,
    target,
    db: opts.db,
    default_bay_id: opts.default_bay_id,
    updated_at: opts.created_at,
  });
  return await appendNotificationOutboxEvent({
    event_type: "notification.mention_upserted",
    payload,
    db: opts.db,
    created_at: opts.created_at,
  });
}
