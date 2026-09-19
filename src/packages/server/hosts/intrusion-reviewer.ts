/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import { v5 as uuidv5 } from "uuid";

import getLogger from "@cocalc/backend/logger";
import type { HostIntrusionReviewReport } from "@cocalc/conat/hub/api/system";
import getPool, { withSessionAdvisoryLock } from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import adminAlert from "@cocalc/server/messages/admin-alert";

import {
  ensureHostIntrusionMonitorSchema,
  HOST_INTRUSION_ONLINE_WINDOW_MS,
  hostIntrusionMonitorIntervalMs,
  hostIntrusionObservationMaxAgeMs,
} from "./intrusion-monitor";

const logger = getLogger("server:hosts:intrusion-reviewer");

const OBSERVATIONS = "project_host_intrusion_snapshots";
const STATE = "project_host_intrusion_review_state";
const FINDINGS = "project_host_intrusion_findings";
const INCIDENTS = "project_host_intrusion_incidents";
const OUTBOX = "project_host_intrusion_notification_outbox";
const LOCK_KEY = "project_host_intrusion_reviewer";
const RULE_VERSION = 1;
const INCIDENT_NAMESPACE = "ad5cf951-7052-47ed-96e9-c87ec7f6e79d";
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const DEFAULT_BATCH_LIMIT = 200;
const MAX_BATCH_LIMIT = 1000;
const DEFAULT_MAX_BATCHES_PER_TICK = 5;
const MAX_STORED_JSON_BYTES = 1024 * 1024;
const MAX_STORED_PHYSICAL_BYTES = 256 * 1024;
const MAX_EVIDENCE_VALUES = 200;
const MAX_EVIDENCE_CATEGORIES = 50;
const MAX_CLEANUP_ROWS = 1000;
const DELIVERED_OUTBOX_RETENTION_DAYS = 90;
const MAX_REPORT_INCIDENTS = 50;
const MAX_REPORT_HOSTS = 100;
const MAX_REPORT_OBSERVATION_GROUPS = 100;
const MAX_REPORT_FINDING_GROUPS = 50;
const PERSISTENCE_WINDOW_MS = 24 * 60 * 60 * 1000;
const CRITICAL_PERSISTENCE_CATEGORIES = new Set([
  "accounts.uid_zero",
  "privileged_files.writable",
  "privileged_files.suid_sgid",
  "privileged_files.capabilities",
]);
const RULE_CATALOG = [
  {
    id: "persistent-host-state",
    version: RULE_VERSION,
    owner: "security-operations",
    severity: "warning-or-critical",
    required_coverage: "two-complete-observations",
    correlation_window_ms: PERSISTENCE_WINDOW_MS,
    runbook_ref:
      "project-host-intrusion-observation-and-triage-two-pr-plan#persistent-host-state",
  },
  {
    id: "coverage-loss",
    version: RULE_VERSION,
    owner: "security-operations",
    severity: "warning",
    required_coverage: "collector-threshold-evidence",
    correlation_window_ms: PERSISTENCE_WINDOW_MS,
    runbook_ref:
      "project-host-intrusion-observation-and-triage-two-pr-plan#coverage-loss",
  },
] as const;

type JsonObject = Record<string, unknown>;
type Delta = {
  added?: Record<string, string[]>;
  removed?: Record<string, string[]>;
};

type ObservationRow = {
  id: string;
  host_id: string;
  created_at: Date | string;
  coverage: string;
  decision: JsonObject | null;
  normalized: JsonObject | null;
  evidence_oversized: boolean;
};

type CandidateFinding = {
  observation_id: string;
  evidence: JsonObject;
};

type IncidentRow = {
  id: string;
  state: "open" | "acknowledged" | "resolved" | "suppressed";
  severity: "warning" | "critical";
  suppression_expires_at: Date | string | null;
  last_seen_at: Date | string;
  resolved_at: Date | string | null;
  occurrence_count: number;
};

type ExpectedChange = {
  id: string;
  bay_id: string;
  host_ids: string[];
  categories: string[];
  starts_at: string;
  expires_at: string;
  reason: string;
  actor?: string;
};

export type HostIntrusionReviewerResult = {
  processed: number;
  findings: number;
  opened: number;
  escalated: number;
  reopened: number;
  resolved: number;
  suppressed: number;
  notifications_delivered: number;
  notifications_failed: number;
  findings_pruned: number;
  outbox_pruned: number;
};

let schemaReady: Promise<void> | undefined;
let started = false;

function boundedInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function boundedEvidenceCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? Math.min(parsed, MAX_EVIDENCE_VALUES * 100)
    : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value != null && typeof value === "object") {
    return `{${Object.entries(value as JsonObject)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

type BoundedDeltaResult = {
  delta?: Delta;
  truncated: boolean;
  omitted_value_count: number;
  omitted_category_count: number;
  truncated_string_count: number;
};

function boundedDeltaEvidence(value: unknown): BoundedDeltaResult {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return {
      truncated: false,
      omitted_value_count: 0,
      omitted_category_count: 0,
      truncated_string_count: 0,
    };
  }
  type CategoryEvidence = {
    direction: "added" | "removed";
    category: string;
    values: string[];
    critical: boolean;
  };
  const categories: CategoryEvidence[] = [];
  for (const direction of ["added", "removed"] as const) {
    const source = (value as JsonObject)[direction];
    if (source == null || typeof source !== "object" || Array.isArray(source)) {
      continue;
    }
    for (const [category, entries] of Object.entries(source as JsonObject)) {
      if (!Array.isArray(entries)) continue;
      const values = entries.filter(
        (entry): entry is string => typeof entry === "string",
      );
      if (!values.length) continue;
      categories.push({
        direction,
        category,
        values,
        critical:
          direction === "added" &&
          CRITICAL_PERSISTENCE_CATEGORIES.has(category),
      });
    }
  }
  categories.sort((a, b) => {
    if (a.critical !== b.critical) return a.critical ? -1 : 1;
    if (a.direction !== b.direction) return a.direction === "added" ? -1 : 1;
    return a.category.localeCompare(b.category);
  });
  const selectedCategories = categories.slice(0, MAX_EVIDENCE_CATEGORIES);
  const omittedCategoryCount = Math.max(
    0,
    categories.length - selectedCategories.length,
  );
  let omittedValueCount = categories
    .slice(MAX_EVIDENCE_CATEGORIES)
    .reduce((sum, category) => sum + category.values.length, 0);
  let truncatedStringCount = 0;
  let remaining = MAX_EVIDENCE_VALUES;
  const accepted = new Map<CategoryEvidence, string[]>();

  // Preserve breadth first, especially across critical categories, before a
  // single noisy category is allowed to consume the remaining value budget.
  for (const category of selectedCategories) {
    if (remaining <= 0) break;
    accepted.set(category, [category.values[0]!]);
    remaining -= 1;
  }
  for (const category of selectedCategories) {
    if (remaining <= 0) break;
    const current = accepted.get(category) ?? [];
    const extra = category.values.slice(
      current.length,
      current.length + remaining,
    );
    current.push(...extra);
    accepted.set(category, current);
    remaining -= extra.length;
  }

  const result: Delta = {};
  for (const category of selectedCategories) {
    const kept = accepted.get(category) ?? [];
    omittedValueCount += category.values.length - kept.length;
    if (!kept.length) continue;
    const strings = kept.map((entry) => {
      if (entry.length > 4096) truncatedStringCount += 1;
      return entry.slice(0, 4096);
    });
    const direction = (result[category.direction] ??= {});
    direction[category.category.slice(0, 200)] = strings;
  }
  return {
    ...(result.added || result.removed ? { delta: result } : {}),
    truncated:
      omittedValueCount > 0 ||
      omittedCategoryCount > 0 ||
      truncatedStringCount > 0,
    omitted_value_count: omittedValueCount,
    omitted_category_count: omittedCategoryCount,
    truncated_string_count: truncatedStringCount,
  };
}

function boundedDelta(value: unknown): Delta | undefined {
  return boundedDeltaEvidence(value).delta;
}

function persistenceSeverity(
  delta: unknown,
  reasonCodes: string[],
): "warning" | "critical" {
  if (reasonCodes.includes("critical_host_boundary_change")) return "critical";
  if (delta == null || typeof delta !== "object" || Array.isArray(delta)) {
    return "warning";
  }
  const added = (delta as JsonObject).added;
  if (added == null || typeof added !== "object" || Array.isArray(added)) {
    return "warning";
  }
  return Object.entries(added as JsonObject).some(
    ([category, entries]) =>
      Array.isArray(entries) &&
      entries.some((entry) => typeof entry === "string") &&
      CRITICAL_PERSISTENCE_CATEGORIES.has(category),
  )
    ? "critical"
    : "warning";
}

function normalizedSignals(
  value: unknown,
): Record<string, string[]> | undefined {
  if (value == null || typeof value !== "object" || Array.isArray(value))
    return;
  const signals = (value as JsonObject).signals;
  if (
    signals == null ||
    typeof signals !== "object" ||
    Array.isArray(signals)
  ) {
    return;
  }
  return signals as Record<string, string[]>;
}

function allChangesRemain(delta: Delta, normalized: unknown): boolean {
  const signals = normalizedSignals(normalized);
  if (!signals) return false;
  for (const [category, entries] of Object.entries(delta.added ?? {})) {
    const current = new Set(
      Array.isArray(signals[category]) ? signals[category] : [],
    );
    if (entries.some((entry) => !current.has(entry))) return false;
  }
  for (const [category, entries] of Object.entries(delta.removed ?? {})) {
    const current = new Set(
      Array.isArray(signals[category]) ? signals[category] : [],
    );
    if (entries.some((entry) => current.has(entry))) return false;
  }
  return true;
}

function anyChangeRemains(delta: Delta, normalized: unknown): boolean {
  const signals = normalizedSignals(normalized);
  if (!signals) return false;
  for (const [category, entries] of Object.entries(delta.added ?? {})) {
    const current = new Set(
      Array.isArray(signals[category]) ? signals[category] : [],
    );
    if (entries.some((entry) => current.has(entry))) return true;
  }
  for (const [category, entries] of Object.entries(delta.removed ?? {})) {
    const current = new Set(
      Array.isArray(signals[category]) ? signals[category] : [],
    );
    if (entries.some((entry) => !current.has(entry))) return true;
  }
  return false;
}

async function remainingDeltaAfterLaterCompleteStates(
  client: { query: (sql: string, values?: unknown[]) => Promise<any> },
  observation: ObservationRow,
  delta: Delta,
): Promise<Delta | undefined> {
  const { rows } = await client.query(
    `WITH entries AS MATERIALIZED (
       SELECT direction.key AS direction, category.key AS category,
              value.value #>> '{}' AS value
         FROM jsonb_each($5::jsonb) AS direction(key, value)
         CROSS JOIN LATERAL jsonb_each(direction.value)
           AS category(key, value)
         CROSS JOIN LATERAL jsonb_array_elements(category.value)
           AS value(value)
        WHERE direction.key IN ('added', 'removed')
     )
     SELECT entries.direction, entries.category, entries.value
       FROM entries
      WHERE NOT EXISTS (
        SELECT 1
          FROM ${OBSERVATIONS} AS later
         WHERE later.bay_id=$1 AND later.host_id=$2
           AND later.coverage='complete'
           AND (later.created_at, later.id) > ($3::timestamptz, $4::uuid)
           AND later.normalized IS NOT NULL
           AND pg_column_size(later.normalized) <= $6
           AND octet_length(later.normalized::text) <= $7
           AND jsonb_typeof(later.normalized->'signals')='object'
           AND (
             NOT ((later.normalized->'signals') ? entries.category) OR
             jsonb_typeof(
               later.normalized->'signals'->entries.category
             )='array'
           )
           AND CASE entries.direction
             WHEN 'added' THEN NOT COALESCE(
               (later.normalized->'signals'->entries.category) @>
                 jsonb_build_array(to_jsonb(entries.value)),
               FALSE
             )
             ELSE COALESCE(
               (later.normalized->'signals'->entries.category) @>
                 jsonb_build_array(to_jsonb(entries.value)),
               FALSE
             )
           END
      )`,
    [
      getConfiguredBayId(),
      observation.host_id,
      observation.created_at,
      observation.id,
      JSON.stringify(delta),
      MAX_STORED_PHYSICAL_BYTES,
      MAX_STORED_JSON_BYTES,
    ],
  );
  const remaining: Delta = {};
  for (const { direction, category, value } of rows as Array<{
    direction: "added" | "removed";
    category: string;
    value: string;
  }>) {
    const selected = (remaining[direction] ??= {});
    (selected[category] ??= []).push(value);
  }
  return remaining.added || remaining.removed ? remaining : undefined;
}

function deltaCategories(delta: Delta): string[] {
  return [
    ...new Set([
      ...Object.keys(delta.added ?? {}),
      ...Object.keys(delta.removed ?? {}),
    ]),
  ].sort();
}

function mergeBoundedDeltas(deltas: Delta[]): BoundedDeltaResult {
  const merged: Delta = {};
  for (const direction of ["added", "removed"] as const) {
    const values: Record<string, Set<string>> = {};
    for (const delta of deltas) {
      for (const [category, entries] of Object.entries(
        delta[direction] ?? {},
      )) {
        const selected = (values[category] ??= new Set());
        for (const entry of entries) selected.add(entry);
      }
    }
    if (Object.keys(values).length) {
      merged[direction] = Object.fromEntries(
        Object.entries(values).map(([category, entries]) => [
          category,
          [...entries],
        ]),
      );
    }
  }
  return boundedDeltaEvidence(merged);
}

function severityRank(severity: "warning" | "critical"): number {
  return severity === "critical" ? 2 : 1;
}

function notificationRules(): Set<string> {
  return new Set(
    `${process.env.COCALC_HOST_INTRUSION_REVIEW_NOTIFY_RULES ?? ""}`
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function expectedChanges(): ExpectedChange[] {
  const raw = process.env.COCALC_HOST_INTRUSION_EXPECTED_CHANGES;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw Error("expected an array");
    return parsed.slice(0, 100).flatMap((entry): ExpectedChange[] => {
      if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
        return [];
      }
      const value = entry as JsonObject;
      const result: ExpectedChange = {
        id: `${value.id ?? ""}`.slice(0, 200),
        bay_id: `${value.bay_id ?? ""}`.slice(0, 200),
        host_ids: Array.isArray(value.host_ids)
          ? value.host_ids.map(String).slice(0, 100)
          : [],
        categories: Array.isArray(value.categories)
          ? value.categories.map(String).slice(0, 100)
          : [],
        starts_at: `${value.starts_at ?? ""}`,
        expires_at: `${value.expires_at ?? ""}`,
        reason: `${value.reason ?? ""}`.slice(0, 500),
        actor:
          typeof value.actor === "string"
            ? value.actor.trim().slice(0, 200)
            : undefined,
      };
      const starts = Date.parse(result.starts_at);
      const expires = Date.parse(result.expires_at);
      return result.id &&
        result.bay_id &&
        result.reason &&
        Number.isFinite(starts) &&
        Number.isFinite(expires) &&
        expires >= starts
        ? [result]
        : [];
    });
  } catch (err) {
    logger.warn("invalid host intrusion expected-change configuration", {
      err: `${err}`,
    });
    return [];
  }
}

function matchExpectedChange({
  bayId,
  hostId,
  categories,
  at,
}: {
  bayId: string;
  hostId: string;
  categories: string[];
  at: Date;
}): ExpectedChange | undefined {
  return expectedChanges().find((entry) => {
    const starts = Date.parse(entry.starts_at);
    const expires = Date.parse(entry.expires_at);
    return (
      entry.bay_id === bayId &&
      Number.isFinite(expires) &&
      at.getTime() <= expires &&
      (!Number.isFinite(starts) || at.getTime() >= starts) &&
      (!entry.host_ids.length || entry.host_ids.includes(hostId)) &&
      (!entry.categories.length ||
        categories.every((category) => entry.categories.includes(category)))
    );
  });
}

export async function ensureHostIntrusionReviewerSchema(): Promise<void> {
  const attempt = (schemaReady ??= (async () => {
    await ensureHostIntrusionMonitorSchema();
    const pool = getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${STATE} (
        bay_id TEXT PRIMARY KEY,
        cursor_created_at TIMESTAMPTZ,
        cursor_id UUID,
        last_started_at TIMESTAMPTZ,
        last_success_at TIMESTAMPTZ,
        last_error_at TIMESTAMPTZ,
        last_error TEXT,
        legacy_findings_cleanup_cursor UUID,
        legacy_findings_cleanup_complete BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(
      `ALTER TABLE ${STATE}
       ADD COLUMN IF NOT EXISTS legacy_findings_cleanup_cursor UUID`,
    );
    await pool.query(
      `ALTER TABLE ${STATE}
       ADD COLUMN IF NOT EXISTS legacy_findings_cleanup_complete BOOLEAN
         NOT NULL DEFAULT FALSE`,
    );
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${FINDINGS} (
        id UUID PRIMARY KEY,
        observation_id UUID NOT NULL
          CONSTRAINT ${FINDINGS}_observation_fk
          REFERENCES ${OBSERVATIONS}(id) ON DELETE CASCADE,
        bay_id TEXT NOT NULL,
        host_id UUID NOT NULL,
        rule_id TEXT NOT NULL,
        rule_version INTEGER NOT NULL,
        classification TEXT NOT NULL,
        severity TEXT NOT NULL,
        evidence JSONB NOT NULL,
        correlated_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (observation_id, rule_id, rule_version)
      )
    `);
    await pool.query(
      `ALTER TABLE ${FINDINGS}
       ADD COLUMN IF NOT EXISTS correlated_at TIMESTAMPTZ`,
    );
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = '${FINDINGS}_observation_fk'
        ) THEN
          ALTER TABLE ${FINDINGS}
            ADD CONSTRAINT ${FINDINGS}_observation_fk
            FOREIGN KEY (observation_id) REFERENCES ${OBSERVATIONS}(id)
            ON DELETE CASCADE NOT VALID;
        END IF;
      END
      $$
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ${FINDINGS}_host_rule_created_idx
      ON ${FINDINGS} (host_id, rule_id, created_at DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ${FINDINGS}_legacy_cleanup_idx
      ON ${FINDINGS} (bay_id, id)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ${FINDINGS}_uncorrelated_idx
      ON ${FINDINGS} (bay_id, host_id, rule_id, created_at DESC)
      WHERE correlated_at IS NULL
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${INCIDENTS} (
        id UUID PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        bay_id TEXT NOT NULL,
        host_id UUID NOT NULL,
        rule_id TEXT NOT NULL,
        rule_version INTEGER NOT NULL,
        severity TEXT NOT NULL,
        confidence TEXT NOT NULL,
        state TEXT NOT NULL,
        first_seen_at TIMESTAMPTZ NOT NULL,
        last_seen_at TIMESTAMPTZ NOT NULL,
        opened_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMPTZ,
        observation_ids UUID[] NOT NULL DEFAULT '{}',
        evidence JSONB NOT NULL,
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        suppression_ref TEXT,
        suppression_expires_at TIMESTAMPTZ,
        last_notification_transition TEXT,
        operator_disposition JSONB NOT NULL DEFAULT '{}'::jsonb,
        CHECK (state IN ('open', 'acknowledged', 'resolved', 'suppressed'))
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ${INCIDENTS}_bay_state_updated_idx
      ON ${INCIDENTS} (bay_id, state, updated_at DESC)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${OUTBOX} (
        id UUID PRIMARY KEY,
        incident_id UUID NOT NULL
          CONSTRAINT ${OUTBOX}_incident_fk
          REFERENCES ${INCIDENTS}(id) ON DELETE CASCADE,
        transition TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        delivered_at TIMESTAMPTZ,
        UNIQUE (incident_id, transition),
        CHECK (state IN ('pending', 'delivered'))
      )
    `);
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = '${OUTBOX}_incident_fk'
        ) THEN
          ALTER TABLE ${OUTBOX}
            ADD CONSTRAINT ${OUTBOX}_incident_fk
            FOREIGN KEY (incident_id) REFERENCES ${INCIDENTS}(id)
            ON DELETE CASCADE NOT VALID;
        END IF;
      END
      $$
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ${OUTBOX}_delivered_idx
      ON ${OUTBOX} (delivered_at, incident_id)
      WHERE state='delivered'
    `);
  })());
  try {
    await attempt;
  } catch (err) {
    if (schemaReady === attempt) schemaReady = undefined;
    throw err;
  }
}

async function insertFinding(
  client: { query: (sql: string, values?: unknown[]) => Promise<any> },
  {
    observation,
    ruleId,
    classification,
    severity,
    evidence,
  }: {
    observation: ObservationRow;
    ruleId: string;
    classification: string;
    severity: string;
    evidence: JsonObject;
  },
): Promise<boolean> {
  const id = uuidv5(
    `${observation.id}:${ruleId}:${RULE_VERSION}`,
    INCIDENT_NAMESPACE,
  );
  const { rowCount } = await client.query(
    `INSERT INTO ${FINDINGS}
       (id, observation_id, bay_id, host_id, rule_id, rule_version,
        classification, severity, evidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (observation_id, rule_id, rule_version) DO NOTHING`,
    [
      id,
      observation.id,
      getConfiguredBayId(),
      observation.host_id,
      ruleId,
      RULE_VERSION,
      classification,
      severity,
      JSON.stringify(evidence),
    ],
  );
  return rowCount === 1;
}

async function queueIncidentTransition(
  client: { query: (sql: string, values?: unknown[]) => Promise<any> },
  incidentId: string,
  transition: string,
  ruleId: string,
): Promise<void> {
  if (!notificationRules().has(ruleId)) return;
  await client.query(
    `INSERT INTO ${OUTBOX} (id, incident_id, transition)
     VALUES ($1, $2, $3)
     ON CONFLICT (incident_id, transition) DO NOTHING`,
    [
      uuidv5(`${incidentId}:${transition}`, INCIDENT_NAMESPACE),
      incidentId,
      transition,
    ],
  );
}

async function openIncident(
  client: { query: (sql: string, values?: unknown[]) => Promise<any> },
  {
    observation,
    ruleId,
    severity,
    evidence,
    expected,
    result,
  }: {
    observation: ObservationRow;
    ruleId: string;
    severity: "warning" | "critical";
    evidence: JsonObject;
    expected?: ExpectedChange;
    result: HostIntrusionReviewerResult;
  },
): Promise<void> {
  const evidenceFingerprint =
    typeof evidence.delta_fingerprint === "string"
      ? evidence.delta_fingerprint
      : ruleId === "coverage-loss"
        ? "host-coverage"
        : sha256(stableJson(evidence));
  const fingerprint = sha256(
    `${getConfiguredBayId()}:${observation.host_id}:${ruleId}:${RULE_VERSION}:${evidenceFingerprint}`,
  );
  const incidentId = uuidv5(fingerprint, INCIDENT_NAMESPACE);
  const { rows } = await client.query(
    `SELECT id, state, severity, suppression_expires_at, occurrence_count,
            last_seen_at, resolved_at
       FROM ${INCIDENTS} WHERE fingerprint=$1 FOR UPDATE`,
    [fingerprint],
  );
  const existing = rows[0] as IncidentRow | undefined;
  if (existing) {
    const observationTime = new Date(observation.created_at).getTime();
    const lifecycleWatermark = Math.max(
      new Date(existing.last_seen_at).getTime(),
      existing.resolved_at == null
        ? Number.NEGATIVE_INFINITY
        : new Date(existing.resolved_at).getTime(),
    );
    if (
      !Number.isFinite(observationTime) ||
      observationTime < lifecycleWatermark
    ) {
      return;
    }
  }
  const now = new Date();
  const suppressed =
    expected != null && Date.parse(expected.expires_at) >= now.getTime();
  const storedEvidence = expected
    ? {
        ...evidence,
        expected_change: {
          id: expected.id,
          reason: expected.reason,
          ...(expected.actor ? { actor: expected.actor } : {}),
        },
      }
    : evidence;
  if (!existing) {
    await client.query(
      `INSERT INTO ${INCIDENTS}
        (id, fingerprint, bay_id, host_id, rule_id, rule_version, severity,
         confidence, state, first_seen_at, last_seen_at, opened_at,
         observation_ids, evidence, suppression_ref, suppression_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'correlated',$8,$9,$9,$10,$11,$12::jsonb,$13,$14)`,
      [
        incidentId,
        fingerprint,
        getConfiguredBayId(),
        observation.host_id,
        ruleId,
        RULE_VERSION,
        severity,
        suppressed ? "suppressed" : "open",
        observation.created_at,
        suppressed ? null : observation.created_at,
        [observation.id],
        JSON.stringify(storedEvidence),
        expected?.id ?? null,
        expected?.expires_at ?? null,
      ],
    );
    if (suppressed) {
      result.suppressed += 1;
    } else {
      result.opened += 1;
      await queueIncidentTransition(client, incidentId, "open", ruleId);
    }
    return;
  }

  const suppressionEnded = existing.state === "suppressed" && !suppressed;
  const reopens = existing.state === "resolved" || suppressionEnded;
  const escalates =
    !suppressed &&
    !reopens &&
    (existing.state === "open" || existing.state === "acknowledged") &&
    severityRank(severity) > severityRank(existing.severity);
  const nextSeverity =
    severityRank(severity) > severityRank(existing.severity)
      ? severity
      : existing.severity;
  await client.query(
    `UPDATE ${INCIDENTS}
        SET state=$2,
            severity=$8,
            last_seen_at=GREATEST(last_seen_at, $3),
            opened_at=CASE WHEN $2='open' AND state<>'open' THEN $3 ELSE opened_at END,
            resolved_at=CASE WHEN $2='open' THEN NULL ELSE resolved_at END,
            updated_at=NOW(),
            occurrence_count=occurrence_count+1,
            observation_ids=(observation_ids || $4::uuid[])[GREATEST(1, array_length(observation_ids,1) + 2 - 20):],
            evidence=$5::jsonb,
            suppression_ref=$6,
            suppression_expires_at=$7
      WHERE id=$1`,
    [
      existing.id,
      suppressed ? "suppressed" : reopens ? "open" : existing.state,
      observation.created_at,
      [observation.id],
      JSON.stringify(storedEvidence),
      expected?.id ?? null,
      expected?.expires_at ?? null,
      nextSeverity,
    ],
  );
  if (suppressed) result.suppressed += 1;
  if (reopens && !suppressed) {
    result.reopened += 1;
    await queueIncidentTransition(
      client,
      existing.id,
      `reopen:${existing.occurrence_count + 1}`,
      ruleId,
    );
  } else if (escalates) {
    result.escalated += 1;
    await queueIncidentTransition(
      client,
      existing.id,
      `escalate:${nextSeverity}:${existing.occurrence_count + 1}`,
      ruleId,
    );
  }
}

async function resolveIncidents(
  client: { query: (sql: string, values?: unknown[]) => Promise<any> },
  observation: ObservationRow,
  normalized: unknown,
  result: HostIntrusionReviewerResult,
): Promise<void> {
  const { rows } = await client.query(
    `SELECT id, rule_id, evidence
       FROM ${INCIDENTS}
      WHERE bay_id=$1 AND host_id=$2
        AND state IN ('open','acknowledged','suppressed')
        AND last_seen_at <= $3
      ORDER BY updated_at DESC LIMIT 50 FOR UPDATE`,
    [getConfiguredBayId(), observation.host_id, observation.created_at],
  );
  for (const incident of rows as Array<{
    id: string;
    rule_id: string;
    evidence: JsonObject;
  }>) {
    const delta = boundedDelta(incident.evidence.delta);
    const recovered =
      incident.rule_id === "coverage-loss"
        ? observation.coverage === "complete"
        : delta != null && !anyChangeRemains(delta, normalized);
    if (!recovered) continue;
    await client.query(
      `UPDATE ${INCIDENTS}
          SET state='resolved', resolved_at=$2, updated_at=NOW(),
              suppression_ref=NULL, suppression_expires_at=NULL
        WHERE id=$1 AND state IN ('open','acknowledged','suppressed')`,
      [incident.id, observation.created_at],
    );
    result.resolved += 1;
  }
}

async function reviewSuppressedIncidents(
  client: { query: (sql: string, values?: unknown[]) => Promise<any> },
  observation: ObservationRow,
  normalized: unknown,
  result: HostIntrusionReviewerResult,
): Promise<void> {
  const { rows } = await client.query(
    `SELECT rule_id, severity, evidence
       FROM ${INCIDENTS}
      WHERE bay_id=$1 AND host_id=$2 AND state='suppressed'
        AND last_seen_at <= $3
      ORDER BY updated_at DESC LIMIT 50 FOR UPDATE`,
    [getConfiguredBayId(), observation.host_id, observation.created_at],
  );
  for (const incident of rows as Array<{
    rule_id: string;
    severity: "warning" | "critical";
    evidence: JsonObject;
  }>) {
    const delta = boundedDelta(incident.evidence.delta);
    if (delta == null || !anyChangeRemains(delta, normalized)) continue;
    const expected = matchExpectedChange({
      bayId: getConfiguredBayId(),
      hostId: observation.host_id,
      categories: deltaCategories(delta),
      at: new Date(observation.created_at),
    });
    if (expected != null && Date.parse(expected.expires_at) >= Date.now()) {
      continue;
    }
    await openIncident(client, {
      observation,
      ruleId: incident.rule_id,
      severity: incident.severity,
      evidence: incident.evidence,
      result,
    });
  }
}

async function reviewObservation(
  client: { query: (sql: string, values?: unknown[]) => Promise<any> },
  observation: ObservationRow,
  result: HostIntrusionReviewerResult,
): Promise<void> {
  if (observation.evidence_oversized || !observation.decision) {
    if (
      await insertFinding(client, {
        observation,
        ruleId: "observation-integrity",
        classification: "diagnostic",
        severity: "warning",
        evidence: { reason: "stored_evidence_oversized_or_unreadable" },
      })
    ) {
      result.findings += 1;
    }
    return;
  }

  const classification = `${observation.decision.classification ?? "inventory"}`;
  const reasonCodes = Array.isArray(observation.decision.reason_codes)
    ? observation.decision.reason_codes.map(String).slice(0, 20)
    : [];
  const rawActionableDelta = observation.decision.actionable_delta;
  const boundedActionableDelta = boundedDeltaEvidence(rawActionableDelta);
  const actionableDelta = boundedActionableDelta.delta;

  if (observation.coverage === "complete") {
    await resolveIncidents(client, observation, observation.normalized, result);
    await reviewSuppressedIncidents(
      client,
      observation,
      observation.normalized,
      result,
    );
  }

  if (
    observation.coverage !== "complete" &&
    reasonCodes.includes("coverage_failure_threshold_reached")
  ) {
    const evidence = { coverage: observation.coverage };
    if (
      await insertFinding(client, {
        observation,
        ruleId: "coverage-loss",
        classification: "coverage_loss",
        severity: "warning",
        evidence,
      })
    ) {
      result.findings += 1;
      await openIncident(client, {
        observation,
        ruleId: "coverage-loss",
        severity: "warning",
        evidence,
        result,
      });
    }
    return;
  }

  if (actionableDelta) {
    const candidateSeverity = persistenceSeverity(
      rawActionableDelta,
      reasonCodes,
    );
    const evidence = {
      status: "candidate",
      candidate_severity: candidateSeverity,
      delta_fingerprint: sha256(stableJson(actionableDelta)),
      delta: actionableDelta,
      categories: deltaCategories(actionableDelta),
      delta_truncated: boundedActionableDelta.truncated,
      omitted_value_count: boundedActionableDelta.omitted_value_count,
      omitted_category_count: boundedActionableDelta.omitted_category_count,
      truncated_string_count: boundedActionableDelta.truncated_string_count,
    };
    if (
      await insertFinding(client, {
        observation,
        ruleId: "persistent-host-state",
        classification: "diagnostic",
        severity: "warning",
        evidence,
      })
    ) {
      result.findings += 1;
    }
  } else if (observation.coverage === "complete" && observation.normalized) {
    const { rows } = await client.query(
      `SELECT findings.observation_id, findings.evidence
         FROM ${FINDINGS} AS findings
         JOIN ${OBSERVATIONS} AS source
           ON source.id=findings.observation_id
        WHERE findings.bay_id=$1 AND findings.host_id=$2
          AND findings.rule_id='persistent-host-state'
          AND findings.rule_version=$3
          AND findings.classification='diagnostic'
          AND findings.correlated_at IS NULL
          AND source.created_at BETWEEN
              $4::timestamptz - ($5::double precision * INTERVAL '1 millisecond')
              AND $4::timestamptz
        ORDER BY (findings.evidence->>'candidate_severity'='critical') DESC,
                 source.created_at, findings.observation_id
        LIMIT 20`,
      [
        getConfiguredBayId(),
        observation.host_id,
        RULE_VERSION,
        observation.created_at,
        PERSISTENCE_WINDOW_MS,
      ],
    );
    const candidates = (rows as CandidateFinding[]).filter((row) => {
      const delta = boundedDelta(row.evidence.delta);
      return delta != null && allChangesRemain(delta, observation.normalized);
    });
    if (candidates.length) {
      const activeCandidates: Array<{
        candidate: CandidateFinding;
        delta: Delta;
      }> = [];
      for (const candidate of candidates) {
        const delta = boundedDelta(candidate.evidence.delta);
        if (delta == null) continue;
        const activeDelta = await remainingDeltaAfterLaterCompleteStates(
          client,
          observation,
          delta,
        );
        if (activeDelta != null) {
          activeCandidates.push({ candidate, delta: activeDelta });
        }
      }
      if (!activeCandidates.length) {
        const inserted = await insertFinding(client, {
          observation,
          ruleId: "persistent-host-state",
          classification: "diagnostic",
          severity: "informational",
          evidence: {
            status: "superseded",
            reason: "newer_complete_observation_recovered_candidate_evidence",
            candidate_observation_ids: candidates.map(
              (candidate) => candidate.observation_id,
            ),
          },
        });
        if (inserted) {
          result.findings += 1;
          await client.query(
            `UPDATE ${FINDINGS}
                SET correlated_at=$2
              WHERE observation_id = ANY($1::uuid[])
                AND rule_id='persistent-host-state'
                AND rule_version=$3
                AND correlated_at IS NULL`,
            [
              candidates.map((candidate) => candidate.observation_id),
              observation.created_at,
              RULE_VERSION,
            ],
          );
        }
        return;
      }
      const merged = mergeBoundedDeltas(
        activeCandidates.map(({ delta }) => delta),
      );
      const delta = merged.delta!;
      const severity = activeCandidates.some(
        ({ candidate }) => candidate.evidence.candidate_severity === "critical",
      )
        ? "critical"
        : "warning";
      const candidateEvidenceTruncated = activeCandidates.some(
        ({ candidate }) => candidate.evidence.delta_truncated === true,
      );
      const evidence = {
        status: "confirmed",
        candidate_observation_ids: activeCandidates.map(
          ({ candidate }) => candidate.observation_id,
        ),
        superseded_candidate_count: candidates.length - activeCandidates.length,
        delta_fingerprint: sha256(stableJson(delta)),
        delta,
        categories: deltaCategories(delta),
        delta_truncated: candidateEvidenceTruncated || merged.truncated,
        omitted_value_count:
          merged.omitted_value_count +
          activeCandidates.reduce(
            (sum, { candidate }) =>
              sum +
              boundedEvidenceCount(candidate.evidence.omitted_value_count),
            0,
          ),
        omitted_category_count:
          merged.omitted_category_count +
          activeCandidates.reduce(
            (sum, { candidate }) =>
              sum +
              boundedEvidenceCount(candidate.evidence.omitted_category_count),
            0,
          ),
        truncated_string_count:
          merged.truncated_string_count +
          activeCandidates.reduce(
            (sum, { candidate }) =>
              sum +
              boundedEvidenceCount(candidate.evidence.truncated_string_count),
            0,
          ),
      };
      if (
        await insertFinding(client, {
          observation,
          ruleId: "persistent-host-state",
          classification: "actionable",
          severity,
          evidence,
        })
      ) {
        result.findings += 1;
        await client.query(
          `UPDATE ${FINDINGS}
              SET correlated_at=$2
            WHERE observation_id = ANY($1::uuid[])
              AND rule_id='persistent-host-state'
              AND rule_version=$3
              AND correlated_at IS NULL`,
          [
            candidates.map((candidate) => candidate.observation_id),
            observation.created_at,
            RULE_VERSION,
          ],
        );
        const expected = matchExpectedChange({
          bayId: getConfiguredBayId(),
          hostId: observation.host_id,
          categories: deltaCategories(delta),
          at: new Date(observation.created_at),
        });
        await openIncident(client, {
          observation,
          ruleId: "persistent-host-state",
          severity,
          evidence,
          expected,
          result,
        });
      }
      return;
    }
  }

  if (classification !== "actionable" || !actionableDelta) {
    if (
      await insertFinding(client, {
        observation,
        ruleId: "observation-classification",
        classification: ["inventory", "diagnostic"].includes(classification)
          ? classification
          : "diagnostic",
        severity: "informational",
        evidence: { reason_codes: reasonCodes },
      })
    ) {
      result.findings += 1;
    }
  }
}

async function dispatchOutbox(
  result: HostIntrusionReviewerResult,
): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string;
    incident_id: string;
    transition: string;
    host_id: string;
    rule_id: string;
    severity: string;
  }>(
    `SELECT outbox.id, outbox.incident_id, outbox.transition,
            incidents.host_id, incidents.rule_id, incidents.severity
       FROM ${OUTBOX} AS outbox
       JOIN ${INCIDENTS} AS incidents ON incidents.id=outbox.incident_id
      WHERE outbox.state='pending' AND incidents.bay_id=$1
      ORDER BY outbox.created_at LIMIT 20`,
    [getConfiguredBayId()],
  );
  for (const row of rows) {
    try {
      await adminAlert({
        subject: `Project-host security incident ${row.transition}: ${row.rule_id}`,
        body: [
          `A durable ${row.severity} project-host security incident transitioned to ${row.transition}.`,
          "",
          `Bay: ${getConfiguredBayId()}`,
          `Host ID: ${row.host_id}`,
          `Incident ID: ${row.incident_id}`,
          `Rule: ${row.rule_id}@${RULE_VERSION}`,
          "",
          "Review the bounded host intrusion report before taking action. This notification contains no customer process arguments or project data.",
        ].join("\n"),
        dedupMinutes: 60,
        errorOnFail: true,
      });
      await pool.query(
        `UPDATE ${OUTBOX}
            SET state='delivered', attempts=attempts+1, delivered_at=NOW(), last_error=NULL
          WHERE id=$1`,
        [row.id],
      );
      await pool.query(
        `UPDATE ${INCIDENTS} SET last_notification_transition=$2 WHERE id=$1`,
        [row.incident_id, row.transition],
      );
      result.notifications_delivered += 1;
    } catch (err) {
      await pool.query(
        `UPDATE ${OUTBOX}
            SET attempts=attempts+1, last_error=$2
          WHERE id=$1`,
        [row.id, `${err}`.slice(0, 1000)],
      );
      result.notifications_failed += 1;
    }
  }
}

async function pruneReviewerRecords(
  client: { query: (sql: string, values?: unknown[]) => Promise<any> },
  bayId: string,
): Promise<{ findings: number; outbox: number }> {
  const cleanupState = (await client.query(
    `SELECT legacy_findings_cleanup_cursor,
            legacy_findings_cleanup_complete
       FROM ${STATE} WHERE bay_id=$1`,
    [bayId],
  )) as {
    rows: Array<{
      legacy_findings_cleanup_cursor: string | null;
      legacy_findings_cleanup_complete: boolean;
    }>;
  };
  let findingsPruned = 0;
  if (!cleanupState.rows[0]?.legacy_findings_cleanup_complete) {
    const cursor = cleanupState.rows[0]?.legacy_findings_cleanup_cursor ?? null;
    const legacyBatch = (await client.query(
      `SELECT findings.id, observations.id IS NULL AS orphaned
         FROM ${FINDINGS} AS findings
         LEFT JOIN ${OBSERVATIONS} AS observations
           ON observations.id=findings.observation_id
        WHERE findings.bay_id=$1
          AND ($2::uuid IS NULL OR findings.id > $2::uuid)
        ORDER BY findings.id
        LIMIT $3`,
      [bayId, cursor, MAX_CLEANUP_ROWS],
    )) as { rows: Array<{ id: string; orphaned: boolean }> };
    const orphanIds = legacyBatch.rows
      .filter(({ orphaned }) => orphaned)
      .map(({ id }) => id);
    if (orphanIds.length) {
      const deleted = await client.query(
        `DELETE FROM ${FINDINGS} WHERE id=ANY($1::uuid[])`,
        [orphanIds],
      );
      findingsPruned = deleted.rowCount ?? 0;
    }
    const lastId = legacyBatch.rows.at(-1)?.id ?? cursor;
    await client.query(
      `UPDATE ${STATE}
          SET legacy_findings_cleanup_cursor=$2,
              legacy_findings_cleanup_complete=$3,
              updated_at=NOW()
        WHERE bay_id=$1`,
      [bayId, lastId, legacyBatch.rows.length < MAX_CLEANUP_ROWS],
    );
  }
  const retentionDays = boundedInteger(
    "COCALC_HOST_INTRUSION_REVIEW_OUTBOX_RETENTION_DAYS",
    DELIVERED_OUTBOX_RETENTION_DAYS,
    7,
    3650,
  );
  const deliveredOutbox = await client.query(
    `DELETE FROM ${OUTBOX}
      WHERE id IN (
        SELECT outbox.id
          FROM ${OUTBOX} AS outbox
          JOIN ${INCIDENTS} AS incidents ON incidents.id=outbox.incident_id
         WHERE incidents.bay_id=$1 AND outbox.state='delivered'
           AND outbox.delivered_at <
               NOW() - ($2::double precision * INTERVAL '1 day')
         ORDER BY outbox.delivered_at
         LIMIT $3
      )`,
    [bayId, retentionDays, MAX_CLEANUP_ROWS],
  );
  return {
    findings: findingsPruned,
    outbox: deliveredOutbox.rowCount ?? 0,
  };
}

export async function runHostIntrusionReviewerPass({
  bayId = getConfiguredBayId(),
  batchLimit = boundedInteger(
    "COCALC_HOST_INTRUSION_REVIEW_BATCH_LIMIT",
    DEFAULT_BATCH_LIMIT,
    1,
    MAX_BATCH_LIMIT,
  ),
}: {
  bayId?: string;
  batchLimit?: number;
} = {}): Promise<HostIntrusionReviewerResult> {
  if (bayId !== getConfiguredBayId()) {
    throw Error(
      `host intrusion reviewer is not authoritative for bay '${bayId}'`,
    );
  }
  await ensureHostIntrusionReviewerSchema();
  const result: HostIntrusionReviewerResult = {
    processed: 0,
    findings: 0,
    opened: 0,
    escalated: 0,
    reopened: 0,
    resolved: 0,
    suppressed: 0,
    notifications_delivered: 0,
    notifications_failed: 0,
    findings_pruned: 0,
    outbox_pruned: 0,
  };
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query(
      `INSERT INTO ${STATE} (bay_id, last_started_at)
       VALUES ($1, NOW())
       ON CONFLICT (bay_id) DO UPDATE
         SET last_started_at=NOW(), updated_at=NOW()`,
      [bayId],
    );
    await client.query(
      `SELECT cursor_created_at, cursor_id FROM ${STATE}
        WHERE bay_id=$1 FOR UPDATE`,
      [bayId],
    );
    const limit = Math.min(
      MAX_BATCH_LIMIT,
      Math.max(1, Math.floor(batchLimit)),
    );
    const observations = await client.query<ObservationRow>(
      `SELECT observations.id, observations.host_id,
              observations.created_at, observations.coverage,
              CASE
                WHEN pg_column_size(decision) > $2 THEN NULL
                WHEN octet_length(decision::text) > $3 THEN NULL
                ELSE decision
              END AS decision,
              CASE
                WHEN pg_column_size(normalized) > $2 THEN NULL
                WHEN octet_length(normalized::text) > $3 THEN NULL
                ELSE normalized
              END AS normalized,
              CASE
                WHEN pg_column_size(decision) > $2 OR pg_column_size(normalized) > $2 THEN TRUE
                ELSE octet_length(decision::text) > $3 OR octet_length(normalized::text) > $3
              END AS evidence_oversized
         FROM ${OBSERVATIONS} AS observations
        WHERE observations.bay_id=$1
          AND NOT EXISTS (
            SELECT 1 FROM ${FINDINGS} AS processed
             WHERE processed.observation_id=observations.id
          )
        ORDER BY observations.created_at, observations.id
        LIMIT $4`,
      [bayId, MAX_STORED_PHYSICAL_BYTES, MAX_STORED_JSON_BYTES, limit],
    );
    for (const observation of observations.rows) {
      await reviewObservation(client, observation, result);
      result.processed += 1;
    }
    const pruned = await pruneReviewerRecords(client, bayId);
    result.findings_pruned = pruned.findings;
    result.outbox_pruned = pruned.outbox;
    const last = observations.rows.at(-1);
    await client.query(
      `UPDATE ${STATE}
          SET cursor_created_at=CASE
                WHEN $2::uuid IS NULL THEN cursor_created_at
                WHEN cursor_created_at IS NULL OR cursor_id IS NULL OR
                     ((SELECT created_at FROM ${OBSERVATIONS} WHERE id=$2), $2::uuid) >
                     (cursor_created_at, cursor_id)
                THEN (SELECT created_at FROM ${OBSERVATIONS} WHERE id=$2)
                ELSE cursor_created_at
              END,
              cursor_id=CASE
                WHEN $2::uuid IS NULL THEN cursor_id
                WHEN cursor_created_at IS NULL OR cursor_id IS NULL OR
                     ((SELECT created_at FROM ${OBSERVATIONS} WHERE id=$2), $2::uuid) >
                     (cursor_created_at, cursor_id)
                THEN $2::uuid
                ELSE cursor_id
              END,
              last_success_at=NOW(), last_error_at=NULL, last_error=NULL,
              updated_at=NOW()
        WHERE bay_id=$1`,
      [bayId, last?.id ?? null],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    await pool
      .query(
        `INSERT INTO ${STATE} (bay_id, last_error_at, last_error)
         VALUES ($1, NOW(), $2)
         ON CONFLICT (bay_id) DO UPDATE
           SET last_error_at=NOW(), last_error=$2, updated_at=NOW()`,
        [bayId, `${err}`.slice(0, 1000)],
      )
      .catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  await dispatchOutbox(result);
  return result;
}

export async function getHostIntrusionReviewReport({
  bayId = getConfiguredBayId(),
}: {
  bayId?: string;
} = {}): Promise<HostIntrusionReviewReport> {
  if (bayId !== getConfiguredBayId()) {
    throw Error(
      `host intrusion review report is not authoritative for bay '${bayId}'`,
    );
  }
  await ensureHostIntrusionReviewerSchema();
  const pool = getPool();
  const boundedQuery = async (sql: string, values: unknown[]) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '10s'");
      const result = await client.query(sql, values);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  };
  const [
    state,
    backlog,
    observations,
    hosts,
    collectorCoverage,
    overdueHosts,
    findings,
    retention,
    incidentSummary,
    incidents,
    notifications,
  ] = await Promise.all([
    boundedQuery(
      `SELECT cursor_created_at, cursor_id, last_started_at, last_success_at,
                last_error_at, last_error
           FROM ${STATE} WHERE bay_id=$1`,
      [bayId],
    ),
    boundedQuery(
      `SELECT COUNT(*)::integer AS count, MIN(observations.created_at) AS oldest
           FROM ${OBSERVATIONS} AS observations
          WHERE observations.bay_id=$1
            AND NOT EXISTS (
              SELECT 1 FROM ${FINDINGS} AS processed
               WHERE processed.observation_id=observations.id
            )`,
      [bayId],
    ),
    boundedQuery(
      `SELECT coverage,
                CASE
                  WHEN pg_column_size(decision) > $2 THEN 'oversized'
                  ELSE COALESCE(NULLIF(decision->>'classification',''), 'legacy')
                END AS classification,
                CASE
                  WHEN pg_column_size(collector_evidence) > $2 OR
                       COALESCE(collector_evidence->>'collector_version','') !~ '^[0-9]{1,9}$'
                    THEN NULL
                  ELSE (collector_evidence->>'collector_version')::integer
                END AS collector_version,
                normalization_version,
                decision_policy_version,
                COUNT(*)::integer AS count,
                COUNT(*) FILTER (
                  WHERE CASE
                    WHEN pg_column_size(collector_evidence) > $2 THEN TRUE
                    ELSE collector_evidence->'truncated' NOT IN
                           ('{}'::jsonb, '[]'::jsonb, 'null'::jsonb)
                      OR collector_evidence->>'persistence_truncated' = 'true'
                  END
                )::integer AS truncated
           FROM ${OBSERVATIONS}
          WHERE bay_id=$1 AND created_at >= NOW() - INTERVAL '24 hours'
          GROUP BY coverage, classification, collector_version,
                   normalization_version, decision_policy_version
          ORDER BY coverage, classification, collector_version,
                   normalization_version, decision_policy_version
          LIMIT $3`,
      [bayId, MAX_STORED_PHYSICAL_BYTES, MAX_REPORT_OBSERVATION_GROUPS + 1],
    ),
    boundedQuery(
      `SELECT * FROM (
           SELECT DISTINCT ON (host_id)
                  host_id,
                  coverage AS latest_coverage,
                  CASE
                    WHEN pg_column_size(collector_evidence) > $2 OR
                         COALESCE(collector_evidence->>'collector_version','') !~ '^[0-9]{1,9}$'
                      THEN NULL
                    ELSE (collector_evidence->>'collector_version')::integer
                  END AS collector_version,
                  normalization_version,
                  decision_policy_version,
                  created_at AS latest_observed_at,
                  COUNT(*) OVER (PARTITION BY host_id)::integer AS observations,
                  COUNT(*) FILTER (
                    WHERE CASE
                      WHEN pg_column_size(collector_evidence) > $2 THEN TRUE
                      ELSE collector_evidence->'truncated' NOT IN
                             ('{}'::jsonb, '[]'::jsonb, 'null'::jsonb)
                        OR collector_evidence->>'persistence_truncated' = 'true'
                    END
                  ) OVER (PARTITION BY host_id)::integer AS truncated
             FROM ${OBSERVATIONS}
            WHERE bay_id=$1 AND created_at >= NOW() - INTERVAL '24 hours'
            ORDER BY host_id, created_at DESC, id DESC
         ) AS latest
         ORDER BY latest_observed_at DESC
         LIMIT $3`,
      [bayId, MAX_STORED_PHYSICAL_BYTES, MAX_REPORT_HOSTS + 1],
    ),
    boundedQuery(
      `WITH active AS (
         SELECT hosts.id,
                COALESCE(hosts.created, hosts.last_seen, NOW()) AS eligible_since,
                latest.created_at AS latest_observation_at
           FROM project_hosts AS hosts
           LEFT JOIN LATERAL (
             SELECT observations.created_at
               FROM ${OBSERVATIONS} AS observations
              WHERE observations.bay_id=$1
                AND observations.host_id=hosts.id
              ORDER BY observations.created_at DESC, observations.id DESC
              LIMIT 1
           ) AS latest ON TRUE
          WHERE hosts.deleted IS NULL AND hosts.status='running'
            AND hosts.last_seen >=
                NOW() - ($2::double precision * INTERVAL '1 millisecond')
            AND COALESCE(NULLIF(hosts.bay_id, ''), $1)=$1
       )
       SELECT COUNT(*)::integer AS active_hosts,
              COUNT(latest_observation_at)::integer AS observed_hosts,
              COUNT(*) FILTER (
                WHERE (latest_observation_at IS NULL AND eligible_since <
                         NOW() - ($3::double precision * INTERVAL '1 millisecond'))
                   OR latest_observation_at <
                         NOW() - ($3::double precision * INTERVAL '1 millisecond')
              )::integer AS overdue_hosts,
              MIN(latest_observation_at) AS oldest_observation_at
         FROM active`,
      [
        bayId,
        HOST_INTRUSION_ONLINE_WINDOW_MS,
        hostIntrusionObservationMaxAgeMs(),
      ],
    ),
    boundedQuery(
      `SELECT hosts.id AS host_id, hosts.name AS host_name,
              latest.created_at AS latest_observation_at
         FROM project_hosts AS hosts
         LEFT JOIN LATERAL (
           SELECT observations.created_at
             FROM ${OBSERVATIONS} AS observations
            WHERE observations.bay_id=$1
              AND observations.host_id=hosts.id
            ORDER BY observations.created_at DESC, observations.id DESC
            LIMIT 1
         ) AS latest ON TRUE
        WHERE hosts.deleted IS NULL AND hosts.status='running'
          AND hosts.last_seen >=
              NOW() - ($2::double precision * INTERVAL '1 millisecond')
          AND COALESCE(NULLIF(hosts.bay_id, ''), $1)=$1
          AND (
            (latest.created_at IS NULL AND
             COALESCE(hosts.created, hosts.last_seen, NOW()) <
               NOW() - ($3::double precision * INTERVAL '1 millisecond'))
            OR latest.created_at <
               NOW() - ($3::double precision * INTERVAL '1 millisecond')
          )
        ORDER BY latest.created_at ASC NULLS FIRST, hosts.id
        LIMIT $4`,
      [
        bayId,
        HOST_INTRUSION_ONLINE_WINDOW_MS,
        hostIntrusionObservationMaxAgeMs(),
        MAX_REPORT_HOSTS + 1,
      ],
    ),
    boundedQuery(
      `SELECT rule_id, rule_version, classification, severity,
                COUNT(*)::integer AS count,
                COUNT(DISTINCT host_id)::integer AS host_count
           FROM ${FINDINGS}
          WHERE bay_id=$1 AND created_at >= NOW() - INTERVAL '24 hours'
          GROUP BY rule_id, rule_version, classification, severity
          ORDER BY count DESC, rule_id, rule_version, classification, severity
          LIMIT $2`,
      [bayId, MAX_REPORT_FINDING_GROUPS + 1],
    ),
    boundedQuery(
      `SELECT COUNT(*)::integer AS observations,
                MIN(created_at) AS oldest_observation_at,
                MAX(created_at) AS latest_observation_at,
                (SELECT COUNT(*)::integer FROM ${FINDINGS}
                  WHERE bay_id=$1) AS findings,
                (SELECT MIN(created_at) FROM ${FINDINGS}
                  WHERE bay_id=$1) AS oldest_finding_at,
                (SELECT COUNT(*)::integer
                   FROM ${OUTBOX} AS outbox
                   JOIN ${INCIDENTS} AS incidents
                     ON incidents.id=outbox.incident_id
                  WHERE incidents.bay_id=$1 AND outbox.state='delivered')
                  AS delivered_notifications,
                (SELECT MIN(outbox.delivered_at)
                   FROM ${OUTBOX} AS outbox
                   JOIN ${INCIDENTS} AS incidents
                     ON incidents.id=outbox.incident_id
                  WHERE incidents.bay_id=$1 AND outbox.state='delivered')
                  AS oldest_delivered_notification_at
           FROM ${OBSERVATIONS}
          WHERE bay_id=$1`,
      [bayId],
    ),
    boundedQuery(
      `SELECT
         COUNT(*) FILTER (WHERE state='open')::integer AS open,
         COUNT(*) FILTER (WHERE state='acknowledged')::integer AS acknowledged,
         COUNT(*) FILTER (WHERE state='suppressed')::integer AS suppressed,
         COUNT(*) FILTER (
           WHERE state IN ('open','acknowledged') AND severity='critical'
         )::integer AS critical,
         COUNT(*) FILTER (
           WHERE state IN ('open','acknowledged','suppressed') AND
                 updated_at < NOW() - INTERVAL '24 hours'
         )::integer AS stale,
         COUNT(*) FILTER (
           WHERE state='suppressed' AND suppression_expires_at >= NOW() AND
                 suppression_expires_at < NOW() + INTERVAL '24 hours'
         )::integer AS expiring_suppressions
       FROM ${INCIDENTS}
       WHERE bay_id=$1`,
      [bayId],
    ),
    boundedQuery(
      `SELECT id, host_id, rule_id, rule_version, severity, confidence, state,
                first_seen_at, last_seen_at, updated_at, occurrence_count,
                suppression_ref, suppression_expires_at, last_notification_transition
           FROM ${INCIDENTS}
          WHERE bay_id=$1 AND state IN ('open','acknowledged','suppressed')
          ORDER BY updated_at DESC LIMIT $2`,
      [bayId, MAX_REPORT_INCIDENTS + 1],
    ),
    boundedQuery(
      `SELECT COUNT(*) FILTER (WHERE outbox.state='pending')::integer AS pending,
                COUNT(*) FILTER (WHERE outbox.state='pending' AND outbox.attempts>0)::integer AS failed,
                MIN(outbox.created_at) FILTER (WHERE outbox.state='pending') AS oldest_pending
           FROM ${OUTBOX} AS outbox
           JOIN ${INCIDENTS} AS incidents ON incidents.id=outbox.incident_id
          WHERE incidents.bay_id=$1`,
      [bayId],
    ),
  ]);
  const reviewer = state.rows[0] ?? {};
  const pending = backlog.rows[0] ?? { count: 0, oldest: null };
  const delivery = notifications.rows[0] ?? {
    pending: 0,
    failed: 0,
    oldest_pending: null,
  };
  const retained = retention.rows[0] ?? {
    observations: 0,
    oldest_observation_at: null,
    latest_observation_at: null,
    findings: 0,
    oldest_finding_at: null,
    delivered_notifications: 0,
    oldest_delivered_notification_at: null,
  };
  const incidentCounts = incidentSummary.rows[0] ?? {};
  const coverage = collectorCoverage.rows[0] ?? {};
  const now = Date.now();
  const age = (value: unknown): number | null => {
    const parsed = Date.parse(`${value ?? ""}`);
    return Number.isFinite(parsed) ? Math.max(0, now - parsed) : null;
  };
  const iso = (value: unknown): string | null => {
    const parsed = Date.parse(`${value ?? ""}`);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  };
  return {
    checked_at: new Date(now).toISOString(),
    bay_id: bayId,
    reviewer: {
      cursor_created_at: iso(reviewer.cursor_created_at),
      cursor_id: reviewer.cursor_id ?? null,
      last_started_at: iso(reviewer.last_started_at),
      last_success_at: iso(reviewer.last_success_at),
      last_error_at: iso(reviewer.last_error_at),
      last_error: reviewer.last_error ?? null,
      backlog: Number(pending.count ?? 0),
      oldest_unreviewed_at: iso(pending.oldest),
      oldest_unreviewed_age_ms: age(pending.oldest),
      last_success_age_ms: age(reviewer.last_success_at),
    },
    observations_24h: observations.rows.slice(0, MAX_REPORT_OBSERVATION_GROUPS),
    observations_truncated:
      observations.rows.length > MAX_REPORT_OBSERVATION_GROUPS,
    hosts_24h: hosts.rows.slice(0, MAX_REPORT_HOSTS).map((host) => ({
      ...host,
      latest_observed_at: iso(host.latest_observed_at)!,
    })),
    hosts_truncated: hosts.rows.length > MAX_REPORT_HOSTS,
    collector_coverage: {
      expected_interval_ms: hostIntrusionMonitorIntervalMs(),
      max_observation_age_ms: hostIntrusionObservationMaxAgeMs(),
      active_hosts: Number(coverage.active_hosts ?? 0),
      observed_hosts: Number(coverage.observed_hosts ?? 0),
      overdue_hosts: Number(coverage.overdue_hosts ?? 0),
      oldest_observation_at: iso(coverage.oldest_observation_at),
      oldest_observation_age_ms: age(coverage.oldest_observation_at),
      overdue: overdueHosts.rows.slice(0, MAX_REPORT_HOSTS).map((host) => ({
        host_id: host.host_id,
        host_name: host.host_name ?? null,
        latest_observation_at: iso(host.latest_observation_at),
        latest_observation_age_ms: age(host.latest_observation_at),
      })),
      overdue_truncated: overdueHosts.rows.length > MAX_REPORT_HOSTS,
    },
    findings_24h: findings.rows.slice(0, MAX_REPORT_FINDING_GROUPS),
    findings_truncated: findings.rows.length > MAX_REPORT_FINDING_GROUPS,
    retention: {
      observations: Number(retained.observations ?? 0),
      oldest_observation_at: iso(retained.oldest_observation_at),
      oldest_observation_age_ms: age(retained.oldest_observation_at),
      latest_observation_at: iso(retained.latest_observation_at),
      latest_observation_age_ms: age(retained.latest_observation_at),
      findings: Number(retained.findings ?? 0),
      oldest_finding_at: iso(retained.oldest_finding_at),
      oldest_finding_age_ms: age(retained.oldest_finding_at),
      delivered_notifications: Number(retained.delivered_notifications ?? 0),
      oldest_delivered_notification_at: iso(
        retained.oldest_delivered_notification_at,
      ),
      oldest_delivered_notification_age_ms: age(
        retained.oldest_delivered_notification_at,
      ),
    },
    rules: RULE_CATALOG.map((rule) => ({
      ...rule,
      notification_enabled: notificationRules().has(rule.id),
    })),
    incident_summary: {
      open: Number(incidentCounts.open ?? 0),
      acknowledged: Number(incidentCounts.acknowledged ?? 0),
      suppressed: Number(incidentCounts.suppressed ?? 0),
      critical: Number(incidentCounts.critical ?? 0),
      stale: Number(incidentCounts.stale ?? 0),
      expiring_suppressions: Number(incidentCounts.expiring_suppressions ?? 0),
    },
    incidents: incidents.rows
      .slice(0, MAX_REPORT_INCIDENTS)
      .map((incident) => ({
        ...incident,
        first_seen_at: iso(incident.first_seen_at)!,
        last_seen_at: iso(incident.last_seen_at)!,
        updated_at: iso(incident.updated_at)!,
        suppression_expires_at: iso(incident.suppression_expires_at),
      })),
    incidents_truncated: incidents.rows.length > MAX_REPORT_INCIDENTS,
    notifications: {
      pending: Number(delivery.pending ?? 0),
      failed: Number(delivery.failed ?? 0),
      oldest_pending_at: iso(delivery.oldest_pending),
      oldest_pending_age_ms: age(delivery.oldest_pending),
    },
  };
}

async function runLockedPass(): Promise<void> {
  const maxBatches = boundedInteger(
    "COCALC_HOST_INTRUSION_REVIEW_MAX_BATCHES_PER_TICK",
    DEFAULT_MAX_BATCHES_PER_TICK,
    1,
    20,
  );
  const batchLimit = boundedInteger(
    "COCALC_HOST_INTRUSION_REVIEW_BATCH_LIMIT",
    DEFAULT_BATCH_LIMIT,
    1,
    MAX_BATCH_LIMIT,
  );
  const result = await withSessionAdvisoryLock({
    lockKey: `${LOCK_KEY}:${getConfiguredBayId()}`,
    fn: async () => {
      const total: HostIntrusionReviewerResult = {
        processed: 0,
        findings: 0,
        opened: 0,
        escalated: 0,
        reopened: 0,
        resolved: 0,
        suppressed: 0,
        notifications_delivered: 0,
        notifications_failed: 0,
        findings_pruned: 0,
        outbox_pruned: 0,
      };
      for (let batch = 0; batch < maxBatches; batch++) {
        const current = await runHostIntrusionReviewerPass({ batchLimit });
        for (const key of Object.keys(total) as Array<keyof typeof total>) {
          total[key] += current[key];
        }
        if (current.processed < batchLimit) break;
      }
      return total;
    },
  });
  if (result) logger.info("host intrusion review pass complete", result);
}

export function startHostIntrusionReviewer(): void {
  if (started || process.env.COCALC_HOST_INTRUSION_REVIEWER === "0") return;
  started = true;
  const intervalMs = boundedInteger(
    "COCALC_HOST_INTRUSION_REVIEW_INTERVAL_MS",
    DEFAULT_INTERVAL_MS,
    MIN_INTERVAL_MS,
    24 * 60 * 60 * 1000,
  );
  logger.info("starting host intrusion reviewer", {
    interval_ms: intervalMs,
    notify_rules: [...notificationRules()],
  });
  void runLockedPass().catch((err) => {
    logger.error("host intrusion reviewer pass failed", err);
  });
  const timer = setInterval(() => {
    void runLockedPass().catch((err) => {
      logger.error("host intrusion reviewer pass failed", err);
    });
  }, intervalMs);
  timer.unref?.();
}
