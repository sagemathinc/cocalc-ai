/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

// Starting a managed VM must fail closed exactly like creating one: the
// network rules are checked before any provider start call.

import { startProviderComputeVm } from "./provider";
import { getComputeVmConfig } from "./config";
import { getProviderContext } from "../cloud/provider-context";
import type { ComputeVmRow } from "./types";

jest.mock("@cocalc/cloud", () => ({
  GcpProvider: jest.fn(() => ({ startHost: jest.fn() })),
  NebiusProvider: jest.fn(() => ({
    startHost: jest.fn(),
    ensureManagedComputeSecurityGroup: jest.fn(),
  })),
}));
jest.mock("@google-cloud/compute", () => {
  const firewalls = { listAsync: jest.fn() };
  return {
    __firewalls: firewalls,
    FirewallsClient: jest.fn(() => firewalls),
    InstancesClient: jest.fn(),
    DisksClient: jest.fn(),
    AddressesClient: jest.fn(),
    RegionOperationsClient: jest.fn(),
    ZoneOperationsClient: jest.fn(),
    SubnetworksClient: jest.fn(),
  };
});
jest.mock("./config", () => ({ getComputeVmConfig: jest.fn() }));
jest.mock("../cloud/host-util", () => ({
  buildHostSpec: jest.fn(),
  getGcpAcceleratorImage: jest.fn(),
}));
jest.mock("../cloud/nebius-credentials", () => ({
  getNebiusRegionKeys: jest.fn(),
}));
jest.mock("../cloud/provider-context", () => ({
  getProviderContext: jest.fn(),
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({}),
}));

const sdk = jest.requireMock("@google-cloud/compute");
const cloud = jest.requireMock("@cocalc/cloud");
const gcp = cloud.GcpProvider.mock.results[0].value;
const nebius = cloud.NebiusProvider.mock.results[0].value;

const NETWORK = "projects/compute-test/global/networks/cocalc-compute-vm";
const TAG = "cocalc-compute-vm";
const SSH_RANGES = ["203.0.113.7/32"];

function rule(overrides: Record<string, any>) {
  return {
    network: `https://www.googleapis.com/compute/v1/${NETWORK}`,
    targetTags: [TAG],
    ...overrides,
  };
}

function firewallRules(sshSources: string[]) {
  return [
    rule({
      name: "cocalc-compute-ssh",
      direction: "INGRESS",
      allowed: [{ IPProtocol: "tcp", ports: ["22"] }],
      sourceRanges: sshSources,
    }),
    rule({
      name: "cocalc-compute-https",
      direction: "INGRESS",
      allowed: [{ IPProtocol: "tcp", ports: ["443"] }],
      sourceRanges: ["0.0.0.0/0"],
    }),
    rule({
      name: "cocalc-compute-metadata",
      direction: "EGRESS",
      priority: 100,
      allowed: [{ IPProtocol: "all" }],
      destinationRanges: ["169.254.169.254/32"],
    }),
    rule({
      name: "cocalc-compute-deny-private",
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
    rule({
      name: "cocalc-compute-public-egress",
      direction: "EGRESS",
      priority: 1000,
      allowed: [{ IPProtocol: "all" }],
      destinationRanges: ["0.0.0.0/0"],
    }),
  ];
}

let project = 0;
function gcpConfig(overrides: Record<string, any> = {}) {
  // A distinct project id per case keeps the module's 5-minute check cache
  // from carrying a pass from one case into another.
  project += 1;
  return {
    environment: "development",
    gcp_service_account_json: "{}",
    gcp_project_id: `compute-test-${project}`,
    gcp_network: NETWORK,
    gcp_network_tag: TAG,
    ssh_source_ranges: SSH_RANGES,
    staging_legacy_provider: false,
    ...overrides,
  };
}

function vm(provider: "gcp" | "nebius"): ComputeVmRow {
  return {
    id: "12345678-1234-4234-8234-123456789abc",
    provider,
    region: provider === "gcp" ? "us-central1" : "eu-north1",
    zone: provider === "gcp" ? "us-central1-a" : undefined,
    provider_instance_id: "instance-1",
    metadata: {},
  } as unknown as ComputeVmRow;
}

beforeEach(() => {
  gcp.startHost.mockReset();
  nebius.startHost.mockReset();
  nebius.ensureManagedComputeSecurityGroup.mockReset();
  sdk.__firewalls.listAsync.mockReset();
  jest.mocked(getProviderContext).mockResolvedValue({ creds: {} } as any);
});

describe("starting a managed VM checks the network rules first", () => {
  it("starts a GCP VM when SSH is open only to the configured ranges", async () => {
    jest.mocked(getComputeVmConfig).mockResolvedValue(gcpConfig() as any);
    sdk.__firewalls.listAsync.mockImplementation(async function* () {
      yield* firewallRules(SSH_RANGES);
    });
    await startProviderComputeVm(vm("gcp"));
    expect(gcp.startHost).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the live SSH rule is still public", gcpConfig(), ["0.0.0.0/0"]],
    [
      "no SSH source ranges are configured",
      gcpConfig({ ssh_source_ranges: [] }),
      SSH_RANGES,
    ],
    [
      "the stored setting is invalid",
      gcpConfig({
        ssh_source_ranges: [],
        ssh_source_ranges_error: "SSH source range 'x' must be an IPv4 CIDR",
      }),
      SSH_RANGES,
    ],
  ])("refuses to start a GCP VM when %s", async (_case, config, sshSources) => {
    jest.mocked(getComputeVmConfig).mockResolvedValue(config as any);
    sdk.__firewalls.listAsync.mockImplementation(async function* () {
      yield* firewallRules(sshSources as string[]);
    });
    await expect(startProviderComputeVm(vm("gcp"))).rejects.toThrow(
      /SSH (ingress rule is invalid|source ranges are (not configured|invalid))/,
    );
    expect(gcp.startHost).not.toHaveBeenCalled();
  });

  it("refuses to start a Nebius VM when SSH source ranges are not configured", async () => {
    jest
      .mocked(getComputeVmConfig)
      .mockResolvedValue(gcpConfig({ ssh_source_ranges: [] }) as any);
    await expect(startProviderComputeVm(vm("nebius"))).rejects.toThrow(
      "managed compute SSH source ranges are not configured",
    );
    expect(nebius.ensureManagedComputeSecurityGroup).not.toHaveBeenCalled();
    expect(nebius.startHost).not.toHaveBeenCalled();
  });

  it("checks the Nebius security group before starting", async () => {
    jest.mocked(getComputeVmConfig).mockResolvedValue(gcpConfig() as any);
    nebius.ensureManagedComputeSecurityGroup.mockRejectedValue(
      new Error("nebius managed VM security group has unexpected rules"),
    );
    await expect(startProviderComputeVm(vm("nebius"))).rejects.toThrow(
      "unexpected rules",
    );
    expect(nebius.startHost).not.toHaveBeenCalled();
  });
});
