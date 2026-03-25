/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type {
  RootfsImageEvent,
  RootfsImageEventType,
} from "@cocalc/util/rootfs-images";
import { v4 as uuid } from "uuid";

type EventRow = {
  event_id: string;
  image_id: string;
  release_id: string | null;
  event_type: RootfsImageEventType;
  actor_account_id: string | null;
  reason: string | null;
  payload: Record<string, any> | null;
  created: Date;
  actor_first_name: string | null;
  actor_last_name: string | null;
};

function trimString(value?: string | null): string | undefined {
  const trimmed = `${value ?? ""}`.trim();
  return trimmed ? trimmed : undefined;
}

function fullName(row: EventRow): string | undefined {
  const first = trimString(row.actor_first_name);
  const last = trimString(row.actor_last_name);
  const name = [first, last].filter(Boolean).join(" ").trim();
  return name || undefined;
}

function rowToEvent(row: EventRow): RootfsImageEvent {
  return {
    event_id: row.event_id,
    image_id: row.image_id,
    release_id: row.release_id ?? undefined,
    event_type: row.event_type,
    actor_account_id: row.actor_account_id ?? undefined,
    actor_name: fullName(row),
    reason: row.reason ?? undefined,
    payload: row.payload ?? undefined,
    created: row.created.toISOString(),
  };
}

export async function appendRootfsImageEvent({
  image_id,
  release_id,
  event_type,
  actor_account_id,
  reason,
  payload,
}: {
  image_id: string;
  release_id?: string | null;
  event_type: RootfsImageEventType;
  actor_account_id?: string | null;
  reason?: string | null;
  payload?: Record<string, any> | null;
}): Promise<void> {
  await getPool("medium").query(
    `INSERT INTO rootfs_image_events
       (event_id, image_id, release_id, event_type, actor_account_id, reason, payload, created)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7::JSONB, NOW())`,
    [
      uuid(),
      image_id,
      release_id ?? null,
      event_type,
      actor_account_id ?? null,
      trimString(reason) ?? null,
      payload ? JSON.stringify(payload) : null,
    ],
  );
}

export async function appendRootfsImageEventForReleaseImages({
  release_id,
  event_type,
  actor_account_id,
  reason,
  payload,
}: {
  release_id: string;
  event_type: RootfsImageEventType;
  actor_account_id?: string | null;
  reason?: string | null;
  payload?: Record<string, any> | null;
}): Promise<void> {
  const { rows } = await getPool("medium").query<{ image_id: string }>(
    `SELECT image_id
     FROM rootfs_images
     WHERE release_id=$1
     ORDER BY created ASC`,
    [release_id],
  );
  await Promise.all(
    rows.map(async ({ image_id }) => {
      await appendRootfsImageEvent({
        image_id,
        release_id,
        event_type,
        actor_account_id,
        reason,
        payload,
      });
    }),
  );
}

export async function listRecentRootfsImageEvents({
  image_ids,
  limitPerImage = 5,
}: {
  image_ids: string[];
  limitPerImage?: number;
}): Promise<Map<string, RootfsImageEvent[]>> {
  const ids = Array.from(new Set(image_ids.map((id) => `${id ?? ""}`.trim())));
  const result = new Map<string, RootfsImageEvent[]>();
  if (!ids.length) return result;
  const { rows } = await getPool("medium").query<EventRow & { rn: number }>(
    `SELECT *
     FROM (
       SELECT
         e.event_id,
         e.image_id,
         e.release_id,
         e.event_type,
         e.actor_account_id,
         e.reason,
         e.payload,
         e.created,
         a.first_name AS actor_first_name,
         a.last_name AS actor_last_name,
         ROW_NUMBER() OVER (
           PARTITION BY e.image_id
           ORDER BY e.created DESC, e.event_id DESC
         ) AS rn
       FROM rootfs_image_events AS e
       LEFT JOIN accounts AS a ON a.account_id = e.actor_account_id
       WHERE e.image_id = ANY($1::TEXT[])
     ) AS ranked
     WHERE rn <= $2
     ORDER BY image_id ASC, created DESC, event_id DESC`,
    [ids, Math.max(1, Math.min(20, limitPerImage))],
  );
  for (const row of rows) {
    const items = result.get(row.image_id) ?? [];
    items.push(rowToEvent(row));
    result.set(row.image_id, items);
  }
  return result;
}
