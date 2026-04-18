/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { runtimeDeploymentsForUpgradeResults } from "./hosts-runtime-deployment-planning";
import { rolloutComponentsForUpgradeResults } from "./hosts";

describe("rolloutComponentsForUpgradeResults", () => {
  it("maps updated project-host artifacts to a managed project-host rollout", () => {
    expect(
      rolloutComponentsForUpgradeResults([
        { artifact: "tools", version: "tools-1", status: "updated" },
        {
          artifact: "project-host",
          version: "project-host-2",
          status: "updated",
        },
      ]),
    ).toEqual(["project-host"]);
  });

  it("ignores noop project-host upgrades and non-project-host artifacts", () => {
    expect(
      rolloutComponentsForUpgradeResults([
        { artifact: "project", version: "project-1", status: "updated" },
        {
          artifact: "project-host",
          version: "project-host-1",
          status: "noop",
        },
      ]),
    ).toEqual([]);
  });
});

describe("runtimeDeploymentsForUpgradeResults", () => {
  it("does not align managed runtime components by default", () => {
    expect(
      runtimeDeploymentsForUpgradeResults([
        {
          artifact: "project-host",
          version: "project-host-2",
          status: "updated",
        },
      ]),
    ).toEqual([
      {
        target_type: "artifact",
        target: "project-host",
        desired_version: "project-host-2",
      },
    ]);
  });

  it("aligns the full managed runtime stack when explicitly requested", () => {
    expect(
      runtimeDeploymentsForUpgradeResults(
        [
          {
            artifact: "project-host",
            version: "project-host-2",
            status: "updated",
          },
          { artifact: "tools", version: "tools-7", status: "updated" },
        ],
        { alignRuntimeStack: true },
      ),
    ).toEqual(
      expect.arrayContaining([
        {
          target_type: "artifact",
          target: "project-host",
          desired_version: "project-host-2",
        },
        {
          target_type: "artifact",
          target: "tools",
          desired_version: "tools-7",
        },
        {
          target_type: "component",
          target: "project-host",
          desired_version: "project-host-2",
          rollout_policy: "restart_now",
          rollout_reason: "project_host_upgrade",
        },
        {
          target_type: "component",
          target: "conat-router",
          desired_version: "project-host-2",
          rollout_policy: "restart_now",
          rollout_reason: "project_host_upgrade",
        },
        {
          target_type: "component",
          target: "conat-persist",
          desired_version: "project-host-2",
          rollout_policy: "restart_now",
          rollout_reason: "project_host_upgrade",
        },
        {
          target_type: "component",
          target: "acp-worker",
          desired_version: "project-host-2",
          rollout_policy: "drain_then_replace",
          rollout_reason: "project_host_upgrade",
        },
      ]),
    );
  });

  it("leaves the runtime stack alone when project-host is not part of the upgrade", () => {
    expect(
      runtimeDeploymentsForUpgradeResults([
        { artifact: "project", version: "bundle-2", status: "updated" },
        { artifact: "tools", version: "tools-7", status: "updated" },
      ]),
    ).toEqual([
      {
        target_type: "artifact",
        target: "project-bundle",
        desired_version: "bundle-2",
      },
      {
        target_type: "artifact",
        target: "tools",
        desired_version: "tools-7",
      },
    ]);
  });
});
