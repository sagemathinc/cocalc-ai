/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { publicComputeVmMetadata } from "./public";

describe("managed compute public metadata", () => {
  it("does not expose the internal sponsor reservation or payer routing reference", () => {
    expect(
      publicComputeVmMetadata({
        billing: {
          funding_mode: "account-prepaid",
          course_funding: {
            source: { payer_account_id: "payer" },
            binding: { payer_authority_epoch: "private" },
          },
        },
      }),
    ).toEqual({ billing: { funding_mode: "account-prepaid" } });
  });
  it("removes every authorized-key snapshot without hiding runtime state", () => {
    expect(
      publicComputeVmMetadata({
        ssh_public_keys: ["top-level-account-key"],
        project_ssh_public_keys: ["top-level-project-key"],
        provider_observation: { state: "running" },
        runtime: {
          private_ip: "10.0.0.2",
          ssh_public_key: "runtime-primary-key",
          ssh_public_keys: ["runtime-account-key"],
          project_ssh_public_keys: ["runtime-project-key"],
        },
        billing: { funding_mode: "account-prepaid" },
      }),
    ).toEqual({
      runtime: { private_ip: "10.0.0.2" },
      billing: { funding_mode: "account-prepaid" },
    });
  });
});
