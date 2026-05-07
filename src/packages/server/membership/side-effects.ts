/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  activateMembershipClaimIdentity,
  revokeMembershipClaimIdentity,
} from "@cocalc/server/membership/claim-directory";
import {
  revokeMembershipGrantOnHomeBay,
  upsertMembershipGrantOnHomeBay,
  type MembershipGrantRecord,
} from "@cocalc/server/membership/grants";
import { setProjectUsageAccountIdOnOwningBay } from "@cocalc/server/membership/project-usage";

const logger = getLogger("server:membership:side-effects");

const ENABLED =
  `${process.env.COCALC_MEMBERSHIP_SIDE_EFFECTS_ENABLED ?? "1"}`.trim() !== "0";
const INTERVAL_MS = clampInt(
  process.env.COCALC_MEMBERSHIP_SIDE_EFFECTS_INTERVAL_MS,
  5_000,
  500,
  10 * 60_000,
);
const BATCH_LIMIT = clampInt(
  process.env.COCALC_MEMBERSHIP_SIDE_EFFECTS_BATCH_LIMIT,
  100,
  1,
  10_000,
);
const LEASE_MS = clampInt(
  process.env.COCALC_MEMBERSHIP_SIDE_EFFECTS_LEASE_MS,
  30_000,
  1_000,
  10 * 60_000,
);

const EFFECT_KIND_GRANT_SYNC = "grant-sync";
const EFFECT_KIND_CLAIM_IDENTITY_SYNC = "claim-identity-sync";
const EFFECT_KIND_PROJECT_USAGE_SYNC = "project-usage-sync";

type Queryable = PoolClient | ReturnType<typeof getPool>;

type MembershipGrantSyncPayload =
  | {
      desired_state: "active";
      grant: MembershipGrantRecord;
    }
  | {
      desired_state: "revoked";
      account_id: string;
      grant_id: string;
      revoked_at?: Date | string | null;
    };

type MembershipProjectUsageSyncPayload = {
  project_id: string;
  desired_account_id?: string | null;
  expected_current_usage_account_id?: string | null;
};

type MembershipClaimIdentitySyncPayload =
  | {
      desired_state: "active";
      scope_key: string;
      scope_kind: string;
      canonical_identity: string;
      reservation_id: string;
      account_id: string;
      package_id: string;
      assignment_id: string;
      grant_id?: string | null;
      matched_email_address: string;
      claimed_domain: string;
      metadata?: Record<string, unknown> | null;
    }
  | {
      desired_state: "revoked";
      scope_key: string;
      canonical_identity: string;
      account_id: string;
      assignment_id: string;
      reservation_id?: string;
      revoked_at?: Date | string | null;
    };

type MembershipSideEffectPayload =
  | MembershipGrantSyncPayload
  | MembershipClaimIdentitySyncPayload
  | MembershipProjectUsageSyncPayload;

interface MembershipSideEffectRow {
  effect_key: string;
  owner_account_id: string;
  package_id: string;
  assignment_id: string;
  effect_kind: string;
  desired_payload_json: MembershipSideEffectPayload;
  desired_revision: number;
  applied_revision: number;
  next_attempt_at?: Date | string | null;
  lease_expires_at?: Date | string | null;
  last_attempt_at?: Date | string | null;
  last_error?: string | null;
  attempt_count: number;
  created_at?: Date | string | null;
  updated_at?: Date | string | null;
  completed_at?: Date | string | null;
}

interface ClaimedMembershipSideEffectRow extends MembershipSideEffectRow {
  desired_payload_json: MembershipSideEffectPayload;
}

export interface MembershipSideEffectsPassResult {
  observed_bay_id: string;
  claimed: number;
  applied: number;
  failed: number;
  effect_kinds: Record<string, number>;
}

let timer: NodeJS.Timeout | undefined;
let running = false;

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function getQueryClient(client?: PoolClient): Queryable {
  return client ?? getPool();
}

function membershipGrantEffectKey(assignment_id: string): string {
  return `grant-sync:${assignment_id}`;
}

function membershipProjectUsageEffectKey(assignment_id: string): string {
  return `project-usage-sync:${assignment_id}`;
}

function membershipClaimIdentityEffectKey(assignment_id: string): string {
  return `claim-identity-sync:${assignment_id}`;
}

function nextRetryDelayMs(attempt_count: number): number {
  const exponent = Math.min(Math.max(attempt_count - 1, 0), 6);
  return Math.min(5 * 60_000, 5_000 * 2 ** exponent);
}

async function upsertMembershipSideEffect({
  effect_key,
  owner_account_id,
  package_id,
  assignment_id,
  effect_kind,
  desired_payload_json,
  client,
}: {
  effect_key: string;
  owner_account_id: string;
  package_id: string;
  assignment_id: string;
  effect_kind: string;
  desired_payload_json: MembershipSideEffectPayload;
  client?: PoolClient;
}): Promise<number> {
  const { rows } = await getQueryClient(client).query<{
    desired_revision: number;
  }>(
    `
      INSERT INTO membership_side_effects_outbox
        (
          effect_key,
          owner_account_id,
          package_id,
          assignment_id,
          effect_kind,
          desired_payload_json,
          desired_revision,
          applied_revision,
          next_attempt_at,
          lease_expires_at,
          last_attempt_at,
          last_error,
          attempt_count,
          created_at,
          updated_at,
          completed_at
        )
      VALUES
        ($1, $2, $3, $4, $5, $6::jsonb, 1, 0, NOW(), NULL, NULL, NULL, 0, NOW(), NOW(), NULL)
      ON CONFLICT (effect_key) DO UPDATE SET
        owner_account_id = EXCLUDED.owner_account_id,
        package_id = EXCLUDED.package_id,
        assignment_id = EXCLUDED.assignment_id,
        effect_kind = EXCLUDED.effect_kind,
        desired_payload_json = EXCLUDED.desired_payload_json,
        desired_revision = membership_side_effects_outbox.desired_revision + 1,
        next_attempt_at = NOW(),
        lease_expires_at = NULL,
        last_error = NULL,
        updated_at = NOW(),
        completed_at = CASE
          WHEN membership_side_effects_outbox.applied_revision >= membership_side_effects_outbox.desired_revision + 1
            THEN membership_side_effects_outbox.completed_at
          ELSE NULL
        END
      RETURNING desired_revision
    `,
    [
      effect_key,
      owner_account_id,
      package_id,
      assignment_id,
      effect_kind,
      desired_payload_json,
    ],
  );
  return Number(rows[0]?.desired_revision ?? 0);
}

export async function queueMembershipGrantSyncEffect({
  owner_account_id,
  package_id,
  assignment_id,
  desired_payload,
  client,
}: {
  owner_account_id: string;
  package_id: string;
  assignment_id: string;
  desired_payload: MembershipGrantSyncPayload;
  client?: PoolClient;
}): Promise<number> {
  return await upsertMembershipSideEffect({
    effect_key: membershipGrantEffectKey(assignment_id),
    owner_account_id,
    package_id,
    assignment_id,
    effect_kind: EFFECT_KIND_GRANT_SYNC,
    desired_payload_json: desired_payload,
    client,
  });
}

export async function queueMembershipProjectUsageSyncEffect({
  owner_account_id,
  package_id,
  assignment_id,
  desired_payload,
  client,
}: {
  owner_account_id: string;
  package_id: string;
  assignment_id: string;
  desired_payload: MembershipProjectUsageSyncPayload;
  client?: PoolClient;
}): Promise<number> {
  return await upsertMembershipSideEffect({
    effect_key: membershipProjectUsageEffectKey(assignment_id),
    owner_account_id,
    package_id,
    assignment_id,
    effect_kind: EFFECT_KIND_PROJECT_USAGE_SYNC,
    desired_payload_json: desired_payload,
    client,
  });
}

export async function queueMembershipClaimIdentitySyncEffect({
  owner_account_id,
  package_id,
  assignment_id,
  desired_payload,
  client,
}: {
  owner_account_id: string;
  package_id: string;
  assignment_id: string;
  desired_payload: MembershipClaimIdentitySyncPayload;
  client?: PoolClient;
}): Promise<number> {
  return await upsertMembershipSideEffect({
    effect_key: membershipClaimIdentityEffectKey(assignment_id),
    owner_account_id,
    package_id,
    assignment_id,
    effect_kind: EFFECT_KIND_CLAIM_IDENTITY_SYNC,
    desired_payload_json: desired_payload,
    client,
  });
}

async function claimMembershipSideEffects({
  limit,
  client,
}: {
  limit: number;
  client?: PoolClient;
}): Promise<ClaimedMembershipSideEffectRow[]> {
  const { rows } = await getQueryClient(
    client,
  ).query<ClaimedMembershipSideEffectRow>(
    `
      WITH candidates AS (
        SELECT effect_key
        FROM membership_side_effects_outbox
        WHERE desired_revision > applied_revision
          AND next_attempt_at <= NOW()
          AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
        ORDER BY updated_at, effect_key
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE membership_side_effects_outbox AS o
      SET lease_expires_at = NOW() + ($2 * INTERVAL '1 millisecond'),
          last_attempt_at = NOW(),
          attempt_count = o.attempt_count + 1,
          updated_at = NOW()
      FROM candidates
      WHERE o.effect_key = candidates.effect_key
      RETURNING
        o.effect_key,
        o.owner_account_id,
        o.package_id,
        o.assignment_id,
        o.effect_kind,
        o.desired_payload_json,
        o.desired_revision,
        o.applied_revision,
        o.next_attempt_at,
        o.lease_expires_at,
        o.last_attempt_at,
        o.last_error,
        o.attempt_count,
        o.created_at,
        o.updated_at,
        o.completed_at
    `,
    [limit, LEASE_MS],
  );
  return rows;
}

async function markMembershipSideEffectApplied({
  effect_key,
  applied_revision,
  client,
}: {
  effect_key: string;
  applied_revision: number;
  client?: PoolClient;
}): Promise<void> {
  await getQueryClient(client).query(
    `
      UPDATE membership_side_effects_outbox
      SET applied_revision = GREATEST(applied_revision, $2),
          lease_expires_at = NULL,
          last_error = NULL,
          updated_at = NOW(),
          completed_at = CASE
            WHEN desired_revision <= GREATEST(applied_revision, $2) THEN NOW()
            ELSE NULL
          END
      WHERE effect_key = $1
    `,
    [effect_key, applied_revision],
  );
}

async function markMembershipSideEffectFailed({
  effect_key,
  attempt_count,
  error,
  client,
}: {
  effect_key: string;
  attempt_count: number;
  error: string;
  client?: PoolClient;
}): Promise<void> {
  await getQueryClient(client).query(
    `
      UPDATE membership_side_effects_outbox
      SET lease_expires_at = NULL,
          next_attempt_at = NOW() + ($2 * INTERVAL '1 millisecond'),
          last_error = $3,
          updated_at = NOW()
      WHERE effect_key = $1
    `,
    [effect_key, nextRetryDelayMs(attempt_count), error],
  );
}

async function applyMembershipGrantSyncPayload(
  payload: MembershipGrantSyncPayload,
): Promise<void> {
  if (payload.desired_state === "active") {
    await upsertMembershipGrantOnHomeBay(payload.grant);
    return;
  }
  await revokeMembershipGrantOnHomeBay({
    account_id: payload.account_id,
    grant_id: payload.grant_id,
    revoked_at: payload.revoked_at,
  });
}

async function applyProjectUsageSyncPayload(
  payload: MembershipProjectUsageSyncPayload,
): Promise<void> {
  const updated = await setProjectUsageAccountIdOnOwningBay({
    project_id: payload.project_id,
    account_id: payload.desired_account_id ?? null,
    expected_current_usage_account_id:
      payload.expected_current_usage_account_id,
  });
  if (!updated && payload.desired_account_id != null) {
    throw new Error(
      `project usage sync did not update ${payload.project_id} to ${payload.desired_account_id}`,
    );
  }
}

async function applyMembershipClaimIdentitySyncPayload(
  payload: MembershipClaimIdentitySyncPayload,
): Promise<void> {
  if (payload.desired_state === "active") {
    await activateMembershipClaimIdentity({
      scope_key: payload.scope_key,
      scope_kind: payload.scope_kind,
      canonical_identity: payload.canonical_identity,
      account_id: payload.account_id,
      reservation_id: payload.reservation_id,
      package_id: payload.package_id,
      assignment_id: payload.assignment_id,
      grant_id: payload.grant_id ?? null,
      matched_email_address: payload.matched_email_address,
      claimed_domain: payload.claimed_domain,
      metadata: payload.metadata,
    });
    return;
  }
  await revokeMembershipClaimIdentity({
    scope_key: payload.scope_key,
    canonical_identity: payload.canonical_identity,
    account_id: payload.account_id,
    assignment_id: payload.assignment_id,
    reservation_id: payload.reservation_id,
    revoked_at: payload.revoked_at,
  });
}

async function applyMembershipSideEffect(
  row: ClaimedMembershipSideEffectRow,
): Promise<void> {
  switch (row.effect_kind) {
    case EFFECT_KIND_GRANT_SYNC:
      await applyMembershipGrantSyncPayload(
        row.desired_payload_json as MembershipGrantSyncPayload,
      );
      return;
    case EFFECT_KIND_PROJECT_USAGE_SYNC:
      await applyProjectUsageSyncPayload(
        row.desired_payload_json as MembershipProjectUsageSyncPayload,
      );
      return;
    case EFFECT_KIND_CLAIM_IDENTITY_SYNC:
      await applyMembershipClaimIdentitySyncPayload(
        row.desired_payload_json as MembershipClaimIdentitySyncPayload,
      );
      return;
    default:
      throw new Error(
        `unsupported membership side effect '${row.effect_kind}'`,
      );
  }
}

export async function runMembershipSideEffectsPass({
  limit = BATCH_LIMIT,
  client,
}: {
  limit?: number;
  client?: PoolClient;
} = {}): Promise<MembershipSideEffectsPassResult> {
  const rows = await claimMembershipSideEffects({ limit, client });
  const result: MembershipSideEffectsPassResult = {
    observed_bay_id: getConfiguredBayId(),
    claimed: rows.length,
    applied: 0,
    failed: 0,
    effect_kinds: {},
  };
  for (const row of rows) {
    result.effect_kinds[row.effect_kind] =
      (result.effect_kinds[row.effect_kind] ?? 0) + 1;
    try {
      await applyMembershipSideEffect(row);
      await markMembershipSideEffectApplied({
        effect_key: row.effect_key,
        applied_revision: row.desired_revision,
        client,
      });
      result.applied += 1;
    } catch (err) {
      result.failed += 1;
      await markMembershipSideEffectFailed({
        effect_key: row.effect_key,
        attempt_count: row.attempt_count,
        error: err instanceof Error ? err.message : `${err}`,
        client,
      });
      logger.error("membership side effect replay failed", {
        effect_key: row.effect_key,
        effect_kind: row.effect_kind,
        err,
      });
    }
  }
  return result;
}

export async function runMembershipSideEffectsMaintenanceTick(): Promise<MembershipSideEffectsPassResult | null> {
  if (running) return null;
  running = true;
  try {
    const result = await runMembershipSideEffectsPass();
    if (result.claimed > 0) {
      logger.info("membership side effect maintenance tick", result);
    }
    return result;
  } finally {
    running = false;
  }
}

export function startMembershipSideEffectsMaintenance(): void {
  if (!ENABLED) {
    logger.info("membership side effects maintenance disabled");
    return;
  }
  if (timer) return;
  timer = setInterval(() => {
    void runMembershipSideEffectsMaintenanceTick();
  }, INTERVAL_MS);
  timer.unref?.();
  void runMembershipSideEffectsMaintenanceTick();
  logger.info("membership side effects maintenance started", {
    interval_ms: INTERVAL_MS,
    batch_limit: BATCH_LIMIT,
    lease_ms: LEASE_MS,
  });
}

export function stopMembershipSideEffectsMaintenance(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}

export function resetMembershipSideEffectsMaintenanceStateForTests(): void {
  stopMembershipSideEffectsMaintenance();
  running = false;
}
