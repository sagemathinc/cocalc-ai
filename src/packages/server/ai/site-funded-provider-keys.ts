/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

// The site's provider API keys for site-funded turns (Claude, for now), in
// order, each with its own monthly spend limit and reset point. A turn is
// funded by the first key with room left; a key's month-to-date spend is
// read from the turns it funded, so settlement needs nothing extra. Keys are
// stored encrypted, on the seed bay, and never leave it except to the host
// running a turn the key funds.

import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import {
  decryptSecretStorageValue,
  encryptSecretStorageValue,
} from "@cocalc/database/settings/secret-settings";
import {
  siteFundedKeyPeriodBounds,
  type SiteFundedProviderKeyAction,
  type SiteFundedProviderKeyInfo,
} from "@cocalc/util/ai/site-funded-claude";
import {
  usdToMicrousd,
  type SiteFundedProvider,
} from "@cocalc/util/ai/site-funded-codex";
import { isValidUUID, uuid } from "@cocalc/util/misc";

export type { SiteFundedProviderKeyInfo };

let tableReady: Promise<void> | undefined;

export async function ensureSiteFundedProviderKeyTable(): Promise<void> {
  tableReady ??= (async () => {
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS site_ai_provider_keys (
        key_id UUID PRIMARY KEY,
        provider TEXT NOT NULL,
        label TEXT NOT NULL,
        encrypted_key TEXT NOT NULL,
        key_last4 TEXT NOT NULL,
        monthly_limit_microusd BIGINT NOT NULL
          CHECK (monthly_limit_microusd >= 0),
        reset_day INTEGER NOT NULL CHECK (reset_day BETWEEN 1 AND 28),
        reset_hour INTEGER NOT NULL CHECK (reset_hour BETWEEN 0 AND 23),
        position INTEGER NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
  })().catch((err) => {
    tableReady = undefined;
    throw err;
  });
  await tableReady;
}

const aadName = (keyId: string) => `site_ai_provider_keys:${keyId}`;

function int(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`invalid database integer '${value}'`);
  }
  return parsed;
}

function assertProvider(
  provider: unknown,
): asserts provider is SiteFundedProvider {
  if (provider !== "anthropic") {
    throw new Error("site keys are supported for Anthropic only");
  }
}

function validSettings({
  label,
  monthlyLimitMicrousd,
  resetDay,
  resetHour,
}: {
  label?: string;
  monthlyLimitMicrousd?: number;
  resetDay?: number;
  resetHour?: number;
}) {
  if (label != null && (!label.trim() || label.length > 100)) {
    throw new Error("a key label must be 1-100 characters");
  }
  if (
    monthlyLimitMicrousd != null &&
    (!Number.isSafeInteger(monthlyLimitMicrousd) || monthlyLimitMicrousd < 0)
  ) {
    throw new Error("a key's monthly limit must be a nonnegative amount");
  }
  if (resetDay != null || resetHour != null) {
    // Throws for a day outside 1-28 or an hour outside 0-23.
    siteFundedKeyPeriodBounds({
      resetDay: resetDay ?? 1,
      resetHour: resetHour ?? 0,
    });
  }
}

/** A key's month-to-date exposure: what it paid, plus what running turns may. */
async function keyExposureMicrousd(
  db: Pick<PoolClient, "query">,
  keyId: string,
  periodStart: Date,
): Promise<number> {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(CASE WHEN status = 'active'
               THEN GREATEST(pool_reserved_microusd, committed_microusd)
               ELSE committed_microusd END), 0) AS exposure
     FROM site_ai_turn_reservations
     WHERE provider_key_id = $1 AND started_at >= $2`,
    [keyId, periodStart],
  );
  return int(rows[0]?.exposure);
}

export async function addSiteFundedProviderKey({
  provider,
  label,
  apiKey,
  monthlyLimitMicrousd,
  resetDay,
  resetHour,
}: {
  provider: SiteFundedProvider;
  label: string;
  apiKey: string;
  monthlyLimitMicrousd: number;
  resetDay: number;
  resetHour: number;
}): Promise<string> {
  assertProvider(provider);
  validSettings({ label, monthlyLimitMicrousd, resetDay, resetHour });
  const secret = `${apiKey ?? ""}`.trim();
  if (secret.length < 8 || secret.length > 512 || /\s/.test(secret)) {
    throw new Error("an API key must be 8-512 characters without spaces");
  }
  await ensureSiteFundedProviderKeyTable();
  const keyId = uuid();
  await getPool().query(
    `INSERT INTO site_ai_provider_keys
       (key_id, provider, label, encrypted_key, key_last4,
        monthly_limit_microusd, reset_day, reset_hour, position)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8,
            COALESCE(MAX(position) + 1, 0)
     FROM site_ai_provider_keys WHERE provider = $2`,
    [
      keyId,
      provider,
      label.trim(),
      await encryptSecretStorageValue(aadName(keyId), secret),
      secret.slice(-4),
      monthlyLimitMicrousd,
      resetDay,
      resetHour,
    ],
  );
  return keyId;
}

export async function updateSiteFundedProviderKey({
  keyId,
  label,
  monthlyLimitMicrousd,
  resetDay,
  resetHour,
  position,
  enabled,
}: {
  keyId: string;
  label?: string;
  monthlyLimitMicrousd?: number;
  resetDay?: number;
  resetHour?: number;
  position?: number;
  enabled?: boolean;
}): Promise<void> {
  if (!isValidUUID(keyId)) throw new Error("invalid key id");
  validSettings({ label, monthlyLimitMicrousd, resetDay, resetHour });
  if (position != null && (!Number.isSafeInteger(position) || position < 0)) {
    throw new Error("a key's position must be a nonnegative integer");
  }
  await ensureSiteFundedProviderKeyTable();
  const { rowCount } = await getPool().query(
    `UPDATE site_ai_provider_keys SET
       label = COALESCE($2, label),
       monthly_limit_microusd = COALESCE($3, monthly_limit_microusd),
       reset_day = COALESCE($4, reset_day),
       reset_hour = COALESCE($5, reset_hour),
       position = COALESCE($6, position),
       enabled = COALESCE($7, enabled),
       updated_at = NOW()
     WHERE key_id = $1`,
    [
      keyId,
      label?.trim() ?? null,
      monthlyLimitMicrousd ?? null,
      resetDay ?? null,
      resetHour ?? null,
      position ?? null,
      enabled ?? null,
    ],
  );
  if (!rowCount) throw new Error("site key not found");
}

/**
 * Removes a key from use. Turns it already funded keep their record (and a
 * running one keeps working until it ends, if its host fetched the key).
 */
export async function removeSiteFundedProviderKey(
  keyId: string,
): Promise<void> {
  if (!isValidUUID(keyId)) throw new Error("invalid key id");
  await ensureSiteFundedProviderKeyTable();
  await getPool().query(`DELETE FROM site_ai_provider_keys WHERE key_id = $1`, [
    keyId,
  ]);
}

export async function listSiteFundedProviderKeys(
  provider: SiteFundedProvider,
  now = new Date(),
): Promise<SiteFundedProviderKeyInfo[]> {
  assertProvider(provider);
  await ensureSiteFundedProviderKeyTable();
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT key_id, provider, label, key_last4, monthly_limit_microusd,
            reset_day, reset_hour, position, enabled
     FROM site_ai_provider_keys WHERE provider = $1
     ORDER BY position, created_at`,
    [provider],
  );
  return await Promise.all(
    rows.map(async (row) => {
      const { start, end } = siteFundedKeyPeriodBounds({
        resetDay: int(row.reset_day),
        resetHour: int(row.reset_hour),
        now,
      });
      return {
        keyId: row.key_id,
        provider: row.provider,
        label: row.label,
        last4: row.key_last4,
        monthlyLimitMicrousd: int(row.monthly_limit_microusd),
        resetDay: int(row.reset_day),
        resetHour: int(row.reset_hour),
        position: int(row.position),
        enabled: !!row.enabled,
        periodStart: start.toISOString(),
        periodEnd: end.toISOString(),
        exposureMicrousd: await keyExposureMicrousd(pool, row.key_id, start),
      };
    }),
  );
}

/**
 * Inside an admission transaction: the first enabled key, in order, whose
 * month-to-date exposure leaves room for `requestedMicrousd`. Locks that
 * key's row, so concurrent admissions on one key cannot both pass its limit.
 */
export async function selectSiteFundedProviderKey({
  client,
  provider,
  requestedMicrousd,
  now = new Date(),
}: {
  client: PoolClient;
  provider: SiteFundedProvider;
  requestedMicrousd: number;
  now?: Date;
}): Promise<string | undefined> {
  assertProvider(provider);
  const { rows } = await client.query(
    `SELECT key_id FROM site_ai_provider_keys
     WHERE provider = $1 AND enabled
     ORDER BY position, created_at`,
    [provider],
  );
  for (const { key_id } of rows) {
    const locked = await client.query(
      `SELECT monthly_limit_microusd, reset_day, reset_hour
       FROM site_ai_provider_keys
       WHERE key_id = $1 AND enabled
       FOR UPDATE`,
      [key_id],
    );
    const key = locked.rows[0];
    if (!key) continue;
    const { start } = siteFundedKeyPeriodBounds({
      resetDay: int(key.reset_day),
      resetHour: int(key.reset_hour),
      now,
    });
    const exposure = await keyExposureMicrousd(client, key_id, start);
    if (exposure + requestedMicrousd <= int(key.monthly_limit_microusd)) {
      return key_id;
    }
  }
  return undefined;
}

/** The secret of a key, for the host running a turn it funds. */
export async function getSiteFundedProviderKeySecret(
  keyId: string,
): Promise<string> {
  if (!isValidUUID(keyId)) throw new Error("invalid key id");
  await ensureSiteFundedProviderKeyTable();
  const { rows } = await getPool().query(
    `SELECT encrypted_key FROM site_ai_provider_keys WHERE key_id = $1`,
    [keyId],
  );
  if (!rows[0]) throw new Error("site key not found");
  const { value: secret } = await decryptSecretStorageValue(
    aadName(keyId),
    rows[0].encrypted_key,
  );
  if (!secret) {
    throw new Error("site key could not be decrypted");
  }
  return secret;
}

/**
 * The key funding an active Claude turn, for the host running it: only that
 * host, only while the turn is active, and only the key it was admitted on.
 */
export async function getSiteFundedProviderKeyForReservation({
  reservationId,
  hostId,
}: {
  reservationId: string;
  hostId: string;
}): Promise<string> {
  if (!isValidUUID(reservationId)) throw new Error("invalid reservation id");
  const { rows } = await getPool().query(
    `SELECT host_id, status, provider, provider_key_id,
            expires_at <= NOW() AS expired
     FROM site_ai_turn_reservations WHERE reservation_id = $1`,
    [reservationId],
  );
  const row = rows[0];
  if (!row || `${row.host_id}` !== hostId) {
    throw new Error("site-funded reservation does not belong to host");
  }
  if (row.status !== "active") {
    throw new Error(`site-funded reservation is not active (${row.status})`);
  }
  // Expiry is applied lazily: past its deadline, a turn may still be marked
  // active, but its key is not handed out again.
  if (row.expired) {
    throw new Error("site-funded reservation has expired");
  }
  if (row.provider !== "anthropic" || !row.provider_key_id) {
    throw new Error("site-funded reservation is not funded by a site key");
  }
  return await getSiteFundedProviderKeySecret(row.provider_key_id);
}

function usd(value: number | undefined): number | undefined {
  if (value == null) return undefined;
  if (!Number.isFinite(value)) throw new Error("invalid amount");
  return usdToMicrousd(value);
}

async function reorderSiteFundedProviderKeys(
  provider: SiteFundedProvider,
  keyIds: string[],
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      // Locked in the order admission locks them, so the two cannot deadlock.
      `SELECT key_id FROM site_ai_provider_keys WHERE provider = $1
       ORDER BY position, created_at FOR UPDATE`,
      [provider],
    );
    const current = new Set(rows.map(({ key_id }) => `${key_id}`));
    if (
      !Array.isArray(keyIds) ||
      keyIds.length !== current.size ||
      new Set(keyIds).size !== keyIds.length ||
      keyIds.some((keyId) => !current.has(keyId))
    ) {
      throw new Error("the new order must list every key exactly once");
    }
    for (const [position, keyId] of keyIds.entries()) {
      await client.query(
        `UPDATE site_ai_provider_keys SET position = $2, updated_at = NOW()
         WHERE key_id = $1`,
        [keyId, position],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Applies an admin's change to the site's keys, then lists them. */
export async function manageSiteFundedProviderKeys(
  provider: SiteFundedProvider,
  action?: SiteFundedProviderKeyAction,
): Promise<SiteFundedProviderKeyInfo[]> {
  assertProvider(provider);
  await ensureSiteFundedProviderKeyTable();
  switch (action?.op) {
    case undefined:
      break;
    case "add":
      await addSiteFundedProviderKey({
        provider,
        label: action.label,
        apiKey: action.apiKey,
        monthlyLimitMicrousd: usd(action.monthlyLimitUsd)!,
        resetDay: action.resetDay,
        resetHour: action.resetHour,
      });
      break;
    case "update":
      await updateSiteFundedProviderKey({
        keyId: action.keyId,
        label: action.label,
        monthlyLimitMicrousd: usd(action.monthlyLimitUsd),
        resetDay: action.resetDay,
        resetHour: action.resetHour,
        enabled: action.enabled,
      });
      break;
    case "remove":
      await removeSiteFundedProviderKey(action.keyId);
      break;
    case "reorder":
      await reorderSiteFundedProviderKeys(provider, action.keyIds);
      break;
    default:
      throw new Error("unknown site key action");
  }
  return await listSiteFundedProviderKeys(provider);
}
