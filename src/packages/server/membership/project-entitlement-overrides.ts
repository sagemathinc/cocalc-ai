/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";

import getPool, { type PoolClient } from "@cocalc/database/pool";
import type {
  NumericLimitRule,
  ProjectDefaultOverrides,
} from "@cocalc/conat/hub/api/purchases";
import type { ProjectEntitlementOverride } from "@cocalc/conat/hub/api/projects";
import type { Quota } from "@cocalc/util/upgrades/quota";

import { applyNumericLimitRule } from "./entitlement-overrides";

export type ProjectEntitlementOverrideInput = Omit<
  Partial<ProjectEntitlementOverride>,
  "project_id" | "updated_by" | "updated_at"
>;

const NUMERIC_RULE_MODES = new Set(["minimum", "maximum", "set"]);
const PROJECT_DEFAULT_KEYS = [
  "disk_quota",
  "memory",
  "memory_request",
] as const satisfies readonly (keyof ProjectDefaultOverrides)[];
const PROJECT_DEFAULT_KEY_SET = new Set<string>(PROJECT_DEFAULT_KEYS);
let schemaReady: Promise<void> | undefined;

async function ensureProjectEntitlementOverrideSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const pool = getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_entitlement_overrides (
        project_id UUID PRIMARY KEY,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        project_defaults JSONB NOT NULL DEFAULT '{}'::JSONB,
        reason TEXT,
        source VARCHAR(64),
        metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        expires_at TIMESTAMP,
        updated_by UUID,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS project_entitlement_overrides_enabled_idx
        ON project_entitlement_overrides(enabled)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS project_entitlement_overrides_expires_at_idx
        ON project_entitlement_overrides(expires_at)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS project_entitlement_overrides_updated_by_idx
        ON project_entitlement_overrides(updated_by)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS project_entitlement_overrides_updated_at_idx
        ON project_entitlement_overrides(updated_at)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_entitlement_override_events (
        id UUID PRIMARY KEY,
        project_id UUID NOT NULL,
        action VARCHAR(32) NOT NULL,
        old_value JSONB,
        new_value JSONB,
        reason TEXT NOT NULL,
        actor_account_id UUID,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS project_entitlement_override_events_project_id_idx
        ON project_entitlement_override_events(project_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS project_entitlement_override_events_actor_account_id_idx
        ON project_entitlement_override_events(actor_account_id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS project_entitlement_override_events_action_idx
        ON project_entitlement_override_events(action)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS project_entitlement_override_events_created_at_idx
        ON project_entitlement_override_events(created_at)
    `);
  })();
  await schemaReady;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeNumericRule(
  value: unknown,
  path: string,
): NumericLimitRule | undefined {
  if (value == null) return undefined;
  if (!isObject(value)) {
    throw Error(`${path} must be a numeric limit rule`);
  }
  const mode = value.mode;
  const ruleValue = value.value;
  if (typeof mode !== "string" || !NUMERIC_RULE_MODES.has(mode)) {
    throw Error(`${path}.mode must be minimum, maximum, or set`);
  }
  if (
    typeof ruleValue !== "number" ||
    !Number.isFinite(ruleValue) ||
    ruleValue < 0
  ) {
    throw Error(`${path}.value must be a nonnegative finite number`);
  }
  return {
    mode: mode as NumericLimitRule["mode"],
    value: ruleValue,
  };
}

function normalizeProjectDefaults(
  value: unknown,
): ProjectDefaultOverrides | undefined {
  if (value == null) return undefined;
  if (!isObject(value)) throw Error("project_defaults must be an object");
  for (const key of Object.keys(value)) {
    if (!PROJECT_DEFAULT_KEY_SET.has(key)) {
      throw Error(`project_defaults.${key} is not a supported override key`);
    }
  }
  const projectDefaults: ProjectDefaultOverrides = {};
  for (const key of PROJECT_DEFAULT_KEYS) {
    const rule = normalizeNumericRule(value[key], `project_defaults.${key}`);
    if (rule) {
      projectDefaults[key] = rule;
    }
  }
  return projectDefaults;
}

function normalizeProjectEntitlementOverride(
  row: any,
): ProjectEntitlementOverride | undefined {
  if (!row) return undefined;
  const project_defaults = normalizeProjectDefaults(row.project_defaults);
  const metadata =
    row.metadata != null && isObject(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {};
  return {
    project_id: row.project_id,
    enabled: row.enabled !== false,
    ...(project_defaults == null ? {} : { project_defaults }),
    reason: row.reason ?? null,
    source: row.source ?? null,
    metadata,
    expires_at: row.expires_at ?? null,
    updated_by: row.updated_by ?? null,
    updated_at: row.updated_at ?? new Date().toISOString(),
  };
}

function requireOverrideReason(reason?: string | null): string {
  const trimmed = `${reason ?? ""}`.trim();
  if (!trimmed) {
    throw Error("reason is required");
  }
  return trimmed;
}

export async function getActiveProjectEntitlementOverride(
  project_id: string,
  client?: PoolClient,
): Promise<ProjectEntitlementOverride | undefined> {
  await ensureProjectEntitlementOverrideSchema();
  const pool = client ?? getPool();
  const { rows } = await pool.query(
    `SELECT project_id, enabled, project_defaults, reason, source, metadata,
            expires_at, updated_by, updated_at
       FROM project_entitlement_overrides
      WHERE project_id=$1
        AND enabled IS TRUE
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1`,
    [project_id],
  );
  return normalizeProjectEntitlementOverride(rows[0]);
}

export async function getProjectEntitlementOverrideLocal(
  project_id: string,
  client?: PoolClient,
): Promise<ProjectEntitlementOverride | undefined> {
  await ensureProjectEntitlementOverrideSchema();
  const pool = client ?? getPool();
  const { rows } = await pool.query(
    `SELECT project_id, enabled, project_defaults, reason, source, metadata,
            expires_at, updated_by, updated_at
       FROM project_entitlement_overrides
      WHERE project_id=$1`,
    [project_id],
  );
  return normalizeProjectEntitlementOverride(rows[0]);
}

export async function setProjectEntitlementOverrideLocal({
  project_id,
  actor_account_id,
  override,
  reason,
  source,
}: {
  project_id: string;
  actor_account_id?: string | null;
  override: ProjectEntitlementOverrideInput;
  reason: string;
  source?: string | null;
}): Promise<ProjectEntitlementOverride> {
  await ensureProjectEntitlementOverrideSchema();
  const finalReason = requireOverrideReason(reason);
  const updated_at = new Date();
  const normalized = normalizeProjectEntitlementOverride({
    project_id,
    enabled: override.enabled ?? true,
    project_defaults: override.project_defaults ?? {},
    reason: finalReason,
    source: source ?? override.source ?? "admin",
    metadata: override.metadata ?? {},
    expires_at: override.expires_at ?? null,
    updated_by: actor_account_id ?? null,
    updated_at,
  })!;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const oldValue = await getProjectEntitlementOverrideLocal(
      project_id,
      client,
    );
    const { rows } = await client.query(
      `INSERT INTO project_entitlement_overrides (
         project_id, enabled, project_defaults, reason, source, metadata,
         expires_at, updated_by, updated_at
       )
       VALUES ($1,$2,$3::JSONB,$4,$5,$6::JSONB,$7,$8,$9)
       ON CONFLICT (project_id)
       DO UPDATE SET
         enabled=EXCLUDED.enabled,
         project_defaults=EXCLUDED.project_defaults,
         reason=EXCLUDED.reason,
         source=EXCLUDED.source,
         metadata=EXCLUDED.metadata,
         expires_at=EXCLUDED.expires_at,
         updated_by=EXCLUDED.updated_by,
         updated_at=EXCLUDED.updated_at
       RETURNING project_id, enabled, project_defaults, reason, source,
                 metadata, expires_at, updated_by, updated_at`,
      [
        normalized.project_id,
        normalized.enabled,
        JSON.stringify(normalized.project_defaults ?? {}),
        normalized.reason,
        normalized.source,
        JSON.stringify(normalized.metadata ?? {}),
        normalized.expires_at ?? null,
        normalized.updated_by ?? null,
        normalized.updated_at,
      ],
    );
    const newValue = normalizeProjectEntitlementOverride(rows[0])!;
    await client.query(
      `INSERT INTO project_entitlement_override_events (
         id, project_id, action, old_value, new_value, reason,
         actor_account_id, created_at
       )
       VALUES ($1,$2,$3,$4::JSONB,$5::JSONB,$6,$7,NOW())`,
      [
        randomUUID(),
        project_id,
        "set",
        oldValue ? JSON.stringify(oldValue) : null,
        JSON.stringify(newValue),
        finalReason,
        actor_account_id ?? null,
      ],
    );
    await client.query("COMMIT");
    return newValue;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function clearProjectEntitlementOverrideLocal({
  project_id,
  actor_account_id,
  reason,
}: {
  project_id: string;
  actor_account_id?: string | null;
  reason: string;
}): Promise<void> {
  await ensureProjectEntitlementOverrideSchema();
  const finalReason = requireOverrideReason(reason);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const oldValue = await getProjectEntitlementOverrideLocal(
      project_id,
      client,
    );
    await client.query(
      `DELETE FROM project_entitlement_overrides WHERE project_id=$1`,
      [project_id],
    );
    await client.query(
      `INSERT INTO project_entitlement_override_events (
         id, project_id, action, old_value, new_value, reason,
         actor_account_id, created_at
       )
       VALUES ($1,$2,$3,$4::JSONB,$5::JSONB,$6,$7,NOW())`,
      [
        randomUUID(),
        project_id,
        "clear",
        oldValue ? JSON.stringify(oldValue) : null,
        null,
        finalReason,
        actor_account_id ?? null,
      ],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function numberFromUnknown(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export async function applyProjectEntitlementOverrideToRunQuota({
  project_id,
  run_quota,
}: {
  project_id: string;
  run_quota: Quota;
}): Promise<Quota> {
  const override = await getActiveProjectEntitlementOverride(project_id);
  const projectDefaults = override?.project_defaults;
  if (projectDefaults == null) return run_quota;
  const result: Quota = { ...run_quota };
  for (const key of PROJECT_DEFAULT_KEYS) {
    const rule = projectDefaults[key] as NumericLimitRule | undefined;
    const value = applyNumericLimitRule(
      numberFromUnknown((result as Record<string, unknown>)[key]),
      rule,
    );
    if (value != null) {
      (result as Record<string, number>)[key] = value;
    }
  }
  return result;
}
