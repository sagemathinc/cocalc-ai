/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  __test__,
  clearProjectHostManagedEgressBlockedAccounts,
  getProjectHostManagedEgressBlockedMessage,
  getProjectHostManagedEgressMode,
  setProjectHostManagedEgressBlockedAccount,
} from "./managed-egress-runtime";

describe("project-host managed egress runtime", () => {
  const originalMode = process.env.COCALC_PROJECT_HOST_MANAGED_EGRESS_MODE;
  const originalProvider = process.env.COCALC_PROJECT_HOST_CLOUD_PROVIDER;

  beforeEach(() => {
    clearProjectHostManagedEgressBlockedAccounts();
    delete process.env.COCALC_PROJECT_HOST_MANAGED_EGRESS_MODE;
    delete process.env.COCALC_PROJECT_HOST_CLOUD_PROVIDER;
  });

  afterAll(() => {
    process.env.COCALC_PROJECT_HOST_MANAGED_EGRESS_MODE = originalMode;
    process.env.COCALC_PROJECT_HOST_CLOUD_PROVIDER = originalProvider;
  });

  it("enforces on gcp hosts by default", () => {
    process.env.COCALC_PROJECT_HOST_CLOUD_PROVIDER = "google-cloud";
    expect(getProjectHostManagedEgressMode()).toBe("enforce");
  });

  it("disables managed egress tracking on non-gcp providers", () => {
    process.env.COCALC_PROJECT_HOST_CLOUD_PROVIDER = "hyperstack";
    expect(getProjectHostManagedEgressMode()).toBe("off");
  });

  it("honors an explicit mode override", () => {
    process.env.COCALC_PROJECT_HOST_MANAGED_EGRESS_MODE = "observe";
    process.env.COCALC_PROJECT_HOST_CLOUD_PROVIDER = "google-cloud";
    expect(getProjectHostManagedEgressMode()).toBe("observe");
  });

  it("tracks blocked accounts locally", () => {
    setProjectHostManagedEgressBlockedAccount({
      account_id: "account-1",
      message: "blocked",
    });
    expect(getProjectHostManagedEgressBlockedMessage("account-1")).toBe(
      "blocked",
    );
    clearProjectHostManagedEgressBlockedAccounts();
    expect(getProjectHostManagedEgressBlockedMessage("account-1")).toBe(
      undefined,
    );
  });

  it("normalizes legacy provider aliases", () => {
    expect(__test__.normalizeProvider("gcp")).toBe("gcp");
    expect(__test__.normalizeProvider("google-cloud")).toBe("gcp");
  });
});
