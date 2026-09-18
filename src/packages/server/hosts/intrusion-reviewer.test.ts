/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";

import getPool from "@cocalc/database/pool";

const mockAdminAlert = jest.fn();

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "intrusion-review-test",
}));
jest.mock("@cocalc/server/messages/admin-alert", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockAdminAlert(...args),
}));

import {
  ensureHostIntrusionReviewerSchema,
  getHostIntrusionReviewReport,
  runHostIntrusionReviewerPass,
} from "./intrusion-reviewer";

const BAY_ID = "intrusion-review-test";
const HOST_ID = "b2bc9a4d-a740-4290-94ea-50afac3007db";
const ADDED_VALUE = '["unexpected.service","enabled"]';

function normalized(signals: Record<string, string[]> = {}) {
  return {
    version: 2,
    identity: { hostname: "host-1", kernel: "6.8", boot_id: "boot" },
    coverage: "complete",
    signals,
    counters: {
      scanned_process_count: 1,
      host_process_count: 1,
      authentication_failed_7d: 0,
      authentication_invalid_user_7d: 0,
      kernel_signals_7d: {},
    },
    issues: [],
    truncated: [],
  };
}

async function insertObservation({
  id = randomUUID(),
  hostId = HOST_ID,
  coverage = "complete",
  classification = "inventory",
  reasonCodes = ["no_normalized_delta"],
  actionableDelta,
  state = normalized(),
  createdAt = new Date(),
}: {
  id?: string;
  hostId?: string;
  coverage?: string;
  classification?: string;
  reasonCodes?: string[];
  actionableDelta?: Record<string, unknown>;
  state?: Record<string, unknown>;
  createdAt?: Date;
} = {}): Promise<string> {
  await getPool().query(
    `INSERT INTO project_host_intrusion_snapshots
       (id, host_id, bay_id, captured_at, duration_ms, coverage,
        normalization_version, fingerprint, normalized, decision_policy_version,
        decision, baseline, baseline_eligible, created_at)
     VALUES ($1,$2,$3,$4,1,$5,2,$6,$7::jsonb,1,$8::jsonb,
             '{"kind":"host","snapshot_ids":[]}'::jsonb,$9,$4)`,
    [
      id,
      hostId,
      BAY_ID,
      createdAt,
      coverage,
      `fingerprint-${id}`,
      JSON.stringify(state),
      JSON.stringify({
        version: 1,
        classification,
        reason_codes: reasonCodes,
        ...(actionableDelta ? { actionable_delta: actionableDelta } : {}),
        notification_policy: "incidents-only",
        diagnostic_verbosity: "actionable",
      }),
      coverage === "complete",
    ],
  );
  return id;
}

async function clearData(): Promise<void> {
  const pool = getPool();
  await pool.query("DELETE FROM project_host_intrusion_notification_outbox");
  await pool.query("DELETE FROM project_host_intrusion_incidents");
  await pool.query("DELETE FROM project_host_intrusion_findings");
  await pool.query("DELETE FROM project_host_intrusion_review_state");
  await pool.query(
    "DELETE FROM project_host_intrusion_snapshots WHERE bay_id=$1",
    [BAY_ID],
  );
}

describe("project-host intrusion reviewer", () => {
  beforeAll(async () => {
    await ensureHostIntrusionReviewerSchema();
  });

  beforeEach(async () => {
    delete process.env.COCALC_HOST_INTRUSION_REVIEW_NOTIFY_RULES;
    delete process.env.COCALC_HOST_INTRUSION_EXPECTED_CHANGES;
    mockAdminAlert.mockReset();
    mockAdminAlert.mockResolvedValue(undefined);
    await clearData();
  });

  afterAll(async () => {
    await clearData();
  });

  it("advances a durable cursor and replays idempotently", async () => {
    await insertObservation();
    await expect(runHostIntrusionReviewerPass()).resolves.toMatchObject({
      processed: 1,
      findings: 1,
      opened: 0,
    });
    await expect(runHostIntrusionReviewerPass()).resolves.toMatchObject({
      processed: 0,
      findings: 0,
    });
    const report = await getHostIntrusionReviewReport();
    expect(report.reviewer).toMatchObject({
      backlog: 0,
      cursor_id: expect.any(String),
      last_success_at: expect.any(String),
    });
    expect(report.observations_24h).toEqual([
      expect.objectContaining({ truncated: 0 }),
    ]);
    expect(mockAdminAlert).not.toHaveBeenCalled();
  });

  it("preserves PostgreSQL timestamp precision in the durable cursor", async () => {
    const id = await insertObservation();
    await getPool().query(
      `UPDATE project_host_intrusion_snapshots
          SET created_at=created_at + INTERVAL '111 microseconds'
        WHERE id=$1`,
      [id],
    );

    await expect(runHostIntrusionReviewerPass()).resolves.toMatchObject({
      processed: 1,
    });
    await expect(runHostIntrusionReviewerPass()).resolves.toMatchObject({
      processed: 0,
    });
    await expect(getHostIntrusionReviewReport()).resolves.toMatchObject({
      reviewer: { backlog: 0 },
    });
  });

  it("opens one stable incident only after a later complete confirmation", async () => {
    const delta = { added: { "services.enabled": [ADDED_VALUE] } };
    const changed = normalized({ "services.enabled": [ADDED_VALUE] });
    await insertObservation({
      classification: "actionable",
      reasonCodes: ["actionable_selector_match"],
      actionableDelta: delta,
      state: changed,
      createdAt: new Date(Date.now() - 1000),
    });
    await insertObservation({ state: changed });

    await expect(runHostIntrusionReviewerPass()).resolves.toMatchObject({
      processed: 2,
      opened: 1,
    });
    const first = await getPool().query(
      "SELECT id, state, occurrence_count FROM project_host_intrusion_incidents",
    );
    expect(first.rows).toEqual([
      expect.objectContaining({ state: "open", occurrence_count: 1 }),
    ]);
    const incidentId = first.rows[0]!.id;

    await insertObservation({ state: changed });
    await runHostIntrusionReviewerPass();
    const repeated = await getPool().query(
      "SELECT id, state FROM project_host_intrusion_incidents",
    );
    expect(repeated.rows).toEqual([{ id: incidentId, state: "open" }]);
    expect(mockAdminAlert).not.toHaveBeenCalled();
  });

  it("uses a durable outbox and emits exactly one approved open transition", async () => {
    process.env.COCALC_HOST_INTRUSION_REVIEW_NOTIFY_RULES =
      "persistent-host-state";
    const delta = { added: { "services.enabled": [ADDED_VALUE] } };
    const changed = normalized({ "services.enabled": [ADDED_VALUE] });
    await insertObservation({
      classification: "actionable",
      reasonCodes: ["actionable_selector_match"],
      actionableDelta: delta,
      state: changed,
      createdAt: new Date(Date.now() - 1000),
    });
    await insertObservation({ state: changed });
    await runHostIntrusionReviewerPass();
    await runHostIntrusionReviewerPass();
    expect(mockAdminAlert).toHaveBeenCalledTimes(1);
    const outbox = await getPool().query(
      "SELECT state, attempts, transition FROM project_host_intrusion_notification_outbox",
    );
    expect(outbox.rows).toEqual([
      { state: "delivered", attempts: 1, transition: "open" },
    ]);
  });

  it("does not roll back an incident when notification delivery fails", async () => {
    process.env.COCALC_HOST_INTRUSION_REVIEW_NOTIFY_RULES = "coverage-loss";
    mockAdminAlert.mockRejectedValueOnce(new Error("mail unavailable"));
    await insertObservation({
      coverage: "partial",
      classification: "coverage_loss",
      reasonCodes: ["coverage_failure_threshold_reached"],
      state: { ...normalized(), coverage: "partial" },
    });
    await expect(runHostIntrusionReviewerPass()).resolves.toMatchObject({
      opened: 1,
      notifications_failed: 1,
    });
    const incident = await getPool().query(
      "SELECT state FROM project_host_intrusion_incidents",
    );
    expect(incident.rows).toEqual([{ state: "open" }]);
    const outbox = await getPool().query(
      "SELECT state, attempts FROM project_host_intrusion_notification_outbox",
    );
    expect(outbox.rows).toEqual([{ state: "pending", attempts: 1 }]);

    await runHostIntrusionReviewerPass();
    expect(mockAdminAlert).toHaveBeenCalledTimes(2);
    await expect(
      getPool().query(
        "SELECT state, attempts FROM project_host_intrusion_notification_outbox",
      ),
    ).resolves.toMatchObject({
      rows: [{ state: "delivered", attempts: 2 }],
    });
  });

  it("resolves and reopens the same persistent-state incident", async () => {
    process.env.COCALC_HOST_INTRUSION_REVIEW_NOTIFY_RULES =
      "persistent-host-state";
    const delta = { added: { "services.enabled": [ADDED_VALUE] } };
    const changed = normalized({ "services.enabled": [ADDED_VALUE] });
    const candidate = async () =>
      await insertObservation({
        classification: "actionable",
        reasonCodes: ["actionable_selector_match"],
        actionableDelta: delta,
        state: changed,
        createdAt: new Date(Date.now() - 1000),
      });
    await candidate();
    await insertObservation({ state: changed });
    await runHostIntrusionReviewerPass();
    const opened = await getPool().query(
      "SELECT id FROM project_host_intrusion_incidents",
    );

    await insertObservation({ state: normalized() });
    await expect(runHostIntrusionReviewerPass()).resolves.toMatchObject({
      resolved: 1,
    });
    await candidate();
    await insertObservation({ state: changed });
    await expect(runHostIntrusionReviewerPass()).resolves.toMatchObject({
      reopened: 1,
    });
    const reopened = await getPool().query(
      "SELECT id, state FROM project_host_intrusion_incidents",
    );
    expect(reopened.rows).toEqual([{ id: opened.rows[0]!.id, state: "open" }]);
    expect(mockAdminAlert).toHaveBeenCalledTimes(2);
  });

  it("does not resolve a complete-coverage incident from partial evidence", async () => {
    const delta = { added: { "services.enabled": [ADDED_VALUE] } };
    const changed = normalized({ "services.enabled": [ADDED_VALUE] });
    await insertObservation({
      classification: "actionable",
      reasonCodes: ["actionable_selector_match"],
      actionableDelta: delta,
      state: changed,
      createdAt: new Date(Date.now() - 1000),
    });
    await insertObservation({ state: changed });
    await runHostIntrusionReviewerPass();

    await insertObservation({
      coverage: "partial",
      classification: "coverage_loss",
      reasonCodes: ["coverage_partial"],
      state: { ...normalized(), coverage: "partial" },
    });
    await expect(runHostIntrusionReviewerPass()).resolves.toMatchObject({
      resolved: 0,
    });
    await expect(
      getPool().query("SELECT state FROM project_host_intrusion_incidents"),
    ).resolves.toMatchObject({ rows: [{ state: "open" }] });
  });

  it("retains an explicitly scoped expected change without notification", async () => {
    process.env.COCALC_HOST_INTRUSION_REVIEW_NOTIFY_RULES =
      "persistent-host-state";
    process.env.COCALC_HOST_INTRUSION_EXPECTED_CHANGES = JSON.stringify([
      {
        id: "maintenance-1",
        bay_id: BAY_ID,
        host_ids: [HOST_ID],
        categories: ["services.enabled"],
        starts_at: new Date(Date.now() - 60_000).toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        reason: "staging fixture",
      },
    ]);
    const delta = { added: { "services.enabled": [ADDED_VALUE] } };
    const changed = normalized({ "services.enabled": [ADDED_VALUE] });
    await insertObservation({
      classification: "actionable",
      reasonCodes: ["actionable_selector_match"],
      actionableDelta: delta,
      state: changed,
      createdAt: new Date(Date.now() - 1000),
    });
    await insertObservation({ state: changed });
    await expect(runHostIntrusionReviewerPass()).resolves.toMatchObject({
      suppressed: 1,
    });
    await expect(
      getPool().query(
        "SELECT state, suppression_ref FROM project_host_intrusion_incidents",
      ),
    ).resolves.toMatchObject({
      rows: [{ state: "suppressed", suppression_ref: "maintenance-1" }],
    });
    expect(mockAdminAlert).not.toHaveBeenCalled();
  });

  it("makes an expired suppression reviewable again", async () => {
    process.env.COCALC_HOST_INTRUSION_REVIEW_NOTIFY_RULES =
      "persistent-host-state";
    process.env.COCALC_HOST_INTRUSION_EXPECTED_CHANGES = JSON.stringify([
      {
        id: "maintenance-expiring",
        bay_id: BAY_ID,
        host_ids: [HOST_ID],
        categories: ["services.enabled"],
        starts_at: new Date(Date.now() - 60_000).toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        reason: "staging fixture",
      },
    ]);
    const delta = { added: { "services.enabled": [ADDED_VALUE] } };
    const changed = normalized({ "services.enabled": [ADDED_VALUE] });
    await insertObservation({
      classification: "actionable",
      reasonCodes: ["actionable_selector_match"],
      actionableDelta: delta,
      state: changed,
      createdAt: new Date(Date.now() - 1000),
    });
    await insertObservation({ state: changed });
    await runHostIntrusionReviewerPass();

    delete process.env.COCALC_HOST_INTRUSION_EXPECTED_CHANGES;
    await getPool().query(
      `UPDATE project_host_intrusion_incidents
          SET suppression_expires_at=NOW() - INTERVAL '1 minute'`,
    );
    await insertObservation({ state: changed });
    await expect(runHostIntrusionReviewerPass()).resolves.toMatchObject({
      reopened: 1,
      notifications_delivered: 1,
    });
    await expect(
      getPool().query("SELECT state FROM project_host_intrusion_incidents"),
    ).resolves.toMatchObject({ rows: [{ state: "open" }] });
  });

  it("reopens a suppressed incident when its expected change is removed", async () => {
    process.env.COCALC_HOST_INTRUSION_REVIEW_NOTIFY_RULES =
      "persistent-host-state";
    process.env.COCALC_HOST_INTRUSION_EXPECTED_CHANGES = JSON.stringify([
      {
        id: "maintenance-removed",
        bay_id: BAY_ID,
        host_ids: [HOST_ID],
        categories: ["services.enabled"],
        starts_at: new Date(Date.now() - 60_000).toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        reason: "staging fixture",
      },
    ]);
    const delta = { added: { "services.enabled": [ADDED_VALUE] } };
    const changed = normalized({ "services.enabled": [ADDED_VALUE] });
    await insertObservation({
      classification: "actionable",
      reasonCodes: ["actionable_selector_match"],
      actionableDelta: delta,
      state: changed,
      createdAt: new Date(Date.now() - 1000),
    });
    await insertObservation({ state: changed });
    await runHostIntrusionReviewerPass();

    delete process.env.COCALC_HOST_INTRUSION_EXPECTED_CHANGES;
    await insertObservation({ state: changed });
    await expect(runHostIntrusionReviewerPass()).resolves.toMatchObject({
      reopened: 1,
      notifications_delivered: 1,
    });
    await expect(
      getPool().query(
        "SELECT state, suppression_ref, suppression_expires_at FROM project_host_intrusion_incidents",
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          state: "open",
          suppression_ref: null,
          suppression_expires_at: null,
        },
      ],
    });
  });

  it("bounds batch work, rejects foreign bays, and reports backlog", async () => {
    for (let i = 0; i < 3; i++) {
      await insertObservation({
        hostId: randomUUID(),
        createdAt: new Date(Date.now() + i),
      });
    }
    await expect(
      runHostIntrusionReviewerPass({ batchLimit: 1 }),
    ).resolves.toMatchObject({ processed: 1 });
    const report = await getHostIntrusionReviewReport();
    expect(report.reviewer.backlog).toBe(2);
    await expect(
      getHostIntrusionReviewReport({ bayId: "another-bay" }),
    ).rejects.toThrow("not authoritative");
  });

  it("does not advance the cursor when finding persistence rolls back", async () => {
    await insertObservation();
    await getPool().query(
      `ALTER TABLE project_host_intrusion_findings
       ADD CONSTRAINT intrusion_review_test_rollback
       CHECK (classification <> 'inventory')`,
    );
    try {
      await expect(runHostIntrusionReviewerPass()).rejects.toThrow();
      const state = await getPool().query(
        "SELECT cursor_id FROM project_host_intrusion_review_state WHERE bay_id=$1",
        [BAY_ID],
      );
      expect(state.rows[0]?.cursor_id ?? null).toBeNull();
      await expect(
        getPool().query(
          "SELECT COUNT(*)::integer AS count FROM project_host_intrusion_findings",
        ),
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await getPool().query(
        `ALTER TABLE project_host_intrusion_findings
         DROP CONSTRAINT intrusion_review_test_rollback`,
      );
    }
    await expect(runHostIntrusionReviewerPass()).resolves.toMatchObject({
      processed: 1,
      findings: 1,
    });
  });

  it("classifies oversized stored evidence without materializing it", async () => {
    await insertObservation({
      state: { ...normalized(), padding: "x".repeat(1024 * 1024 + 1000) },
    });
    await expect(runHostIntrusionReviewerPass()).resolves.toMatchObject({
      processed: 1,
      findings: 1,
      opened: 0,
    });
    const finding = await getPool().query(
      "SELECT rule_id, classification, evidence FROM project_host_intrusion_findings",
    );
    expect(finding.rows).toEqual([
      {
        rule_id: "observation-integrity",
        classification: "diagnostic",
        evidence: { reason: "stored_evidence_oversized_or_unreadable" },
      },
    ]);
  });
});
