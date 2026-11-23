/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { validateComputeFirewallRules } from "./provider";

const NETWORK = "projects/compute-test/global/networks/cocalc-compute-vm";
const TAG = "cocalc-compute-vm";
const SSH_RANGES = ["198.51.100.0/24", "203.0.113.7/32"];

const config = {
  gcp_network: NETWORK,
  gcp_network_tag: TAG,
  ssh_source_ranges: SSH_RANGES,
};

function rule(overrides: Record<string, any>) {
  return {
    network: `https://www.googleapis.com/compute/v1/${NETWORK}`,
    targetTags: [TAG],
    disabled: false,
    ...overrides,
  };
}

function baseRules(): Map<string, any> {
  return new Map<string, any>([
    [
      "cocalc-compute-ssh",
      rule({
        direction: "INGRESS",
        allowed: [{ IPProtocol: "tcp", ports: ["22"] }],
        sourceRanges: [...SSH_RANGES],
      }),
    ],
    [
      "cocalc-compute-https",
      rule({
        direction: "INGRESS",
        allowed: [{ IPProtocol: "tcp", ports: ["443"] }],
        sourceRanges: ["0.0.0.0/0"],
      }),
    ],
    [
      "cocalc-compute-metadata",
      rule({
        direction: "EGRESS",
        priority: 100,
        allowed: [{ IPProtocol: "all" }],
        destinationRanges: ["169.254.169.254/32"],
      }),
    ],
    [
      "cocalc-compute-deny-private",
      rule({
        direction: "EGRESS",
        priority: 200,
        denied: [{ IPProtocol: "all" }],
        destinationRanges: [
          "0.0.0.0/8",
          "10.0.0.0/8",
          "100.64.0.0/10",
          "127.0.0.0/8",
          "169.254.0.0/16",
          "172.16.0.0/12",
          "192.0.0.0/24",
          "192.0.2.0/24",
          "192.88.99.0/24",
          "192.168.0.0/16",
          "198.18.0.0/15",
          "198.51.100.0/24",
          "199.36.153.4/30",
          "199.36.153.8/30",
          "203.0.113.0/24",
          "224.0.0.0/4",
          "240.0.0.0/4",
        ],
      }),
    ],
    [
      "cocalc-compute-public-egress",
      rule({
        direction: "EGRESS",
        priority: 1000,
        allowed: [{ IPProtocol: "all" }],
        destinationRanges: ["0.0.0.0/0"],
      }),
    ],
  ]);
}

describe("managed compute firewall validation", () => {
  it("accepts SSH from exactly the configured named ranges", () => {
    expect(() =>
      validateComputeFirewallRules(baseRules(), config),
    ).not.toThrow();
  });

  it("rejects SSH open to the Internet", () => {
    const rules = baseRules();
    rules.get("cocalc-compute-ssh").sourceRanges = ["0.0.0.0/0"];
    expect(() => validateComputeFirewallRules(rules, config)).toThrow(
      "managed compute SSH ingress rule is invalid",
    );
  });

  it("rejects SSH ranges that differ from the configured ranges", () => {
    const rules = baseRules();
    rules.get("cocalc-compute-ssh").sourceRanges = [
      ...SSH_RANGES,
      "192.0.2.10/32",
    ];
    expect(() => validateComputeFirewallRules(rules, config)).toThrow(
      "managed compute SSH ingress rule is invalid",
    );
  });

  it("fails closed when no SSH source ranges are configured", () => {
    expect(() =>
      validateComputeFirewallRules(baseRules(), {
        ...config,
        ssh_source_ranges: [],
      }),
    ).toThrow("managed compute SSH source ranges are not configured");
  });

  it.each([
    [[{ IPProtocol: "tcp", ports: ["22"] }], ["192.0.2.10/32"]],
    [[{ IPProtocol: "tcp", ports: ["20-30"] }], ["192.0.2.10/32"]],
    [[{ IPProtocol: "tcp" }], ["192.0.2.10/32"]],
    [[{ IPProtocol: "all" }], ["192.0.2.10/32"]],
  ])("rejects another rule that opens SSH (%j)", (allowed, sourceRanges) => {
    const rules = baseRules();
    rules.set("extra", rule({ direction: "INGRESS", allowed, sourceRanges }));
    expect(() => validateComputeFirewallRules(rules, config)).toThrow(
      "unexpected SSH ingress firewall rule 'extra'",
    );
  });

  it("rejects a public rule that splits 0.0.0.0/0 into halves", () => {
    const rules = baseRules();
    rules.set(
      "split",
      rule({
        direction: "INGRESS",
        allowed: [{ IPProtocol: "tcp", ports: ["8080"] }],
        sourceRanges: ["0.0.0.0/1", "128.0.0.0/1"],
      }),
    );
    expect(() => validateComputeFirewallRules(rules, config)).toThrow(
      "unexpected public ingress firewall rule 'split'",
    );
  });

  it("allows a narrow non-SSH ingress rule", () => {
    const rules = baseRules();
    rules.set(
      "narrow",
      rule({
        direction: "INGRESS",
        allowed: [{ IPProtocol: "tcp", ports: ["8080"] }],
        sourceRanges: ["192.0.2.10/32"],
      }),
    );
    expect(() => validateComputeFirewallRules(rules, config)).not.toThrow();
  });
});
