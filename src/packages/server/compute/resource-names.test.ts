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
  computeResourceIsOwned,
  computeVmDnsLabelPrefix,
  computeVmDnsLabelIsOwned,
} from "./resource-names";

const ID = "12345678-1234-4abc-9def-123456789abc";
const originalDeployment = process.env.COCALC_COMPUTE_DEPLOYMENT_ID;
const originalBay = process.env.COCALC_BAY_ID;
beforeEach(() => {
  delete process.env.COCALC_COMPUTE_DEPLOYMENT_ID;
});
afterEach(() => {
  if (originalDeployment == null)
    delete process.env.COCALC_COMPUTE_DEPLOYMENT_ID;
  else process.env.COCALC_COMPUTE_DEPLOYMENT_ID = originalDeployment;
  if (originalBay == null) delete process.env.COCALC_BAY_ID;
  else process.env.COCALC_BAY_ID = originalBay;
});

it("isolates deployments and bays in both directions including legacy sweepers", () => {
  const legacy = managedComputeVmProviderName(ID, "development");
  expect(computeResourceIsOwned(legacy, "development")).toBe(false);
  process.env.COCALC_COMPUTE_DEPLOYMENT_ID = "isolated-19200";
  process.env.COCALC_BAY_ID = "bay-0";
  const own = managedComputeVmProviderName(ID, "development");
  const dns = `${computeVmDnsLabelPrefix()}${"a".repeat(32)}`;
  expect(computeResourceIsOwned(own, "development")).toBe(true);
  expect(computeResourceIsOwned(`${own}-boot`, "development")).toBe(true);
  expect(computeResourceIsOwned(legacy, "development")).toBe(false);
  expect(computeResourceIsOwned(own, "staging")).toBe(false);
  expect(computeVmDnsLabelIsOwned(dns)).toBe(true);
  expect(/^vm-[a-f0-9]{32}$/.test(dns)).toBe(false);
  expect(`${own}-boot`.length).toBeLessThanOrEqual(63);
  expect(dns.length).toBeLessThanOrEqual(63);
  process.env.COCALC_BAY_ID = "bay-other";
  expect(computeResourceIsOwned(own, "development")).toBe(false);
  expect(computeVmDnsLabelIsOwned(dns)).toBe(false);
  process.env.COCALC_BAY_ID = "bay-0";
  process.env.COCALC_COMPUTE_DEPLOYMENT_ID = "original-9100";
  expect(computeResourceIsOwned(own, "development")).toBe(false);
  delete process.env.COCALC_COMPUTE_DEPLOYMENT_ID;
  expect(managedComputeVmResourceBelongsToEnvironment(own, "development")).toBe(
    false,
  );
  expect(managedComputeVmResourceBelongsToEnvironment(own, "production")).toBe(
    false,
  );
});

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
