/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  managedComputeVmProviderName,
  managedComputeVmProviderPrefix,
  managedComputeVmResourceBelongsToEnvironment,
  managedComputeVolumeProviderName,
  managedComputeVolumeResourceBelongsToEnvironment,
} from "./resource-names";

const ID = "12345678-1234-4abc-9def-123456789abc";

describe("managed compute provider resource names", () => {
  it("preserves the production namespace", () => {
    expect(managedComputeVmProviderPrefix("production")).toBe("cocalc-vm-");
    expect(managedComputeVmProviderName(ID, "production")).toBe(
      "cocalc-vm-1234567812344abc9def1234",
    );
    expect(managedComputeVolumeProviderName(ID, "production")).toBe(
      "cocalc-vol-1234567812344abc9def1234",
    );
  });

  it("uses disjoint namespaces outside production", () => {
    const stagingVm = managedComputeVmProviderName(ID, "staging");
    const developmentVm = managedComputeVmProviderName(ID, "development");
    const stagingVolume = managedComputeVolumeProviderName(ID, "staging");

    expect(stagingVm).toBe("cocalc-staging-vm-1234567812344abc9def1234");
    expect(developmentVm).toBe(
      "cocalc-development-vm-1234567812344abc9def1234",
    );
    expect(stagingVolume).toBe("cocalc-staging-vol-1234567812344abc9def1234");
    expect(
      stagingVm.startsWith(managedComputeVmProviderPrefix("production")),
    ).toBe(false);
  });

  it("does not let one environment claim another environment's resources", () => {
    const productionVm = managedComputeVmProviderName(ID, "production");
    const stagingVm = managedComputeVmProviderName(ID, "staging");
    const stagingDisk = `${stagingVm}-boot`;
    const stagingVolume = managedComputeVolumeProviderName(ID, "staging");

    expect(
      managedComputeVmResourceBelongsToEnvironment(stagingVm, "production"),
    ).toBe(false);
    expect(
      managedComputeVmResourceBelongsToEnvironment(productionVm, "staging"),
    ).toBe(false);
    expect(
      managedComputeVmResourceBelongsToEnvironment(stagingDisk, "staging"),
    ).toBe(true);
    expect(
      managedComputeVolumeResourceBelongsToEnvironment(
        stagingVolume,
        "production",
      ),
    ).toBe(false);
  });

  it("keeps provider names within common hostname limits", () => {
    for (const environment of [
      "production",
      "staging",
      "development",
    ] as const) {
      expect(
        managedComputeVmProviderName(ID, environment).length,
      ).toBeLessThanOrEqual(63);
      expect(
        managedComputeVolumeProviderName(ID, environment).length,
      ).toBeLessThanOrEqual(63);
    }
  });
});
