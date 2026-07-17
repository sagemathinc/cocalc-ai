/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { _test } from "./runtime-maintenance";

const NOW = Date.UTC(2026, 6, 14, 12, 0, 0);

function degradedCloudHost(overrides: Record<string, any> = {}) {
  return {
    id: "dab25958-64df-4bea-803b-77319d7839f6",
    name: "western-europe-1",
    status: "running",
    last_seen: new Date(NOW - 10_000),
    metadata: {
      desired_state: "running",
      host_boot_id: "boot-3",
      host_session_id: "session-3",
      machine: { cloud: "gcp" },
      runtime_health: {
        status: "degraded",
        ready: false,
        consecutive_failures: 3,
        diagnostics_completed_at: new Date(NOW - 60_000).toISOString(),
        error: "podman ps timed out",
      },
      ...overrides,
    },
  };
}

function syntheticClaim(overrides: Record<string, any> = {}) {
  return {
    claim_id: "claim-1",
    previous_failures: 0,
    previous_total_checks: 0,
    previous_passed_checks: 0,
    previous_failed_checks: 0,
    was_quarantined: false,
    ...overrides,
  };
}

describe("project-host runtime maintenance policy", () => {
  it("requires completed forensic capture before rebooting", () => {
    const row = degradedCloudHost();
    delete row.metadata.runtime_health.diagnostics_completed_at;
    expect(_test.autoRebootDecision(row, NOW)).toEqual({
      action: "wait",
      reason: "forensic capture is not complete",
    });
  });

  it("allows a bounded reboot after repeated runtime failures", () => {
    expect(_test.autoRebootDecision(degradedCloudHost(), NOW)).toEqual({
      action: "reboot",
      attempts: [],
    });
  });

  it("does not reboot for synthetic-only failures", () => {
    const row = degradedCloudHost({
      runtime_health: {
        status: "degraded",
        ready: false,
        consecutive_failures: 0,
        diagnostics_completed_at: new Date(NOW - 60_000).toISOString(),
        error: "synthetic project probe failed",
        synthetic_probe: {
          status: "failed",
          consecutive_failures: 2,
          failure_kind: "port_bind_collision",
        },
      },
    });

    expect(_test.autoRebootDecision(row, NOW)).toEqual({
      action: "wait",
      reason: "passive runtime failure threshold is not met",
    });
  });

  it("does not reboot for an unclassified synthetic-only failure", () => {
    const row = degradedCloudHost({
      runtime_health: {
        status: "degraded",
        ready: false,
        consecutive_failures: 0,
        diagnostics_completed_at: new Date(NOW - 60_000).toISOString(),
        error: "synthetic project probe failed",
        synthetic_probe: {
          status: "failed",
          consecutive_failures: 8,
          failure_kind: "project_start_failed",
        },
      },
    });

    expect(_test.autoRebootDecision(row, NOW)).toEqual({
      action: "wait",
      reason: "passive runtime failure threshold is not met",
    });
  });

  it("exhausts the rolling reboot budget", () => {
    const attempts = [
      {
        at: new Date(NOW - 5 * 60_000).toISOString(),
        host_boot_id: "boot-2",
      },
      {
        at: new Date(NOW - 2 * 60_000).toISOString(),
        host_boot_id: "boot-3",
      },
    ];
    expect(
      _test.autoRebootDecision(
        degradedCloudHost({ runtime_auto_recovery: { attempts } }),
        NOW,
      ),
    ).toEqual({ action: "exhausted", attempts });
  });

  it("marks a completed reboot recovery without discarding its budget", () => {
    const attempts = [
      {
        at: new Date(NOW - 5 * 60_000).toISOString(),
        host_boot_id: "boot-2",
        work_id: "work-1",
      },
    ];
    const row = degradedCloudHost({
      host_boot_id: "boot-3",
      host_session_id: "session-3",
      runtime_auto_recovery: {
        status: "scheduled",
        host_boot_id: "boot-2",
        work_id: "work-1",
        cooldown_until: new Date(NOW + 5 * 60_000).toISOString(),
        attempts,
      },
    });
    expect(_test.recoveredAutoRebootState(row, NOW)).toEqual({
      status: "recovered",
      recovered_at: new Date(NOW).toISOString(),
      host_boot_id: "boot-3",
      host_session_id: "session-3",
      previous_status: "scheduled",
      previous_host_boot_id: "boot-2",
      work_id: "work-1",
      cooldown_until: new Date(NOW + 5 * 60_000).toISOString(),
      attempts,
    });
  });

  it("does not claim recovery until the host has a new boot", () => {
    const row = degradedCloudHost({
      runtime_auto_recovery: {
        status: "scheduled",
        host_boot_id: "boot-3",
        attempts: [],
      },
    });
    expect(_test.recoveredAutoRebootState(row, NOW)).toBeUndefined();
  });

  it("does not automatically reboot local or stale hosts", () => {
    expect(
      _test.autoRebootDecision(
        degradedCloudHost({ machine: { cloud: "local" } }),
        NOW,
      ),
    ).toMatchObject({ action: "wait", reason: "host is not cloud-backed" });
    expect(
      _test.autoRebootDecision(
        { ...degradedCloudHost(), last_seen: new Date(NOW - 3 * 60_000) },
        NOW,
      ),
    ).toMatchObject({ action: "wait", reason: "host heartbeat is stale" });
  });

  it("runs a new synthetic probe after a boot, process session, or interval", () => {
    const row = degradedCloudHost({
      host_boot_id: "boot-4",
      host_session_id: "session-4",
      runtime_synthetic_probe: {
        status: "passed",
        host_boot_id: "boot-3",
        host_session_id: "session-3",
        checked_at: new Date(NOW - 60_000).toISOString(),
      },
    });
    expect(_test.syntheticProbeDue(row, NOW)).toBe(true);

    row.metadata.runtime_synthetic_probe.host_boot_id = "boot-4";
    expect(_test.syntheticProbeDue(row, NOW)).toBe(true);
    row.metadata.runtime_synthetic_probe.host_session_id = "session-4";
    row.metadata.runtime_synthetic_probe.checked_at = new Date(
      NOW - 31 * 60_000,
    ).toISOString();
    expect(_test.syntheticProbeDue(row, NOW)).toBe(true);
    row.metadata.runtime_synthetic_probe.checked_at = new Date(
      NOW - 5 * 60_000,
    ).toISOString();
    expect(_test.syntheticProbeDue(row, NOW)).toBe(false);
  });

  it("retries a failed synthetic probe after bootstrap reconciliation", () => {
    const row = degradedCloudHost({
      bootstrap_lifecycle: {
        last_reconcile_finished_at: new Date(NOW - 10_000).toISOString(),
      },
      runtime_synthetic_probe: {
        status: "failed",
        host_boot_id: "boot-3",
        host_session_id: "session-3",
        checked_at: new Date(NOW - 30_000).toISOString(),
      },
    });
    expect(_test.syntheticProbeDue(row, NOW)).toBe(true);

    row.metadata.bootstrap_lifecycle.last_reconcile_finished_at = new Date(
      NOW - 60_000,
    ).toISOString();
    expect(_test.syntheticProbeDue(row, NOW)).toBe(false);
  });

  it("alerts once per synthetic quarantine incident", () => {
    const row = degradedCloudHost({
      runtime_synthetic_probe: {
        status: "failed",
        alerted_at: new Date(NOW - 5 * 60_000).toISOString(),
      },
    });
    expect(_test.syntheticProbeFailureAlertDue(row)).toBe(false);
    row.metadata.runtime_synthetic_probe.alerted_at = new Date(
      NOW - 24 * 60 * 60_000,
    ).toISOString();
    expect(_test.syntheticProbeFailureAlertDue(row)).toBe(false);
    delete row.metadata.runtime_synthetic_probe.alerted_at;
    expect(_test.syntheticProbeFailureAlertDue(row)).toBe(true);
  });

  it("requires two synthetic failures to quarantine and one pass to recover", () => {
    const row = degradedCloudHost();
    const firstFailure = _test.syntheticProbeOutcome({
      row,
      claim: syntheticClaim(),
      checkedAt: new Date(NOW).toISOString(),
      duration_ms: 100,
      error: new Error("transient crun getcwd failure"),
    });
    expect(firstFailure).toMatchObject({
      status: "failed",
      consecutive_failures: 1,
      quarantined: false,
      total_checks: 1,
      failed_checks: 1,
    });

    const secondFailure = _test.syntheticProbeOutcome({
      row,
      claim: syntheticClaim({
        claim_id: "claim-2",
        previous_failures: 1,
        previous_total_checks: 1,
        previous_failed_checks: 1,
      }),
      checkedAt: new Date(NOW).toISOString(),
      duration_ms: 100,
      error: new Error("repeated failure"),
    });
    expect(secondFailure).toMatchObject({
      status: "failed",
      consecutive_failures: 2,
      quarantined: true,
      total_checks: 2,
      failed_checks: 2,
    });

    const recovered = _test.syntheticProbeOutcome({
      row,
      claim: syntheticClaim({
        claim_id: "claim-3",
        previous_failures: 2,
        previous_total_checks: 2,
        previous_failed_checks: 2,
        was_quarantined: true,
      }),
      checkedAt: new Date(NOW).toISOString(),
      duration_ms: 100,
      result: { project_id: "probe-project" },
    });
    expect(recovered).toMatchObject({
      status: "passed",
      consecutive_failures: 0,
      quarantined: false,
      total_checks: 3,
      passed_checks: 1,
      failed_checks: 2,
    });
  });

  it("runs public-route probes after a boot, process session, or interval", () => {
    const row = degradedCloudHost({
      host_boot_id: "boot-4",
      host_session_id: "session-4",
      public_route_probe: {
        status: "passed",
        host_boot_id: "boot-3",
        host_session_id: "session-3",
        checked_at: new Date(NOW - 30_000).toISOString(),
      },
    });
    expect(_test.publicRouteProbeDue(row, NOW)).toBe(true);

    row.metadata.public_route_probe.host_boot_id = "boot-4";
    expect(_test.publicRouteProbeDue(row, NOW)).toBe(true);
    row.metadata.public_route_probe.host_session_id = "session-4";
    expect(_test.publicRouteProbeDue(row, NOW)).toBe(false);
    row.metadata.public_route_probe.checked_at = new Date(
      NOW - 3 * 60_000,
    ).toISOString();
    expect(_test.publicRouteProbeDue(row, NOW)).toBe(true);
  });

  it("requires two public failures to quarantine and two successes to recover", () => {
    const row = degradedCloudHost();
    const baseClaim = {
      claim_id: "claim-1",
      previous_failures: 0,
      previous_successes: 0,
      was_quarantined: false,
    };
    const firstFailure = _test.publicRouteProbeOutcome({
      row,
      claim: baseClaim,
      checkedAt: new Date(NOW).toISOString(),
      duration_ms: 100,
      error: new Error("CORS missing"),
    });
    expect(firstFailure).toMatchObject({
      status: "failed",
      consecutive_failures: 1,
      quarantined: false,
    });

    const secondFailure = _test.publicRouteProbeOutcome({
      row,
      claim: {
        ...baseClaim,
        claim_id: "claim-2",
        previous_failures: 1,
      },
      checkedAt: new Date(NOW).toISOString(),
      duration_ms: 100,
      error: new Error("CORS missing"),
      alerted_at: new Date(NOW).toISOString(),
    });
    expect(secondFailure).toMatchObject({
      status: "failed",
      consecutive_failures: 2,
      quarantined: true,
    });

    const firstSuccess = _test.publicRouteProbeOutcome({
      row,
      claim: {
        ...baseClaim,
        claim_id: "claim-3",
        previous_failures: 2,
        was_quarantined: true,
        alerted_at: new Date(NOW).toISOString(),
      },
      checkedAt: new Date(NOW).toISOString(),
      duration_ms: 100,
      result: {
        public_url: "https://host.example.test",
        origin: "https://cocalc.example.test",
        health_status: 200,
        preflight_status: 204,
        session_status: 401,
        websocket_status: 101,
        websocket_attempts: 8,
      },
    });
    expect(firstSuccess).toMatchObject({
      status: "recovering",
      consecutive_successes: 1,
      quarantined: true,
      alerted_at: new Date(NOW).toISOString(),
    });

    const secondSuccess = _test.publicRouteProbeOutcome({
      row,
      claim: {
        ...baseClaim,
        claim_id: "claim-4",
        previous_failures: 0,
        previous_successes: 1,
        was_quarantined: true,
      },
      checkedAt: new Date(NOW).toISOString(),
      duration_ms: 100,
      result: {
        public_url: "https://host.example.test",
        origin: "https://cocalc.example.test",
        health_status: 200,
        preflight_status: 204,
        session_status: 401,
        websocket_status: 101,
        websocket_attempts: 8,
      },
    });
    expect(secondSuccess).toMatchObject({
      status: "passed",
      consecutive_successes: 2,
      quarantined: false,
    });
    expect(secondSuccess.alerted_at).toBeUndefined();
  });

  it("alerts once per public-route quarantine incident", () => {
    const row = degradedCloudHost({
      public_route_probe: {
        status: "failed",
        quarantined: true,
        alerted_at: new Date(NOW - 5 * 60_000).toISOString(),
      },
    });
    expect(_test.publicRouteProbeFailureAlertDue(row)).toBe(false);
    row.metadata.public_route_probe.alerted_at = new Date(
      NOW - 24 * 60 * 60_000,
    ).toISOString();
    expect(_test.publicRouteProbeFailureAlertDue(row)).toBe(false);
    delete row.metadata.public_route_probe.alerted_at;
    expect(_test.publicRouteProbeFailureAlertDue(row)).toBe(true);
  });

  it("only repairs quarantined capable hosts outside the cooldown", () => {
    const probe = {
      status: "failed",
      claim_id: "probe-claim",
      quarantined: true,
      consecutive_failures: 2,
    };
    const row = degradedCloudHost({
      cloudflared_restart_supported: true,
      public_route_probe: probe,
    });
    expect(_test.publicRouteAutoRepairDecision(row, probe, NOW)).toEqual({
      action: "restart",
    });

    row.metadata.cloudflared_restart_supported = false;
    expect(_test.publicRouteAutoRepairDecision(row, probe, NOW)).toEqual({
      action: "wait",
      reason: "host does not advertise tunnel restart support",
    });

    row.metadata.cloudflared_restart_supported = true;
    row.metadata.public_route_auto_recovery = {
      status: "restart_completed",
      attempted_at: new Date(NOW - 5 * 60_000).toISOString(),
    };
    expect(_test.publicRouteAutoRepairDecision(row, probe, NOW)).toEqual({
      action: "wait",
      reason: "host tunnel repair is in cooldown",
    });
  });

  it("identifies the deployment from the project-host public URL", () => {
    const id = "c2c1bb5b-d5fb-4a06-8904-4549f4089ac2";
    expect(
      _test.deploymentLabel({
        id,
        public_url: `https://host-${id}-lite4b.cocalc.ai`,
      }),
    ).toBe("lite4b.cocalc.ai");
    expect(
      _test.deploymentLabel({
        id,
        public_url: "https://project-host.example.com",
      }),
    ).toBe("project-host.example.com");
    expect(_test.deploymentLabel({ id })).toBe("unknown-site");
  });
});
