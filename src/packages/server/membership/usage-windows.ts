/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";

export type AccountUsageWindowScope = "membership";
export type AccountUsageWindowName = "5h" | "7d";

export interface AccountUsageWindow {
  id: string;
  account_id: string;
  scope: AccountUsageWindowScope;
  window: AccountUsageWindowName;
  epoch: number;
  starts_at: Date;
  resets_at: Date;
}

export interface AccountUsageEpoch {
  scope: AccountUsageWindowScope;
  window: AccountUsageWindowName;
  epoch: number;
}

const MEMBERSHIP_USAGE_SCOPE: AccountUsageWindowScope = "membership";
const WINDOWS: readonly AccountUsageWindowName[] = ["5h", "7d"];
const WINDOW_MS: Record<AccountUsageWindowName, number> = {
  "5h": 5 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

const WINDOWS_TABLE = "account_usage_windows";
const EPOCHS_TABLE = "account_usage_epochs";
const RESET_TABLE = "account_usage_epoch_resets";
const EPOCH_CACHE_TTL_MS = 5_000;

let ensuredSchema: Promise<void> | undefined;
const epochCache = new Map<
  AccountUsageWindowName,
  { expires_at: number; value: Promise<AccountUsageEpoch> }
>();

// The table column is still named "family" for schema compatibility, but the
// user-visible account windows intentionally have a single shared scope.

function normalizeDate(value: Date | string | undefined): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date;
  }
  return new Date();
}

function mapWindowRow(row: {
  id: string;
  account_id: string;
  family: AccountUsageWindowScope;
  window: AccountUsageWindowName;
  epoch: number | string;
  starts_at: Date | string;
  resets_at: Date | string;
}): AccountUsageWindow {
  return {
    id: row.id,
    account_id: row.account_id,
    scope: row.family,
    window: row.window,
    epoch: Number(row.epoch),
    starts_at: new Date(row.starts_at),
    resets_at: new Date(row.resets_at),
  };
}

export async function ensureAccountUsageWindowSchema(
  client?: Pick<PoolClient, "query">,
): Promise<void> {
  if (!ensuredSchema || client) {
    const pending = (async () => {
      await (client ?? getPool()).query(`
        CREATE TABLE IF NOT EXISTS ${WINDOWS_TABLE} (
          id UUID PRIMARY KEY,
          account_id UUID NOT NULL,
          family TEXT NOT NULL,
          "window" TEXT NOT NULL,
          epoch BIGINT NOT NULL,
          starts_at TIMESTAMPTZ NOT NULL,
          resets_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await (client ?? getPool()).query(
        `CREATE INDEX IF NOT EXISTS ${WINDOWS_TABLE}_account_family_window_idx ON ${WINDOWS_TABLE}(account_id, family, "window", epoch, resets_at DESC)`,
      );
      await (client ?? getPool()).query(
        `CREATE INDEX IF NOT EXISTS ${WINDOWS_TABLE}_resets_idx ON ${WINDOWS_TABLE}(resets_at DESC)`,
      );
      await (client ?? getPool()).query(`
        CREATE TABLE IF NOT EXISTS ${EPOCHS_TABLE} (
          family TEXT NOT NULL,
          "window" TEXT NOT NULL,
          epoch BIGINT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_by UUID,
          reason TEXT,
          PRIMARY KEY (family, "window")
        )
      `);
      await (client ?? getPool()).query(`
        CREATE TABLE IF NOT EXISTS ${RESET_TABLE} (
          id UUID PRIMARY KEY,
          family TEXT NOT NULL,
          "window" TEXT NOT NULL,
          previous_epoch BIGINT NOT NULL,
          new_epoch BIGINT NOT NULL,
          reset_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          reset_by UUID,
          reason TEXT NOT NULL
        )
      `);
      await (client ?? getPool()).query(
        `CREATE INDEX IF NOT EXISTS ${RESET_TABLE}_family_window_idx ON ${RESET_TABLE}(family, "window", reset_at DESC)`,
      );
    })();
    if (!client) ensuredSchema = pending;
    await pending;
  }
  await ensuredSchema;
}

async function loadAccountUsageEpoch({
  window,
  client,
}: {
  window: AccountUsageWindowName;
  client?: PoolClient;
}): Promise<AccountUsageEpoch> {
  await ensureAccountUsageWindowSchema();
  await (client ?? getPool("medium")).query(
    `
      INSERT INTO ${EPOCHS_TABLE}
        (family, "window", epoch, reason)
      VALUES
        ($1, $2, 1, 'initial')
      ON CONFLICT (family, "window") DO NOTHING
    `,
    [MEMBERSHIP_USAGE_SCOPE, window],
  );
  const { rows } = await (client ?? getPool("short")).query<{
    family: AccountUsageWindowScope;
    window: AccountUsageWindowName;
    epoch: string | number;
  }>(
    `
      SELECT family, "window" AS window, epoch
      FROM ${EPOCHS_TABLE}
      WHERE family = $1 AND "window" = $2
      ${client ? "FOR SHARE" : ""}
    `,
    [MEMBERSHIP_USAGE_SCOPE, window],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`unable to initialize usage epoch for ${window}`);
  }
  return {
    scope: row.family,
    window: row.window,
    epoch: Number(row.epoch),
  };
}

export async function getAccountUsageEpoch({
  window,
  client,
}: {
  window: AccountUsageWindowName;
  client?: PoolClient;
}): Promise<AccountUsageEpoch> {
  // Financial admission must see the current epoch, and keep it stable through
  // commit. Never reuse or populate the process cache from a transaction.
  if (client) return await loadAccountUsageEpoch({ window, client });
  const cached = epochCache.get(window);
  if (cached != null && cached.expires_at > Date.now()) {
    return await cached.value;
  }
  const value = loadAccountUsageEpoch({ window }).catch((err) => {
    if (epochCache.get(window)?.value === value) {
      epochCache.delete(window);
    }
    throw err;
  });
  epochCache.set(window, {
    expires_at: Date.now() + EPOCH_CACHE_TTL_MS,
    value,
  });
  return await value;
}

export async function getActiveAccountUsageWindow({
  account_id,
  window,
  at,
  create = false,
  client,
}: {
  account_id: string;
  window: AccountUsageWindowName;
  at?: Date | string;
  create?: boolean;
  client?: PoolClient;
}): Promise<AccountUsageWindow | undefined> {
  const time = normalizeDate(at);
  const { epoch } = await getAccountUsageEpoch({ window, client });
  const existing = await selectActiveAccountUsageWindow({
    account_id,
    window,
    epoch,
    at: time,
    client,
  });
  if (existing || !create) return existing;

  const startsAt = time;
  const resetsAt = new Date(startsAt.getTime() + WINDOW_MS[window]);
  const { rows } = await (client ?? getPool("medium")).query<{
    id: string;
    account_id: string;
    family: AccountUsageWindowScope;
    window: AccountUsageWindowName;
    epoch: string | number;
    starts_at: Date | string;
    resets_at: Date | string;
  }>(
    `
      INSERT INTO ${WINDOWS_TABLE}
        (id, account_id, family, "window", epoch, starts_at, resets_at)
      VALUES
        (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
      RETURNING id, account_id, family, "window" AS window, epoch, starts_at, resets_at
    `,
    [account_id, MEMBERSHIP_USAGE_SCOPE, window, epoch, startsAt, resetsAt],
  );
  return mapWindowRow(rows[0]);
}

async function selectActiveAccountUsageWindow({
  account_id,
  window,
  epoch,
  at,
  client,
}: {
  account_id: string;
  window: AccountUsageWindowName;
  epoch: number;
  at: Date;
  client?: PoolClient;
}): Promise<AccountUsageWindow | undefined> {
  const { rows } = await (client ?? getPool("short")).query<{
    id: string;
    account_id: string;
    family: AccountUsageWindowScope;
    window: AccountUsageWindowName;
    epoch: string | number;
    starts_at: Date | string;
    resets_at: Date | string;
  }>(
    `
      SELECT id, account_id, family, "window" AS window, epoch, starts_at, resets_at
      FROM ${WINDOWS_TABLE}
      WHERE account_id = $1
        AND family = $2
        AND "window" = $3
        AND epoch = $4
        AND starts_at <= $5
        AND resets_at > $5
      ORDER BY starts_at DESC, created_at DESC
      LIMIT 1
    `,
    [account_id, MEMBERSHIP_USAGE_SCOPE, window, epoch, at],
  );
  return rows[0] ? mapWindowRow(rows[0]) : undefined;
}

async function selectActiveAccountUsageWindows({
  account_id,
  epochs,
  at,
  client,
}: {
  account_id: string;
  epochs: Record<AccountUsageWindowName, number>;
  at: Date;
  client?: PoolClient;
}): Promise<Partial<Record<AccountUsageWindowName, AccountUsageWindow>>> {
  const { rows } = await (client ?? getPool("short")).query<{
    id: string;
    account_id: string;
    family: AccountUsageWindowScope;
    window: AccountUsageWindowName;
    epoch: string | number;
    starts_at: Date | string;
    resets_at: Date | string;
  }>(
    `
      SELECT DISTINCT ON ("window")
        id, account_id, family, "window" AS window, epoch, starts_at, resets_at
      FROM ${WINDOWS_TABLE}
      WHERE account_id = $1
        AND family = $2
        AND (
          ("window" = '5h' AND epoch = $3)
          OR ("window" = '7d' AND epoch = $4)
        )
        AND starts_at <= $5
        AND resets_at > $5
      ORDER BY "window", starts_at DESC, created_at DESC
    `,
    [account_id, MEMBERSHIP_USAGE_SCOPE, epochs["5h"], epochs["7d"], at],
  );
  const result: Partial<Record<AccountUsageWindowName, AccountUsageWindow>> =
    {};
  for (const row of rows) {
    result[row.window] = mapWindowRow(row);
  }
  return result;
}

export async function getActiveAccountUsageWindows({
  account_id,
  at,
  create = false,
  client,
}: {
  account_id: string;
  at?: Date | string;
  create?: boolean;
  client?: PoolClient;
}): Promise<Partial<Record<AccountUsageWindowName, AccountUsageWindow>>> {
  const time = normalizeDate(at);
  const [epoch5h, epoch7d] = await Promise.all(
    WINDOWS.map(
      async (window) => await getAccountUsageEpoch({ window, client }),
    ),
  );
  const result = await selectActiveAccountUsageWindows({
    account_id,
    at: time,
    epochs: {
      "5h": epoch5h.epoch,
      "7d": epoch7d.epoch,
    },
    client,
  });
  if (!create) return result;
  for (const window of WINDOWS) {
    result[window] ??= await getActiveAccountUsageWindow({
      account_id,
      window,
      at: time,
      create: true,
      client,
    });
  }
  return result;
}

export async function ensureAccountUsageWindowsForEvent({
  account_id,
  occurred_at,
  client,
}: {
  account_id: string;
  occurred_at?: Date | string;
  client?: PoolClient;
}): Promise<Record<AccountUsageWindowName, AccountUsageWindow>> {
  const windows = await getActiveAccountUsageWindows({
    account_id,
    at: occurred_at,
    create: true,
    client,
  });
  const window5h = windows["5h"];
  const window7d = windows["7d"];
  if (!window5h || !window7d) {
    throw new Error("unable to create usage windows");
  }
  return { "5h": window5h, "7d": window7d };
}

export async function resetAccountUsageEpoch({
  window,
  reset_by,
  reason,
}: {
  window: AccountUsageWindowName;
  reset_by?: string;
  reason: string;
}): Promise<AccountUsageEpoch> {
  const trimmedReason = reason.trim();
  if (!trimmedReason) {
    throw new Error("reset reason must be specified");
  }
  const current = await getAccountUsageEpoch({ window });
  const newEpoch = current.epoch + 1;
  await getPool("medium").query(
    `
      UPDATE ${EPOCHS_TABLE}
      SET epoch = $3,
          updated_at = now(),
          updated_by = $4,
          reason = $5
      WHERE family = $1 AND "window" = $2
    `,
    [MEMBERSHIP_USAGE_SCOPE, window, newEpoch, reset_by ?? null, trimmedReason],
  );
  await getPool("medium").query(
    `
      INSERT INTO ${RESET_TABLE}
        (id, family, "window", previous_epoch, new_epoch, reset_by, reason)
      VALUES
        (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
    `,
    [
      MEMBERSHIP_USAGE_SCOPE,
      window,
      current.epoch,
      newEpoch,
      reset_by ?? null,
      trimmedReason,
    ],
  );
  epochCache.delete(window);
  return { scope: MEMBERSHIP_USAGE_SCOPE, window, epoch: newEpoch };
}
