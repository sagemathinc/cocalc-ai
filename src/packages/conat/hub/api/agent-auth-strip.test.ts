/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getHubApiPrincipalPolicies, transformArgs } from "./index";

const account_id = "00000000-0000-4000-8000-000000000001";
const project_id = "00000000-0000-4000-8000-000000000002";
const token_fingerprint = "a".repeat(64);

// what an account, project or host caller might put in its arguments
const injected = () => ({
  account_id: "00000000-0000-4000-8000-0000000000bb",
  project_id,
  token_fingerprint: "b".repeat(64),
  issued_at_s: 1,
  expires_at_s: 2 ** 31,
});

describe("a caller can never supply its own agent identity", () => {
  const policies = getHubApiPrincipalPolicies();
  const methods = Object.keys(policies);
  const computeAgentMethods = methods.filter(
    (name) => policies[name] === "account-or-compute-agent",
  );

  it("covers every account-or-compute-agent method", () => {
    expect(computeAgentMethods.sort()).toEqual(
      [
        "compute.createVm",
        "compute.createVolume",
        "compute.deleteVm",
        "compute.deleteVolume",
        "compute.getCatalog",
        "compute.resizeVolume",
        "compute.setVmFundingMode",
        "compute.setVmMachineType",
        "compute.setVmPricingModel",
        "compute.setVmTtl",
        "compute.setVolumeFundingMode",
        "compute.startVm",
        "compute.stopVm",
        // its own transform; covered by the stripping test below
        "notifications.startCodexFreshAuthAction",
      ].sort(),
    );
  });

  const callers: [string, Record<string, unknown>][] = [
    ["an account", { account_id, auth_session_hash: null }],
    ["a project", { project_id }],
    ["a host", { host_id: "00000000-0000-4000-8000-0000000000dd" }],
  ];
  for (const [who, context] of callers) {
    it(`strips agent_auth from ${who} caller on every method`, async () => {
      for (const name of methods) {
        const args = [{ agent_auth: injected() }, { agent_auth: injected() }];
        let result: any[] | undefined;
        try {
          result = await transformArgs({ name, args, ...context } as any);
        } catch {
          // refused outright is fine too
        }
        for (const arg of [...args, ...(result ?? [])]) {
          expect(arg?.agent_auth).toBeUndefined();
        }
      }
    });
  }

  it("strips it on every compute method for account and project callers", async () => {
    const compute = methods.filter((m) => m.startsWith("compute."));
    expect(compute.length).toBeGreaterThan(15);
    for (const name of compute) {
      for (const context of [{ account_id }, { project_id }]) {
        const args = [{ agent_auth: injected() }];
        const result = await transformArgs({ name, args, ...context } as any)
          .then((r: any[]) => r)
          .catch(() => undefined);
        expect(args[0].agent_auth).toBeUndefined();
        expect(result?.[0]?.agent_auth).toBeUndefined();
      }
    }
  });

  it("builds an agent's identity only from its verified connection", async () => {
    for (const name of computeAgentMethods.filter((m) =>
      m.startsWith("compute."),
    )) {
      const [opts] = await transformArgs({
        name,
        args: [{ agent_auth: injected() }],
        account_id,
        project_id,
        auth_actor: "agent",
        auth_token_fingerprint: token_fingerprint,
        auth_iat_s: 100,
        auth_exp_s: 1000,
      } as any);
      expect(opts.agent_auth).toEqual({
        account_id,
        project_id,
        token_fingerprint,
        issued_at_s: 100,
        expires_at_s: 1000,
      });
    }
  });
});
