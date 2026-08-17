/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  computeHostRuntimeDeploymentReconcilePlan,
  runtimeDeploymentConvergenceScope,
} from "./hosts-runtime-deployment-planning";

describe("runtimeDeploymentConvergenceScope", () => {
  it("does not reconcile unchanged components when a tools override is removed", () => {
    const acpWorker = {
      scope_type: "host" as const,
      scope_id: "host-1",
      host_id: "host-1",
      target_type: "component" as const,
      target: "acp-worker" as const,
      desired_version: "project-host-v2",
      rollout_policy: "drain_then_replace" as const,
      requested_by: "account-1",
      requested_at: "2026-08-14T00:00:00.000Z",
      updated_at: "2026-08-14T00:00:00.000Z",
    };
    const tools = {
      scope_type: "host" as const,
      scope_id: "host-1",
      host_id: "host-1",
      target_type: "artifact" as const,
      target: "tools" as const,
      desired_version: "tools-v2",
      requested_by: "account-1",
      requested_at: "2026-08-14T00:00:00.000Z",
      updated_at: "2026-08-14T00:00:00.000Z",
    };

    expect(
      runtimeDeploymentConvergenceScope({
        before: [acpWorker, tools],
        after: [acpWorker],
      }),
    ).toEqual({ artifacts: true, components: [] });
  });
});

describe("computeHostRuntimeDeploymentReconcilePlan", () => {
  const deployment = {
    scope_type: "global" as const,
    scope_id: "global",
    target_type: "component" as const,
    target: "acp-worker" as const,
    desired_version: "project-host-v2",
    rollout_policy: "drain_then_replace" as const,
    requested_by: "account-1",
    requested_at: "2026-08-14T00:00:00.000Z",
    updated_at: "2026-08-14T00:00:00.000Z",
  };

  it("does not replace a ready ACP worker while its predecessor drains", () => {
    const result = computeHostRuntimeDeploymentReconcilePlan({
      row: {
        metadata: { software: { project_host: "project-host-v2" } },
      },
      status: {
        host_id: "host-1",
        configured: [],
        effective: [deployment],
        observed_components: [
          {
            component: "acp-worker",
            artifact: "project-host",
            upgrade_policy: "drain_then_replace",
            enabled: true,
            managed: true,
            desired_version: "build-v2",
            runtime_state: "running",
            version_state: "mixed",
            running_versions: ["build-v1", "build-v2"],
            running_pids: [111, 222],
          },
        ],
        observed_targets: [
          {
            target_type: "component",
            target: "acp-worker",
            desired_version: "project-host-v2",
            observed_version_state: "mixed",
            running_versions: ["build-v1", "build-v2"],
          },
        ],
        observed_artifacts: [],
        rollback_targets: [],
      },
    });

    expect(result.reconciled_components).toEqual([]);
    expect(result.decisions).toEqual([
      expect.objectContaining({
        component: "acp-worker",
        decision: "skip",
        reason: "desired_worker_running_while_previous_worker_drains",
      }),
    ]);
  });

  it("still replaces mixed ACP workers when the desired worker is absent", () => {
    const result = computeHostRuntimeDeploymentReconcilePlan({
      row: {
        metadata: { software: { project_host: "project-host-v2" } },
      },
      status: {
        host_id: "host-1",
        configured: [],
        effective: [deployment],
        observed_components: [
          {
            component: "acp-worker",
            artifact: "project-host",
            upgrade_policy: "drain_then_replace",
            enabled: true,
            managed: true,
            desired_version: "build-v2",
            runtime_state: "running",
            version_state: "mixed",
            running_versions: ["build-v0", "build-v1"],
            running_pids: [111, 222],
          },
        ],
        observed_targets: [
          {
            target_type: "component",
            target: "acp-worker",
            desired_version: "project-host-v2",
            observed_version_state: "mixed",
            running_versions: ["build-v0", "build-v1"],
          },
        ],
        observed_artifacts: [],
        rollback_targets: [],
      },
    });

    expect(result.reconciled_components).toEqual(["acp-worker"]);
  });
});
