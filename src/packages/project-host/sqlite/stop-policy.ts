/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getDatabase, initDatabase } from "@cocalc/lite/hub/sqlite/database";
import type {
  HostProjectStopOverride,
  HostProjectStopPolicyRow,
} from "@cocalc/conat/project-host/api";

export interface ProjectStopPolicyRow extends HostProjectStopPolicyRow {
  updated_at?: number;
}

export interface ProjectStopStateRow {
  project_id: string;
  last_started_ms?: number | null;
  last_pressure_stop_ms?: number | null;
  pressure_cooldown_until_ms?: number | null;
  last_ranked_ms?: number | null;
  last_decision_reason?: string | null;
  last_decision_pressure_zone?: string | null;
  updated_at?: number;
}

function normalizeStopOverride(
  value: unknown,
): HostProjectStopOverride | undefined {
  switch (`${value ?? ""}`.trim()) {
    case "protect":
      return "protect";
    case "deprioritize":
      return "deprioritize";
    case "default":
      return "default";
    default:
      return;
  }
}

function ensureStopPolicyTables() {
  const db = initDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_stop_policy (
      project_id TEXT PRIMARY KEY,
      owner_account_id TEXT,
      shared_compute_priority INTEGER NOT NULL,
      authoritative_last_edited_ms INTEGER,
      policy_updated_ms INTEGER NOT NULL,
      stop_override TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_stop_state (
      project_id TEXT PRIMARY KEY,
      last_started_ms INTEGER,
      last_pressure_stop_ms INTEGER,
      pressure_cooldown_until_ms INTEGER,
      last_ranked_ms INTEGER,
      last_decision_reason TEXT,
      last_decision_pressure_zone TEXT,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS project_stop_policy_updated_idx ON project_stop_policy(policy_updated_ms)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS project_stop_state_cooldown_idx ON project_stop_state(pressure_cooldown_until_ms)",
  );
}

export function upsertProjectStopPolicy(row: ProjectStopPolicyRow): void {
  ensureStopPolicyTables();
  const db = getDatabase();
  const now = Date.now();
  db.prepare(
    `
      INSERT INTO project_stop_policy(
        project_id,
        owner_account_id,
        shared_compute_priority,
        authoritative_last_edited_ms,
        policy_updated_ms,
        stop_override,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        owner_account_id=excluded.owner_account_id,
        shared_compute_priority=excluded.shared_compute_priority,
        authoritative_last_edited_ms=excluded.authoritative_last_edited_ms,
        policy_updated_ms=excluded.policy_updated_ms,
        stop_override=excluded.stop_override,
        updated_at=excluded.updated_at
      WHERE excluded.policy_updated_ms >= project_stop_policy.policy_updated_ms
    `,
  ).run(
    row.project_id,
    row.owner_account_id ?? null,
    Math.max(0, Math.floor(Number(row.shared_compute_priority ?? 0) || 0)),
    row.authoritative_last_edited_ms != null
      ? Math.max(0, Math.floor(Number(row.authoritative_last_edited_ms) || 0))
      : null,
    Math.max(0, Math.floor(Number(row.policy_updated_ms ?? 0) || 0)),
    normalizeStopOverride(row.stop_override) ?? "default",
    row.updated_at ?? now,
  );
}

export function getProjectStopPolicy(
  project_id: string,
): ProjectStopPolicyRow | undefined {
  ensureStopPolicyTables();
  const db = getDatabase();
  return db
    .prepare(
      `
        SELECT
          project_id,
          owner_account_id,
          shared_compute_priority,
          authoritative_last_edited_ms,
          policy_updated_ms,
          stop_override,
          updated_at
        FROM project_stop_policy
        WHERE project_id=?
      `,
    )
    .get(project_id) as ProjectStopPolicyRow | undefined;
}

export function listProjectStopPolicies(): ProjectStopPolicyRow[] {
  ensureStopPolicyTables();
  const db = getDatabase();
  return db
    .prepare(
      `
        SELECT
          project_id,
          owner_account_id,
          shared_compute_priority,
          authoritative_last_edited_ms,
          policy_updated_ms,
          stop_override,
          updated_at
        FROM project_stop_policy
        ORDER BY project_id
      `,
    )
    .all() as ProjectStopPolicyRow[];
}

export function upsertProjectStopState(row: ProjectStopStateRow): void {
  ensureStopPolicyTables();
  const db = getDatabase();
  const existing: Partial<ProjectStopStateRow> =
    (db
      .prepare(
        `
          SELECT
            last_started_ms,
            last_pressure_stop_ms,
            pressure_cooldown_until_ms,
            last_ranked_ms,
            last_decision_reason,
            last_decision_pressure_zone
          FROM project_stop_state
          WHERE project_id=?
        `,
      )
      .get(row.project_id) as ProjectStopStateRow | undefined) ?? {};
  const now = Date.now();
  const hasOwn = (key: keyof ProjectStopStateRow): boolean =>
    Object.prototype.hasOwnProperty.call(row, key);
  const nextLastStartedMs = hasOwn("last_started_ms")
    ? (row.last_started_ms ?? null)
    : (existing.last_started_ms ?? null);
  const nextLastPressureStopMs = hasOwn("last_pressure_stop_ms")
    ? (row.last_pressure_stop_ms ?? null)
    : (existing.last_pressure_stop_ms ?? null);
  const nextPressureCooldownUntilMs = hasOwn("pressure_cooldown_until_ms")
    ? (row.pressure_cooldown_until_ms ?? null)
    : (existing.pressure_cooldown_until_ms ?? null);
  const nextLastRankedMs = hasOwn("last_ranked_ms")
    ? (row.last_ranked_ms ?? null)
    : (existing.last_ranked_ms ?? null);
  const nextLastDecisionReason = hasOwn("last_decision_reason")
    ? (row.last_decision_reason ?? null)
    : (existing.last_decision_reason ?? null);
  const nextLastDecisionPressureZone = hasOwn("last_decision_pressure_zone")
    ? (row.last_decision_pressure_zone ?? null)
    : (existing.last_decision_pressure_zone ?? null);
  db.prepare(
    `
      INSERT INTO project_stop_state(
        project_id,
        last_started_ms,
        last_pressure_stop_ms,
        pressure_cooldown_until_ms,
        last_ranked_ms,
        last_decision_reason,
        last_decision_pressure_zone,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        last_started_ms=excluded.last_started_ms,
        last_pressure_stop_ms=excluded.last_pressure_stop_ms,
        pressure_cooldown_until_ms=excluded.pressure_cooldown_until_ms,
        last_ranked_ms=excluded.last_ranked_ms,
        last_decision_reason=excluded.last_decision_reason,
        last_decision_pressure_zone=excluded.last_decision_pressure_zone,
        updated_at=excluded.updated_at
    `,
  ).run(
    row.project_id,
    nextLastStartedMs,
    nextLastPressureStopMs,
    nextPressureCooldownUntilMs,
    nextLastRankedMs,
    nextLastDecisionReason,
    nextLastDecisionPressureZone,
    row.updated_at ?? now,
  );
}

export function getProjectStopState(
  project_id: string,
): ProjectStopStateRow | undefined {
  ensureStopPolicyTables();
  const db = getDatabase();
  return db
    .prepare(
      `
        SELECT
          project_id,
          last_started_ms,
          last_pressure_stop_ms,
          pressure_cooldown_until_ms,
          last_ranked_ms,
          last_decision_reason,
          last_decision_pressure_zone,
          updated_at
        FROM project_stop_state
        WHERE project_id=?
      `,
    )
    .get(project_id) as ProjectStopStateRow | undefined;
}

export function listProjectStopStates(): ProjectStopStateRow[] {
  ensureStopPolicyTables();
  const db = getDatabase();
  return db
    .prepare(
      `
        SELECT
          project_id,
          last_started_ms,
          last_pressure_stop_ms,
          pressure_cooldown_until_ms,
          last_ranked_ms,
          last_decision_reason,
          last_decision_pressure_zone,
          updated_at
        FROM project_stop_state
        ORDER BY project_id
      `,
    )
    .all() as ProjectStopStateRow[];
}
