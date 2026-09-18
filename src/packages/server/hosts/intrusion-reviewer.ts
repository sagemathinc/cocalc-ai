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

import { ensureHostIntrusionMonitorSchema } from "./intrusion-monitor";

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
const MAX_REPORT_INCIDENTS = 50;
const PERSISTENCE_WINDOW_MS = 24 * 60 * 60 * 1000;

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
};

export type HostIntrusionReviewerResult = {
  processed: number;
  findings: number;
  opened: number;
  reopened: number;
  resolved: number;
  suppressed: number;
  notifications_delivered: number;
  notifications_failed: number;
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

function boundedDelta(value: unknown): Delta | undefined {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  let remaining = MAX_EVIDENCE_VALUES;
  const result: Delta = {};
  for (const direction of ["added", "removed"] as const) {
    const source = (value as JsonObject)[direction];
    if (source == null || typeof source !== "object" || Array.isArray(source)) {
      continue;
    }
    const selected: Record<string, string[]> = {};
    for (const [category, entries] of Object.entries(source as JsonObject)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 50)) {
      if (!Array.isArray(entries) || remaining <= 0) continue;
      const strings = entries
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.slice(0, 4096))
        .slice(0, remaining);
      remaining -= strings.length;
      if (strings.length) selected[category.slice(0, 200)] = strings;
    }
    if (Object.keys(selected).length) result[direction] = selected;
  }
  return result.added || result.removed ? result : undefined;
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

function changeRemains(delta: Delta, normalized: unknown): boolean {
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

function deltaCategories(delta: Delta): string[] {
  return [
    ...new Set([
      ...Object.keys(delta.added ?? {}),
      ...Object.keys(delta.removed ?? {}),
    ]),
  ].sort();
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
      };
      return result.id && result.bay_id && result.expires_at ? [result] : [];
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
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${FINDINGS} (
        id UUID PRIMARY KEY,
        observation_id UUID NOT NULL,
        bay_id TEXT NOT NULL,
        host_id UUID NOT NULL,
        rule_id TEXT NOT NULL,
        rule_version INTEGER NOT NULL,
        classification TEXT NOT NULL,
        severity TEXT NOT NULL,
        evidence JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (observation_id, rule_id, rule_version)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ${FINDINGS}_host_rule_created_idx
      ON ${FINDINGS} (host_id, rule_id, created_at DESC)
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
        incident_id UUID NOT NULL,
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
    `SELECT id, state, severity, suppression_expires_at, occurrence_count
       FROM ${INCIDENTS} WHERE fingerprint=$1 FOR UPDATE`,
    [fingerprint],
  );
  const existing = rows[0] as IncidentRow | undefined;
  const now = new Date();
  const suppressed =
    expected != null && Date.parse(expected.expires_at) >= now.getTime();
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
        JSON.stringify(evidence),
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

  const suppressionExpired =
    existing.state === "suppressed" &&
    existing.suppression_expires_at != null &&
    Date.parse(`${existing.suppression_expires_at}`) < now.getTime();
  const reopens = existing.state === "resolved" || suppressionExpired;
  await client.query(
    `UPDATE ${INCIDENTS}
        SET state=$2,
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
      JSON.stringify(evidence),
      expected?.id ?? null,
      expected?.expires_at ?? null,
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
      WHERE bay_id=$1 AND host_id=$2 AND state IN ('open','acknowledged')
      ORDER BY updated_at DESC LIMIT 50 FOR UPDATE`,
    [getConfiguredBayId(), observation.host_id],
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
        : delta != null && !changeRemains(delta, normalized);
    if (!recovered) continue;
    await client.query(
      `UPDATE ${INCIDENTS}
          SET state='resolved', resolved_at=$2, updated_at=NOW()
        WHERE id=$1 AND state IN ('open','acknowledged')`,
      [incident.id, observation.created_at],
    );
    result.resolved += 1;
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
  const actionableDelta = boundedDelta(observation.decision.actionable_delta);

  if (observation.coverage === "complete") {
    await resolveIncidents(client, observation, observation.normalized, result);
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
    const evidence = {
      status: "candidate",
      delta_fingerprint: sha256(stableJson(actionableDelta)),
      delta: actionableDelta,
      categories: deltaCategories(actionableDelta),
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
      `SELECT observation_id, evidence
         FROM ${FINDINGS}
        WHERE bay_id=$1 AND host_id=$2 AND rule_id='persistent-host-state'
          AND rule_version=$3 AND classification='diagnostic'
          AND created_at >= NOW() - ($4::double precision * INTERVAL '1 millisecond')
        ORDER BY created_at DESC LIMIT 20`,
      [
        getConfiguredBayId(),
        observation.host_id,
        RULE_VERSION,
        PERSISTENCE_WINDOW_MS,
      ],
    );
    const candidate = (rows as CandidateFinding[]).find((row) => {
      const delta = boundedDelta(row.evidence.delta);
      return delta != null && changeRemains(delta, observation.normalized);
    });
    if (candidate) {
      const delta = boundedDelta(candidate.evidence.delta)!;
      const evidence = {
        status: "confirmed",
        candidate_observation_id: candidate.observation_id,
        delta_fingerprint: candidate.evidence.delta_fingerprint,
        delta,
        categories: deltaCategories(delta),
      };
      if (
        await insertFinding(client, {
          observation,
          ruleId: "persistent-host-state",
          classification: "actionable",
          severity: "warning",
          evidence,
        })
      ) {
        result.findings += 1;
        const expected = matchExpectedChange({
          bayId: getConfiguredBayId(),
          hostId: observation.host_id,
          categories: deltaCategories(delta),
          at: new Date(observation.created_at),
        });
        await openIncident(client, {
          observation,
          ruleId: "persistent-host-state",
          severity: "warning",
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
    reopened: 0,
    resolved: 0,
    suppressed: 0,
    notifications_delivered: 0,
    notifications_failed: 0,
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
         JOIN ${STATE} AS state ON state.bay_id=$1
        WHERE observations.bay_id=$1
          AND (state.cursor_created_at IS NULL OR
               (observations.created_at, observations.id) >
               (state.cursor_created_at, state.cursor_id))
        ORDER BY observations.created_at, observations.id
        LIMIT $4`,
      [bayId, MAX_STORED_PHYSICAL_BYTES, MAX_STORED_JSON_BYTES, limit],
    );
    for (const observation of observations.rows) {
      await reviewObservation(client, observation, result);
      result.processed += 1;
    }
    const last = observations.rows.at(-1);
    await client.query(
      `UPDATE ${STATE}
          SET cursor_created_at=COALESCE(
                (SELECT created_at FROM ${OBSERVATIONS} WHERE id=$2),
                cursor_created_at
              ),
              cursor_id=COALESCE($2, cursor_id),
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
  const [state, backlog, observations, incidents, notifications] =
    await Promise.all([
      boundedQuery(
        `SELECT cursor_created_at, cursor_id, last_started_at, last_success_at,
                last_error_at, last_error
           FROM ${STATE} WHERE bay_id=$1`,
        [bayId],
      ),
      boundedQuery(
        `SELECT COUNT(*)::integer AS count, MIN(observations.created_at) AS oldest
           FROM ${OBSERVATIONS} AS observations
           LEFT JOIN ${STATE} AS state ON state.bay_id=$1
          WHERE observations.bay_id=$1
            AND (state.cursor_created_at IS NULL OR
                 (observations.created_at, observations.id) >
                 (state.cursor_created_at, state.cursor_id))`,
        [bayId],
      ),
      boundedQuery(
        `SELECT coverage,
                CASE
                  WHEN pg_column_size(decision) > $2 THEN 'oversized'
                  ELSE COALESCE(NULLIF(decision->>'classification',''), 'legacy')
                END AS classification,
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
          GROUP BY coverage, classification, normalization_version, decision_policy_version
          ORDER BY coverage, classification, normalization_version, decision_policy_version`,
        [bayId, MAX_STORED_PHYSICAL_BYTES],
      ),
      boundedQuery(
        `SELECT id, host_id, rule_id, rule_version, severity, confidence, state,
                first_seen_at, last_seen_at, updated_at, occurrence_count,
                suppression_ref, suppression_expires_at, last_notification_transition
           FROM ${INCIDENTS}
          WHERE bay_id=$1 AND state IN ('open','acknowledged','suppressed')
          ORDER BY updated_at DESC LIMIT $2`,
        [bayId, MAX_REPORT_INCIDENTS],
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
    observations_24h: observations.rows,
    incidents: incidents.rows.map((incident) => ({
      ...incident,
      first_seen_at: iso(incident.first_seen_at)!,
      last_seen_at: iso(incident.last_seen_at)!,
      updated_at: iso(incident.updated_at)!,
      suppression_expires_at: iso(incident.suppression_expires_at),
    })),
    incidents_truncated: incidents.rows.length >= MAX_REPORT_INCIDENTS,
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
        reopened: 0,
        resolved: 0,
        suppressed: 0,
        notifications_delivered: 0,
        notifications_failed: 0,
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
