/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  isProjectHostLocalRollbackError,
  summarizeObservedRuntimeDeployments,
  summarizeRollbackTargets,
} from "./hosts-runtime-observation";

describe("summarizeObservedRuntimeDeployments", () => {
  it("treats project-host artifact-version component reports as aligned", () => {
    expect(
      summarizeObservedRuntimeDeployments({
        effective: [
          {
            scope_type: "host",
            scope_id: "host-1",
            host_id: "host-1",
            target_type: "component",
            target: "conat-router",
            desired_version: "ph-v2",
            rollout_policy: "restart_now",
            requested_by: "account-1",
            requested_at: "2026-04-19T01:00:00.000Z",
            updated_at: "2026-04-19T01:00:00.000Z",
          },
        ],
        observed_artifacts: [
          {
            artifact: "project-host",
            current_version: "ph-v2",
            current_build_id: "build-ph-v2",
            installed_versions: ["ph-v2", "ph-v1"],
          },
        ],
        observed_components: [
          {
            component: "conat-router",
            artifact: "project-host",
            enabled: true,
            managed: true,
            runtime_state: "running",
            running_versions: ["ph-v2"],
            running_pids: [111],
          } as any,
        ],
      })[0]?.observed_version_state,
    ).toBe("aligned");
  });

  it("treats project-host build-id component reports as aligned", () => {
    expect(
      summarizeObservedRuntimeDeployments({
        effective: [
          {
            scope_type: "host",
            scope_id: "host-1",
            host_id: "host-1",
            target_type: "component",
            target: "conat-router",
            desired_version: "ph-v2",
            rollout_policy: "restart_now",
            requested_by: "account-1",
            requested_at: "2026-04-19T01:00:00.000Z",
            updated_at: "2026-04-19T01:00:00.000Z",
          },
        ],
        observed_artifacts: [
          {
            artifact: "project-host",
            current_version: "ph-v2",
            current_build_id: "build-ph-v2",
            installed_versions: ["ph-v2", "ph-v1"],
          },
        ],
        observed_components: [
          {
            component: "conat-router",
            artifact: "project-host",
            enabled: true,
            managed: true,
            runtime_state: "running",
            running_versions: ["build-ph-v2"],
            running_pids: [111],
          } as any,
        ],
      })[0]?.observed_version_state,
    ).toBe("aligned");
  });
});

describe("summarizeRollbackTargets", () => {
  it("surfaces protected and prune-candidate versions for referenced artifacts", () => {
    expect(
      summarizeRollbackTargets({
        row: {
          metadata: {
            runtime_deployments: {
              last_known_good_versions: {
                "project-bundle": "bundle-v2",
              },
            },
          },
        },
        effective: [
          {
            scope_type: "host",
            scope_id: "host-1",
            host_id: "host-1",
            target_type: "artifact",
            target: "project-bundle",
            desired_version: "bundle-v5",
            requested_by: "account-1",
            requested_at: "2026-04-19T01:00:00.000Z",
            updated_at: "2026-04-19T01:00:00.000Z",
          },
        ],
        observed_artifacts: [
          {
            artifact: "project-bundle",
            current_version: "bundle-v4",
            installed_versions: [
              "bundle-v5",
              "bundle-v4",
              "bundle-v3",
              "bundle-v2",
              "bundle-v1",
            ],
            version_bytes: [
              { version: "bundle-v5", bytes: 500 },
              { version: "bundle-v4", bytes: 400 },
              { version: "bundle-v3", bytes: 300 },
              { version: "bundle-v2", bytes: 200 },
              { version: "bundle-v1", bytes: 100 },
            ],
            installed_bytes_total: 1500,
            referenced_versions: [{ version: "bundle-v2", project_count: 3 }],
          },
        ],
      })[0],
    ).toEqual({
      target_type: "artifact",
      target: "project-bundle",
      artifact: "project-bundle",
      desired_version: "bundle-v5",
      current_version: "bundle-v4",
      previous_version: "bundle-v5",
      last_known_good_version: "bundle-v2",
      retained_versions: [
        "bundle-v5",
        "bundle-v4",
        "bundle-v3",
        "bundle-v2",
        "bundle-v1",
      ],
      referenced_versions: [{ version: "bundle-v2", project_count: 3 }],
      protected_versions: ["bundle-v5", "bundle-v4", "bundle-v2"],
      prune_candidate_versions: ["bundle-v3", "bundle-v1"],
      retained_bytes_total: 1500,
      protected_bytes_total: 1100,
      prune_candidate_bytes_total: 400,
      retention_policy: { keep_count: 3 },
    });
  });
});

describe("isProjectHostLocalRollbackError", () => {
  it("accepts structural rollback errors even when they are not Error instances", () => {
    expect(
      isProjectHostLocalRollbackError({
        code: "PROJECT_HOST_LOCAL_ROLLBACK",
        automaticRollback: {
          host_id: "host-1",
          rollback_version: "ph-v1",
          source: "host-agent",
        },
      }),
    ).toBe(true);
  });

  it("rejects rollback-shaped objects without a rollback version", () => {
    expect(
      isProjectHostLocalRollbackError({
        code: "PROJECT_HOST_LOCAL_ROLLBACK",
        automaticRollback: {
          host_id: "host-1",
          rollback_version: "",
          source: "host-agent",
        },
      }),
    ).toBe(false);
  });
});
