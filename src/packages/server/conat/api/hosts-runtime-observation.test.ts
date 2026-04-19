/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { summarizeObservedRuntimeDeployments } from "./hosts-runtime-observation";

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
