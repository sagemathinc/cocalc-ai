/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";

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

let ensuredSchema: Promise<void> | undefined;

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

export async function ensureAccountUsageWindowSchema(): Promise<void> {
  if (!ensuredSchema) {
    ensuredSchema = (async () => {
      await getPool().query(`
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
      await getPool().query(
        `CREATE INDEX IF NOT EXISTS ${WINDOWS_TABLE}_account_family_window_idx ON ${WINDOWS_TABLE}(account_id, family, "window", epoch, resets_at DESC)`,
      );
      await getPool().query(
        `CREATE INDEX IF NOT EXISTS ${WINDOWS_TABLE}_resets_idx ON ${WINDOWS_TABLE}(resets_at DESC)`,
      );
      await getPool().query(`
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
      await getPool().query(`
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
      await getPool().query(
        `CREATE INDEX IF NOT EXISTS ${RESET_TABLE}_family_window_idx ON ${RESET_TABLE}(family, "window", reset_at DESC)`,
      );
    })();
  }
  await ensuredSchema;
}

export async function getAccountUsageEpoch({
  window,
}: {
  window: AccountUsageWindowName;
}): Promise<AccountUsageEpoch> {
  await ensureAccountUsageWindowSchema();
  await getPool("medium").query(
    `
      INSERT INTO ${EPOCHS_TABLE}
        (family, "window", epoch, reason)
      VALUES
        ($1, $2, 1, 'initial')
      ON CONFLICT (family, "window") DO NOTHING
    `,
    [MEMBERSHIP_USAGE_SCOPE, window],
  );
  const { rows } = await getPool("short").query<{
    family: AccountUsageWindowScope;
    window: AccountUsageWindowName;
    epoch: string | number;
  }>(
    `
      SELECT family, "window" AS window, epoch
      FROM ${EPOCHS_TABLE}
      WHERE family = $1 AND "window" = $2
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

export async function getActiveAccountUsageWindow({
  account_id,
  window,
  at,
  create = false,
}: {
  account_id: string;
  window: AccountUsageWindowName;
  at?: Date | string;
  create?: boolean;
}): Promise<AccountUsageWindow | undefined> {
  const time = normalizeDate(at);
  const { epoch } = await getAccountUsageEpoch({ window });
  const existing = await selectActiveAccountUsageWindow({
    account_id,
    window,
    epoch,
    at: time,
  });
  if (existing || !create) return existing;

  const startsAt = time;
  const resetsAt = new Date(startsAt.getTime() + WINDOW_MS[window]);
  const { rows } = await getPool("medium").query<{
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
}: {
  account_id: string;
  window: AccountUsageWindowName;
  epoch: number;
  at: Date;
}): Promise<AccountUsageWindow | undefined> {
  const { rows } = await getPool("short").query<{
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

export async function getActiveAccountUsageWindows({
  account_id,
  at,
  create = false,
}: {
  account_id: string;
  at?: Date | string;
  create?: boolean;
}): Promise<Partial<Record<AccountUsageWindowName, AccountUsageWindow>>> {
  const result: Partial<Record<AccountUsageWindowName, AccountUsageWindow>> =
    {};
  for (const window of WINDOWS) {
    result[window] = await getActiveAccountUsageWindow({
      account_id,
      window,
      at,
      create,
    });
  }
  return result;
}

export async function ensureAccountUsageWindowsForEvent({
  account_id,
  occurred_at,
}: {
  account_id: string;
  occurred_at?: Date | string;
}): Promise<Record<AccountUsageWindowName, AccountUsageWindow>> {
  const windows = await getActiveAccountUsageWindows({
    account_id,
    at: occurred_at,
    create: true,
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
  return { scope: MEMBERSHIP_USAGE_SCOPE, window, epoch: newEpoch };
}
