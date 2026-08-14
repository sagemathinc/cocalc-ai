/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { RemoteInstance } from "@cocalc/cloud";
import type { ComputeVmConfig } from "./config";
import { assertComputeVmSecurity } from "./security";

const config = {
  gcp_network_tag: "cocalc-compute-vm",
} as ComputeVmConfig;
const expectedSubnetwork =
  "projects/compute-prod/regions/us-central1/subnetworks/hostile-guests";

function instance(overrides: Record<string, any> = {}): RemoteInstance {
  return {
    instance_id: "vm-1",
    metadata: {
      gcp_security: {
        service_account_count: 0,
        can_ip_forward: false,
        deletion_protection: false,
        block_project_ssh_keys: true,
        tags: ["cocalc-compute-vm"],
        subnetwork:
          "https://www.googleapis.com/compute/v1/projects/compute-prod/regions/us-central1/subnetworks/hostile-guests",
        external_access_config_count: 1,
        network_tier: "STANDARD",
        external_ipv6: false,
        ...overrides,
      },
    },
  };
}

describe("managed compute VM security validation", () => {
  it("accepts the isolated hostile-guest shape", () => {
    expect(() =>
      assertComputeVmSecurity(instance(), config, expectedSubnetwork),
    ).not.toThrow();
  });

  it("accepts a stopped instance with no external access config", () => {
    expect(() =>
      assertComputeVmSecurity(
        instance({
          external_access_config_count: 0,
          network_tier: undefined,
        }),
        config,
        expectedSubnetwork,
      ),
    ).not.toThrow();
  });

  it("reports every observed isolation violation", () => {
    expect(() =>
      assertComputeVmSecurity(
        instance({
          service_account_count: 1,
          can_ip_forward: true,
          block_project_ssh_keys: false,
          tags: [],
          network_tier: "PREMIUM",
          external_ipv6: true,
          subnetwork: "projects/wrong/regions/us-central1/subnetworks/default",
        }),
        config,
        expectedSubnetwork,
      ),
    ).toThrow(
      /service account.*IP forwarding.*SSH keys.*network tag.*Standard Tier.*IPv6.*subnetwork/,
    );
  });
});
