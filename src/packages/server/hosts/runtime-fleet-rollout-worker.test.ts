/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { __test__ } from "./runtime-fleet-rollout-worker";
import { after, before, getPool } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import {
  ensureProjectMaintenanceStatusTable,
  getProjectRecoveryAttemptHealth,
} from "@cocalc/server/projects/maintenance-status";

describe("host runtime fleet rollout planning", () => {
  test("accepts an aligned build whose deployment and build IDs differ", () => {
    expect(
      __test__.runtimeObservationIsStable({
        version: "artifact-v2",
        components: ["project-host"],
        status: {
          host_id: "host-a",
          configured: [],
          effective: [],
          observed_artifacts: [
            {
              artifact: "project-host",
              current_version: "artifact-v2",
              current_build_id: "build-v2",
              installed_versions: ["artifact-v2"],
            },
          ],
          observed_components: [
            {
              component: "project-host",
              artifact: "project-host",
              runtime_state: "running",
              version_state: "aligned",
              running_versions: ["build-v2"],
              running_pids: [123],
            },
          ],
          observed_targets: [],
          observed_host_agent: {
            project_host: {
              rollout: {
                phase: "promoted",
                target_version: "artifact-v2",
                running_version: "artifact-v2",
                healthy: true,
              },
            },
          },
        },
      }),
    ).toBe(true);
  });

  test("rejects an artifact after the host agent rolls it back", () => {
    expect(
      __test__.runtimeObservationIsStable({
        version: "artifact-v2",
        components: ["project-host"],
        status: {
          host_id: "host-a",
          configured: [],
          effective: [],
          observed_artifacts: [
            {
              artifact: "project-host",
              current_version: "artifact-v1",
              installed_versions: ["artifact-v1", "artifact-v2"],
            },
          ],
          observed_components: [
            {
              component: "project-host",
              artifact: "project-host",
              runtime_state: "running",
              version_state: "aligned",
              running_versions: ["build-v1"],
              running_pids: [123],
            },
          ],
          observed_targets: [],
          observed_host_agent: {
            project_host: {
              rollout: {
                phase: "rolled_back",
                target_version: "artifact-v2",
                running_version: "artifact-v1",
                healthy: false,
              },
            },
          },
        },
      }),
    ).toBe(false);
  });

  test("requires every selected auxiliary component to be aligned without changing the host runtime", () => {
    const status = {
      host_id: "host-a",
      configured: [],
      effective: [],
      observed_artifacts: [
        {
          artifact: "project-host" as const,
          current_version: "artifact-v2",
          installed_versions: ["artifact-v2"],
        },
      ],
      observed_components: [
        {
          component: "project-host" as const,
          artifact: "project-host" as const,
          runtime_state: "running" as const,
          version_state: "aligned" as const,
          running_versions: ["build-v2"],
          running_pids: [123],
        },
        {
          component: "acp-worker" as const,
          artifact: "project-host" as const,
          runtime_state: "running" as const,
          version_state: "drifted" as const,
          running_versions: ["build-v1"],
          running_pids: [456],
        },
      ],
      observed_targets: [],
      observed_host_agent: {
        project_host: {
          rollout: {
            phase: "promoted" as const,
            target_version: "artifact-v2",
            running_version: "artifact-v2",
            healthy: true,
          },
        },
      },
    };
    expect(
      __test__.runtimeObservationIsStable({
        status,
        version: "artifact-v2",
        components: ["acp-worker"],
      }),
    ).toBe(false);
    status.observed_components[1].version_state = "aligned";
    status.observed_artifacts[0].current_version = "artifact-v1";
    status.observed_host_agent.project_host.rollout.target_version =
      "artifact-v1";
    status.observed_host_agent.project_host.rollout.running_version =
      "artifact-v1";
    expect(
      __test__.runtimeObservationIsStable({
        status,
        version: "artifact-v2",
        components: ["acp-worker"],
      }),
    ).toBe(true);
    status.observed_components[1].version_state = "drifted";
    status.observed_components[1].running_versions = ["artifact-v2"];
    expect(
      __test__.runtimeObservationIsStable({
        status,
        version: "artifact-v2",
        components: ["acp-worker"],
      }),
    ).toBe(false);
  });

  test("accepts the desired ACP worker while an old worker drains", () => {
    expect(
      __test__.runtimeObservationIsStable({
        version: "artifact-v2",
        components: ["acp-worker"],
        status: {
          host_id: "host-a",
          configured: [],
          effective: [],
          observed_components: [
            {
              component: "acp-worker",
              artifact: "project-host",
              upgrade_policy: "drain_then_replace",
              runtime_state: "running",
              version_state: "mixed",
              desired_version: "build-v2",
              running_versions: ["build-v1", "build-v2"],
              running_pids: [123, 456],
            },
          ],
          observed_targets: [],
        },
      }),
    ).toBe(true);
  });

  test("accepts a staged auxiliary router only when it runs the requested artifact", () => {
    expect(
      __test__.runtimeObservationIsStable({
        version: "artifact-v2",
        components: ["conat-router"],
        status: {
          host_id: "host-a",
          configured: [],
          effective: [],
          observed_artifacts: [
            {
              artifact: "project-host",
              current_version: "artifact-v1",
              current_build_id: "build-v1",
              installed_versions: ["artifact-v1", "artifact-v2"],
            },
          ],
          observed_components: [
            {
              component: "conat-router",
              artifact: "project-host",
              runtime_state: "running",
              version_state: "drifted",
              running_versions: ["artifact-v2"],
              running_pids: [456],
            },
          ],
          observed_targets: [],
        },
      }),
    ).toBe(true);
  });

  test("records one exact runtime identity for each promoted component", () => {
    expect(
      __test__.componentRuntimeVersionsForPromotion({
        components: ["acp-worker"],
        statuses: ["host-a", "host-b"].map((host_id) => ({
          host_id,
          configured: [],
          effective: [],
          observed_components: [
            {
              component: "acp-worker",
              artifact: "project-host",
              runtime_state: "running",
              version_state: "aligned",
              running_versions: ["build-v2"],
              running_pids: [456],
            },
          ],
        })),
      }),
    ).toEqual({ "acp-worker": "build-v2" });
  });

  test("promotes the desired ACP identity while older workers drain", () => {
    expect(
      __test__.componentRuntimeVersionsForPromotion({
        components: ["acp-worker"],
        statuses: ["host-a", "host-b"].map((host_id) => ({
          host_id,
          configured: [],
          effective: [],
          observed_components: [
            {
              component: "acp-worker",
              artifact: "project-host",
              upgrade_policy: "drain_then_replace",
              runtime_state: "running",
              version_state: "mixed",
              desired_version: "build-v2",
              running_versions: ["build-v1", "build-v2"],
              running_pids: [456, 789],
            },
          ],
        })),
      }),
    ).toEqual({ "acp-worker": "build-v2" });
  });

  test("refuses promotion when component runtime identities differ", () => {
    expect(() =>
      __test__.componentRuntimeVersionsForPromotion({
        components: ["acp-worker"],
        statuses: ["build-v2", "unexpected-build"].map(
          (running_version, index) => ({
            host_id: `host-${index}`,
            configured: [],
            effective: [],
            observed_components: [
              {
                component: "acp-worker",
                artifact: "project-host",
                runtime_state: "running",
                version_state: "aligned",
                running_versions: [running_version],
                running_pids: [456 + index],
              },
            ],
          }),
        ),
      }),
    ).toThrow("hosts disagree on runtime version");
  });

  test("defaults old durable operations to project-host and rejects invalid input", () => {
    expect(__test__.normalizedRolloutComponents(undefined)).toEqual([
      "project-host",
    ]);
    expect(
      __test__.normalizedRolloutComponents(["acp-worker", "acp-worker"]),
    ).toEqual(["acp-worker"]);
    expect(() => __test__.normalizedRolloutComponents(["unknown"])).toThrow(
      "unsupported managed component",
    );
  });

  test("promotes only selected auxiliary components with service-specific policies", () => {
    expect(
      __test__.runtimeDeploymentsForPromotion({
        version: "artifact-v2",
        components: ["conat-router", "acp-worker"],
        reason: "test",
        metadata: { campaign: "op-1" },
      }),
    ).toEqual([
      expect.objectContaining({
        target_type: "component",
        target: "conat-router",
        rollout_policy: "restart_now",
      }),
      expect.objectContaining({
        target_type: "component",
        target: "acp-worker",
        rollout_policy: "drain_then_replace",
      }),
    ]);
  });

  test("promotes the artifact only when project-host is selected", () => {
    expect(
      __test__.runtimeDeploymentsForPromotion({
        version: "artifact-v2",
        components: ["project-host", "acp-worker"],
        metadata: { campaign: "op-2" },
      }),
    ).toEqual([
      expect.objectContaining({
        target_type: "artifact",
        target: "project-host",
        desired_version: "artifact-v2",
      }),
      expect.objectContaining({
        target_type: "component",
        target: "project-host",
      }),
      expect.objectContaining({
        target_type: "component",
        target: "acp-worker",
      }),
    ]);
  });

  test("isolates the canary before bounded waves", () => {
    expect(
      __test__.buildRolloutWaves({
        host_ids: ["canary", "host-b", "host-c", "host-d", "host-e"],
        completed_host_ids: new Set(),
        canary_host_id: "canary",
        max_concurrent: 2,
        canary_stabilize_seconds: 180,
        stabilize_seconds: 60,
      }),
    ).toEqual([
      { ids: ["canary"], stabilize_seconds: 180 },
      { ids: ["host-b", "host-c"], stabilize_seconds: 60 },
      { ids: ["host-d", "host-e"], stabilize_seconds: 60 },
    ]);
  });

  test("resumes after durable successful hosts without repeating them", () => {
    expect(
      __test__.buildRolloutWaves({
        host_ids: ["canary", "host-b", "host-c"],
        completed_host_ids: new Set(["canary", "host-b"]),
        canary_host_id: "canary",
        max_concurrent: 2,
        canary_stabilize_seconds: 180,
        stabilize_seconds: 60,
      }),
    ).toEqual([{ ids: ["host-c"], stabilize_seconds: 60 }]);
  });
});

describe("fleet recovery stop gates", () => {
  type Snapshot = Parameters<
    typeof __test__.recoveryStopGateFailure
  >[0]["baseline"];
  const baseline = (): Snapshot => ({
    checked_at: "2026-09-24T04:00:00.000Z",
    recovery_level: "healthy",
    latency_level: "healthy",
    hosts: {
      canary: {
        oldest_backup_delay_seconds: 100,
        emergency_seconds: 0,
        latest_valid_pressure_at: "2026-09-24T04:00:00.000Z",
      },
    },
  });
  const current = (): Snapshot => ({
    ...baseline(),
    checked_at: "2026-09-24T04:02:00.000Z",
    hosts: {
      canary: {
        ...baseline().hosts.canary,
        oldest_backup_delay_seconds: 220,
        latest_valid_pressure_at: "2026-09-24T04:02:00.000Z",
      },
    },
  });
  const gate = (after: Snapshot, before = baseline()) =>
    __test__.recoveryStopGateFailure({
      baseline: before,
      current: after,
      host_ids: ["canary"],
    });

  test("accepts naturally aging debt with stable health and telemetry", () => {
    expect(gate(current())).toBeUndefined();
  });

  test("stops when latency or recovery health degrades", () => {
    expect(gate({ ...current(), latency_level: "warning" })).toMatch(/latency/);
    expect(gate({ ...current(), recovery_level: "critical" })).toMatch(
      /recovery/,
    );
    expect(gate({ ...current(), recovery_level: "unknown" })).toMatch(
      /unknown/,
    );
    expect(
      gate(current(), { ...baseline(), recovery_level: "unknown" }),
    ).toMatch(/baseline is unknown/);
    expect(
      __test__.recoveryStopGateFailure({
        baseline: { ...baseline(), latency_level: "unknown" },
        current: { ...current(), latency_level: "unknown" },
        host_ids: ["canary"],
        require_measured_latency: true,
      }),
    ).toMatch(/global promotion requires browser latency samples/);
  });

  test("stops on a backup age jump or emergency pressure", () => {
    const ageJump = current();
    ageJump.hosts.canary.oldest_backup_delay_seconds = 600;
    expect(gate(ageJump)).toMatch(/backup debt age/);

    const pressure = current();
    pressure.hosts.canary.emergency_seconds = 30;
    expect(gate(pressure)).toMatch(/emergency storage pressure/);
  });

  test("ignores legacy aggregate failure counters in saved snapshots", () => {
    const before = baseline();
    const after = current();
    Object.assign(before.hosts.canary, { failed_attempts: 2 });
    Object.assign(after.hosts.canary, { failed_attempts: 3 });
    expect(gate(after, before)).toBeUndefined();
  });

  test("stops on lost pressure telemetry and rejects incomplete saved baselines", () => {
    const stale = current();
    stale.hosts.canary.latest_valid_pressure_at = "2026-09-24T03:50:00.000Z";
    expect(gate(stale)).toMatch(/lost fresh storage pressure telemetry/);
    expect(
      __test__.savedRecoveryStopGateBaseline(baseline(), ["canary"]),
    ).toEqual(baseline());
    expect(
      __test__.savedRecoveryStopGateBaseline(baseline(), ["other"]),
    ).toBeUndefined();
  });
});

describe("fleet recovery failure admission", () => {
  beforeAll(async () => {
    await before({ noConat: true });
    await ensureProjectMaintenanceStatusTable();
  }, 15000);

  afterAll(after);

  test("only quota exhaustion is excluded; other failures still block", async () => {
    const host_id = uuid();
    const since = new Date(Date.now() - 120_000).toISOString();
    const after = new Date(Date.now() - 60_000).toISOString();
    const snapshot = {
      checked_at: since,
      recovery_level: "healthy" as const,
      latency_level: "healthy" as const,
      hosts: {
        [host_id]: {
          oldest_backup_delay_seconds: 0,
          emergency_seconds: 0,
          latest_valid_pressure_at: since,
        },
      },
    };
    const assertGate = () =>
      __test__.assertRecoveryStopGate({
        baseline: snapshot,
        current: snapshot,
        host_ids: [host_id],
        require_measured_latency: true,
      });
    const insert = async (
      reason: string | null,
      serviceClass = "free",
      host = host_id,
      observed = after,
    ) => {
      await getPool().query(
        `INSERT INTO project_maintenance_attempts
          (project_id, kind, host_id, storage_service_class, observed_at,
           outcome, reason)
         VALUES ($1, 'snapshot', $2, $3, $4, 'failed', $5)`,
        [uuid(), host, serviceClass, observed, reason],
      );
    };
    await insert("storage_quota_exceeded");
    await insert("storage_quota_exceeded", "paying");
    await insert("repository_credentials_invalid", "free", uuid());
    await insert("object_store_unavailable", "free", host_id, since);
    await expect(assertGate()).resolves.toBeUndefined();

    const health = await getProjectRecoveryAttemptHealth();
    expect(
      health.by_host
        .filter((row) => row.host_id === host_id)
        .reduce((sum, row) => sum + row.failed, 0),
    ).toBe(3);

    for (const reason of [
      null,
      "unknown_failure",
      "repository_credentials_invalid",
      "object_store_unavailable",
      "No space left on device",
      "quota lookup failed",
    ]) {
      await insert(reason);
      await expect(assertGate()).rejects.toThrow(
        "new failed recovery attempt(s) on the upgraded hosts",
      );
      await getPool().query(
        `DELETE FROM project_maintenance_attempts
          WHERE host_id=$1 AND reason IS NOT DISTINCT FROM $2`,
        [host_id, reason],
      );
    }
  });
});
