/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// A credential's security and audit log (gpu_key_events; step 5c).

import { randomUUID } from "node:crypto";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import type { GPU_KEY_EVENT_ACTIONS } from "@cocalc/util/db-schema/gpu-budgets";

export type GpuKeyEventAction = (typeof GPU_KEY_EVENT_ACTIONS)[number];

export interface GpuKeyEventActor {
  kind: "user" | "admin" | "reaper" | "cleanup";
  account_id?: string;
}

const MAX_NAME = 64;

// A provider-supplied name, safe to keep: printable ASCII, bounded.
export function sanitizeProviderName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const clean = name.replace(/[^\x20-\x7e]/g, "").slice(0, MAX_NAME);
  return clean || undefined;
}

export async function recordKeyEvent(
  {
    credential_id,
    key_owner_account_id,
    actor,
    action,
    details,
  }: {
    credential_id: string;
    key_owner_account_id: string;
    actor: GpuKeyEventActor;
    action: GpuKeyEventAction;
    details?: Record<string, unknown>;
  },
  db: Pick<PoolClient, "query"> = getPool(),
): Promise<void> {
  await db.query(
    `INSERT INTO gpu_key_events (id, credential_id, key_owner_account_id, at,
       actor_kind, actor_account_id, action, details)
     VALUES ($1, $2, $3, now(), $4, $5, $6, $7)`,
    [
      randomUUID(),
      credential_id,
      key_owner_account_id,
      actor.kind,
      actor.account_id ?? null,
      action,
      details ?? null,
    ],
  );
}
