/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";

const DEFAULT_SINGLE_BAY_ID = "bay-0";
const NOTIFICATION_KINDS = new Set(["mention", "account_notice"]);
const ORIGIN_KINDS = new Set(["project", "account", "system", "admin"]);

export type NotificationKind = "mention" | "account_notice";
export type NotificationTransportEventType = "notification.upserted";
export type NotificationOriginKind = "project" | "account" | "system" | "admin";

export interface NotificationEventRow {
  event_id: string;
  kind: NotificationKind;
  source_bay_id: string;
  source_project_id: string | null;
  source_path: string | null;
  source_fragment_id: string | null;
  actor_account_id: string | null;
  origin_kind: NotificationOriginKind | null;
  payload_json: Record<string, any>;
  created_at: Date;
}

export interface NotificationTargetRow {
  event_id: string;
  target_account_id: string;
  target_home_bay_id: string;
  notification_id: string;
  dedupe_key: string | null;
  created_at: Date;
}

export interface NotificationTargetOutboxRow {
  outbox_id: string;
  target_home_bay_id: string;
  target_account_id: string;
  notification_id: string;
  kind: NotificationKind;
  event_type: NotificationTransportEventType;
  payload_json: Record<string, any>;
  created_at: Date;
  published_at: Date | null;
}

export interface NotificationTargetTransportInput {
  target_account_id: string;
  target_home_bay_id: string;
  notification_id?: string;
  dedupe_key?: string | null;
  summary_json?: Record<string, any>;
  payload_json?: Record<string, any>;
}

export interface CreateNotificationEventInput {
  kind: NotificationKind;
  source_bay_id?: string | null;
  source_project_id?: string | null;
  source_path?: string | null;
  source_fragment_id?: string | null;
  actor_account_id?: string | null;
  origin_kind?: NotificationOriginKind | null;
  payload_json?: Record<string, any>;
  created_at?: Date | string | null;
  event_id?: string;
  transport_event_type?: NotificationTransportEventType;
  targets: NotificationTargetTransportInput[];
}

export interface CreatedNotificationEventGraph {
  event: NotificationEventRow;
  targets: NotificationTargetRow[];
  outbox: NotificationTargetOutboxRow[];
}

type Queryable = {
  query: (
    sql: string,
    params?: any[],
  ) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

function normalizeUuid(
  value: string | undefined | null,
  label: string,
): string {
  const normalized = `${value ?? ""}`.trim();
  if (!isValidUUID(normalized)) {
    throw Error(`invalid ${label} '${value ?? ""}'`);
  }
  return normalized;
}

function normalizeOptionalUuid(
  value: string | undefined | null,
  label: string,
): string | null {
  if (value == null || `${value}`.trim() === "") return null;
  return normalizeUuid(value, label);
}

function normalizeNotificationKind(
  value: string | undefined,
): NotificationKind {
  const kind = `${value ?? ""}`.trim();
  if (!NOTIFICATION_KINDS.has(kind)) {
    throw Error(`unsupported notification kind '${value ?? ""}'`);
  }
  return kind as NotificationKind;
}

function normalizeOriginKind(
  value: string | undefined | null,
): NotificationOriginKind | null {
  if (value == null || `${value}`.trim() === "") return null;
  const origin_kind = `${value}`.trim();
  if (!ORIGIN_KINDS.has(origin_kind)) {
    throw Error(`unsupported notification origin kind '${value ?? ""}'`);
  }
  return origin_kind as NotificationOriginKind;
}

function normalizeBayId(value?: string | null): string {
  const bay_id = `${value ?? ""}`.trim();
  return bay_id || DEFAULT_SINGLE_BAY_ID;
}

function normalizeTransportEventType(
  value?: string | null,
): NotificationTransportEventType {
  const event_type = `${value ?? "notification.upserted"}`.trim();
  if (event_type !== "notification.upserted") {
    throw Error(
      `unsupported notification transport event type '${value ?? ""}'`,
    );
  }
  return event_type;
}

function normalizeDate(value?: Date | string | null): Date {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) {
    throw Error(`invalid date '${value ?? ""}'`);
  }
  return date;
}

function jsonMap(value: Record<string, any> | undefined): Record<string, any> {
  return value ?? {};
}

function defaultTransportPayload(opts: {
  event: NotificationEventRow;
  target: NotificationTargetRow;
  summary_json?: Record<string, any>;
}): Record<string, any> {
  return {
    notification_id: opts.target.notification_id,
    event_id: opts.event.event_id,
    kind: opts.event.kind,
    source_bay_id: opts.event.source_bay_id,
    source_project_id: opts.event.source_project_id,
    source_path: opts.event.source_path,
    source_fragment_id: opts.event.source_fragment_id,
    actor_account_id: opts.event.actor_account_id,
    origin_kind: opts.event.origin_kind,
    target_account_id: opts.target.target_account_id,
    summary: jsonMap(opts.summary_json),
    event_payload: opts.event.payload_json,
    created_at: opts.event.created_at.toISOString(),
  };
}

export async function resolveNotificationTargetHomeBays(opts: {
  account_ids: string[];
  db?: Queryable;
  default_bay_id?: string;
}): Promise<Record<string, string>> {
  const account_ids = opts.account_ids.map((account_id) =>
    normalizeUuid(account_id, "account id"),
  );
  if (account_ids.length === 0) {
    return {};
  }
  const result = await (opts.db ?? getPool()).query(
    `SELECT
       account_id,
       COALESCE(NULLIF(BTRIM(home_bay_id), ''), $2::TEXT) AS home_bay_id
     FROM accounts
     WHERE account_id = ANY($1::UUID[])
       AND COALESCE(deleted, FALSE) IS NOT TRUE`,
    [account_ids, normalizeBayId(opts.default_bay_id)],
  );
  const { rows } = result as {
    rows: Array<{ account_id: string; home_bay_id: string }>;
  };
  const byAccountId: Record<string, string> = {};
  for (const row of rows) {
    byAccountId[row.account_id] = row.home_bay_id;
  }
  for (const account_id of account_ids) {
    if (!byAccountId[account_id]) {
      throw Error(`account '${account_id}' not found`);
    }
  }
  return byAccountId;
}

async function createNotificationEventGraphWithClient(
  client: PoolClient,
  opts: CreateNotificationEventInput,
): Promise<CreatedNotificationEventGraph> {
  const event_id = opts.event_id
    ? normalizeUuid(opts.event_id, "event id")
    : randomUUID();
  const created_at = normalizeDate(opts.created_at);
  const event: NotificationEventRow = {
    event_id,
    kind: normalizeNotificationKind(opts.kind),
    source_bay_id: normalizeBayId(opts.source_bay_id),
    source_project_id: normalizeOptionalUuid(
      opts.source_project_id,
      "source project id",
    ),
    source_path:
      opts.source_path == null || `${opts.source_path}` === ""
        ? null
        : `${opts.source_path}`,
    source_fragment_id:
      opts.source_fragment_id == null || `${opts.source_fragment_id}` === ""
        ? null
        : `${opts.source_fragment_id}`,
    actor_account_id: normalizeOptionalUuid(
      opts.actor_account_id,
      "actor account id",
    ),
    origin_kind: normalizeOriginKind(opts.origin_kind),
    payload_json: jsonMap(opts.payload_json),
    created_at,
  };

  if (opts.targets.length === 0) {
    throw Error("at least one notification target is required");
  }

  await client.query(
    `INSERT INTO notification_events
       (event_id, kind, source_bay_id, source_project_id, source_path,
        source_fragment_id, actor_account_id, origin_kind, payload_json,
        created_at)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8, $9::JSONB, $10)`,
    [
      event.event_id,
      event.kind,
      event.source_bay_id,
      event.source_project_id,
      event.source_path,
      event.source_fragment_id,
      event.actor_account_id,
      event.origin_kind,
      JSON.stringify(event.payload_json),
      event.created_at,
    ],
  );

  const transport_event_type = normalizeTransportEventType(
    opts.transport_event_type,
  );
  const targets: NotificationTargetRow[] = [];
  const outbox: NotificationTargetOutboxRow[] = [];

  for (const input of opts.targets) {
    const target: NotificationTargetRow = {
      event_id: event.event_id,
      target_account_id: normalizeUuid(input.target_account_id, "account id"),
      target_home_bay_id: normalizeBayId(input.target_home_bay_id),
      notification_id: input.notification_id
        ? normalizeUuid(input.notification_id, "notification id")
        : randomUUID(),
      dedupe_key:
        input.dedupe_key == null || `${input.dedupe_key}` === ""
          ? null
          : `${input.dedupe_key}`,
      created_at,
    };
    await client.query(
      `INSERT INTO notification_targets
         (event_id, target_account_id, target_home_bay_id, notification_id,
          dedupe_key, created_at)
       VALUES
         ($1, $2, $3, $4, $5, $6)`,
      [
        target.event_id,
        target.target_account_id,
        target.target_home_bay_id,
        target.notification_id,
        target.dedupe_key,
        target.created_at,
      ],
    );
    targets.push(target);

    const payload_json =
      input.payload_json ??
      defaultTransportPayload({
        event,
        target,
        summary_json: input.summary_json,
      });
    const result = await client.query<{ outbox_id: string }>(
      `INSERT INTO notification_target_outbox
         (outbox_id, target_home_bay_id, target_account_id, notification_id,
          kind, event_type, payload_json, created_at, published_at)
       VALUES
         (gen_random_uuid(), $1, $2, $3, $4, $5, $6::JSONB, $7, NULL)
       RETURNING outbox_id`,
      [
        target.target_home_bay_id,
        target.target_account_id,
        target.notification_id,
        event.kind,
        transport_event_type,
        JSON.stringify(payload_json),
        created_at,
      ],
    );
    outbox.push({
      outbox_id: `${result.rows[0]?.outbox_id ?? ""}`,
      target_home_bay_id: target.target_home_bay_id,
      target_account_id: target.target_account_id,
      notification_id: target.notification_id,
      kind: event.kind,
      event_type: transport_event_type,
      payload_json,
      created_at,
      published_at: null,
    });
  }

  return {
    event,
    targets,
    outbox,
  };
}

export async function createNotificationEventGraph(
  opts: CreateNotificationEventInput,
): Promise<CreatedNotificationEventGraph> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await createNotificationEventGraphWithClient(client, opts);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function createNotificationEventGraphInTransaction(opts: {
  db: PoolClient;
  input: CreateNotificationEventInput;
}): Promise<CreatedNotificationEventGraph> {
  return await createNotificationEventGraphWithClient(opts.db, opts.input);
}
