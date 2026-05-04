import { runtimeDeploymentsForManagedComponentVersion } from "./runtime-deployments";

describe("runtimeDeploymentsForManagedComponentVersion", () => {
  it("pins the matching project-host artifact alongside the component target", () => {
    expect(
      runtimeDeploymentsForManagedComponentVersion({
        component: "conat-router",
        desired_version: "  ph-v2  ",
        rollout_reason: "frontend hub deploy",
      }),
    ).toEqual([
      {
        target_type: "artifact",
        target: "project-host",
        desired_version: "ph-v2",
        rollout_reason: "frontend hub deploy",
      },
      {
        target_type: "component",
        target: "conat-router",
        desired_version: "ph-v2",
        rollout_reason: "frontend hub deploy",
      },
    ]);
  });

  it("returns no deployments for a blank desired version", () => {
    expect(
      runtimeDeploymentsForManagedComponentVersion({
        component: "project-host",
        desired_version: "   ",
      }),
    ).toEqual([]);
  });
});
