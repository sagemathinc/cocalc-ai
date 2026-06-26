/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import {
  applyNotificationTargetOutboxRowToAccountNotificationIndex,
  type DrainAccountNotificationIndexProjectionResult,
} from "@cocalc/database/postgres/account-notification-index-projector";
import getPool from "@cocalc/database/pool";
import type {
  NotificationKind,
  NotificationTargetOutboxRow,
  NotificationTransportEventType,
} from "@cocalc/database/postgres/notifications-core";
import {
  createInterBayAccountNotificationFeedClient,
  type AccountNotificationFeedUpsertRequest,
  type InterBayAccountNotificationFeedApi,
} from "@cocalc/conat/inter-bay/api";
import { isMultiBayCluster } from "@cocalc/server/cluster-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { publishProjectedNotificationFeedUpdatesBestEffort } from "./feed";

const logger = getLogger("server:notifications:remote-feed");
const RELEVANT_EVENT_TYPES: NotificationTransportEventType[] = [
  "notification.upserted",
];

function parseDate(value: string | Date | null | undefined): Date {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) {
    throw Error(`invalid notification created_at '${value ?? ""}'`);
  }
  return date;
}

function toRemoteRequest(
  event: NotificationTargetOutboxRow,
): AccountNotificationFeedUpsertRequest {
  return {
    target_account_id: event.target_account_id,
    target_home_bay_id: event.target_home_bay_id,
    notification_id: event.notification_id,
    kind: event.kind,
    event_type: event.event_type,
    payload_json: event.payload_json ?? {},
    created_at: event.created_at.toISOString(),
  };
}

function fromRemoteRequest(
  opts: AccountNotificationFeedUpsertRequest,
): NotificationTargetOutboxRow {
  return {
    outbox_id: `remote:${opts.notification_id}`,
    target_home_bay_id: `${opts.target_home_bay_id ?? ""}`.trim(),
    target_account_id: `${opts.target_account_id ?? ""}`.trim(),
    notification_id: `${opts.notification_id ?? ""}`.trim(),
    kind: `${opts.kind ?? ""}`.trim() as NotificationKind,
    event_type:
      `${opts.event_type ?? ""}`.trim() as NotificationTransportEventType,
    payload_json: opts.payload_json ?? {},
    created_at: parseDate(opts.created_at),
    published_at: null,
  };
}

export async function applyRemoteNotificationTargetOnHomeBay(
  opts: AccountNotificationFeedUpsertRequest & { bay_id: string },
): Promise<void> {
  const event = fromRemoteRequest(opts);
  const result =
    await applyNotificationTargetOutboxRowToAccountNotificationIndex({
      bay_id: opts.bay_id,
      event,
      require_local_account: true,
    });
  if (result.affected_account_id && result.affected_notification_id) {
    await publishProjectedNotificationFeedUpdatesBestEffort({
      account_id: result.affected_account_id,
      reason: "projected_upsert",
      notification_ids: [result.affected_notification_id],
    });
  }
}

export async function forwardRemoteNotificationTargetsBestEffort(opts: {
  bay_id: string;
  limit?: number;
  outbox_ids?: string[];
  fabric_client?: ReturnType<typeof getInterBayFabricClient>;
  client_factory?: (dest_bay: string) => InterBayAccountNotificationFeedApi;
}): Promise<DrainAccountNotificationIndexProjectionResult> {
  const bay_id = `${opts.bay_id ?? ""}`.trim();
  if (!bay_id) {
    throw Error("bay_id is required");
  }
  const limit = opts.limit ?? 100;
  const result: DrainAccountNotificationIndexProjectionResult = {
    bay_id,
    dry_run: false,
    requested_limit: limit,
    scanned_events: 0,
    applied_events: 0,
    inserted_rows: 0,
    deleted_rows: 0,
    affected_account_ids: [],
    affected_notifications: [],
    event_types: {},
  };
  if (!isMultiBayCluster()) {
    return result;
  }

  let rows: NotificationTargetOutboxRow[] = [];
  let fabric: ReturnType<typeof getInterBayFabricClient>;
  try {
    const params: any[] = [bay_id, RELEVANT_EVENT_TYPES, limit];
    let outboxIdClause = "";
    if (opts.outbox_ids && opts.outbox_ids.length > 0) {
      params.push(opts.outbox_ids);
      outboxIdClause = `AND outbox_id = ANY($${params.length}::UUID[])`;
    }
    ({ rows } = await getPool().query<NotificationTargetOutboxRow>(
      `SELECT
         outbox_id,
         COALESCE(NULLIF(BTRIM(target_home_bay_id), ''), $1::TEXT) AS target_home_bay_id,
         target_account_id,
         notification_id,
         kind,
         event_type,
         payload_json,
         created_at,
         published_at
       FROM notification_target_outbox
       WHERE COALESCE(NULLIF(BTRIM(target_home_bay_id), ''), $1::TEXT) <> $1::TEXT
         AND published_at IS NULL
         AND event_type = ANY($2::TEXT[])
         ${outboxIdClause}
       ORDER BY created_at ASC, outbox_id ASC
       LIMIT $3`,
      params,
    ));
    result.scanned_events = rows.length;
    fabric = opts.fabric_client ?? getInterBayFabricClient();
  } catch (err) {
    logger.warn("failed to load remote notification targets", {
      bay_id,
      err: `${err}`,
    });
    return result;
  }

  const clients = new Map<string, InterBayAccountNotificationFeedApi>();
  for (const event of rows) {
    result.event_types[event.event_type] =
      (result.event_types[event.event_type] ?? 0) + 1;
    const dest_bay = `${event.target_home_bay_id ?? ""}`.trim();
    try {
      const client =
        clients.get(dest_bay) ??
        opts.client_factory?.(dest_bay) ??
        createInterBayAccountNotificationFeedClient({
          client: fabric,
          dest_bay,
        });
      clients.set(dest_bay, client);
      await client.upsert(toRemoteRequest(event));
      await getPool().query(
        `UPDATE notification_target_outbox
            SET published_at = NOW()
          WHERE outbox_id = $1::UUID
            AND published_at IS NULL`,
        [event.outbox_id],
      );
      result.applied_events += 1;
      result.inserted_rows += 1;
      result.affected_account_ids.push(event.target_account_id);
      result.affected_notifications.push({
        account_id: event.target_account_id,
        notification_id: event.notification_id,
      });
    } catch (err) {
      logger.warn("failed to forward remote notification target", {
        outbox_id: event.outbox_id,
        target_account_id: event.target_account_id,
        target_home_bay_id: dest_bay,
        notification_id: event.notification_id,
        err: `${err}`,
      });
    }
  }
  result.affected_account_ids = Array.from(
    new Set(result.affected_account_ids),
  ).sort();
  result.affected_notifications = Array.from(
    new Set(
      result.affected_notifications.map(
        ({ account_id, notification_id }) => `${account_id}:${notification_id}`,
      ),
    ),
  )
    .sort()
    .map((value) => {
      const [account_id, notification_id] = value.split(":");
      return { account_id, notification_id };
    });
  return result;
}
