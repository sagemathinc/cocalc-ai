/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Nebius Spot max-price mode (#684) through the real compute API entry
// points, with NEBIUS_SPOT_OFFERED on: what gets billed is the live-quoted
// cap, and course-sponsored compute never gets Spot.

const STOP = "stop after the write";
const insertComputeVm = jest.fn(async () => {
  throw new Error(STOP);
});
const updateComputeVm = jest.fn(async () => {
  throw new Error(STOP);
});
let ownedVm: any;
const quote = jest.fn(async () => ({
  region: "eu-north1",
  platform: "gpu-h100-sxm",
  price_per_gpu_hour: "2.000",
  quoted_at: "2026-11-06T00:00:00.000Z",
}));

jest.mock("@cocalc/util/consts/nebius-spot", () => ({
  ...jest.requireActual("@cocalc/util/consts/nebius-spot"),
  NEBIUS_SPOT_OFFERED: true,
  assertNebiusSpotOffered: () => undefined,
}));
jest.mock("@cocalc/server/compute/placement", () => ({
  ...jest.requireActual("@cocalc/server/compute/placement"),
  computeMachineSupportsSpot: () => true,
  selectNebiusComputeMachine: () => ({
    name: "1gpu-16vcpu-200gb",
    platform: "gpu-h100-sxm",
    platform_label: "H100",
    vcpus: 16,
    memory_gib: 200,
    gpus: 1,
    gpu_label: "h100",
    allowed_for_preemptibles: true,
  }),
}));
jest.mock("@cocalc/server/cloud/providers", () => ({
  ...jest.requireActual("@cocalc/server/cloud/providers"),
  loadNebiusInstanceTypes: async () => [],
}));
jest.mock("@cocalc/server/cloud/host-util", () => ({
  ...jest.requireActual("@cocalc/server/cloud/host-util"),
  getNebiusMinimumBootDiskGb: async () => 20,
}));
jest.mock("@cocalc/server/compute/volume-placement", () => ({
  ...jest.requireActual("@cocalc/server/compute/volume-placement"),
  routeVmToHomeVolume: async () => undefined,
}));
jest.mock("@cocalc/server/compute/funding/vm-funding", () => ({
  ...jest.requireActual("@cocalc/server/compute/funding/vm-funding"),
  requireSponsoredVmAdmission: async () => undefined,
  normalizeVmFundingSource: (source: any) => source ?? undefined,
}));
jest.mock("@cocalc/server/compute/config", () => ({
  ...jest.requireActual("@cocalc/server/compute/config"),
  getComputeVmConfig: async () => ({
    max_ttl_minutes: 1440,
    max_boot_disk_gb: 1000,
    max_active_per_account: 10,
    max_active_total: 100,
    environment: "test",
    staging_legacy_provider: false,
  }),
  requireComputeVmCreateAllowed: () => undefined,
}));
jest.mock("@cocalc/server/project-host/admission", () => ({
  ...jest.requireActual("@cocalc/server/project-host/admission"),
  assertDedicatedHostAdmissionForAccount: async () => undefined,
}));
jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: async () => false,
}));
jest.mock("@cocalc/server/compute/owner-resource-mutation", () => ({
  ...jest.requireActual("@cocalc/server/compute/owner-resource-mutation"),
  routeComputeOwnerMutation: async () => undefined,
  requireComputeOwnerFreshAuth: async () => undefined,
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({
    project_hosts_nebius_surcharge_percent: 10,
    nebius_spot_headroom_percent: 20,
  }),
}));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: async () => ({ rows: [{ count: "0" }] }) }),
}));
jest.mock("@cocalc/server/project-host/spend", () => ({
  ...jest.requireActual("@cocalc/server/project-host/spend"),
  // GPU instance: on-demand $4.50/GPU-h; spot = the cap given, or the
  // daily catalog's $1.00 when no cap is given (never billed with a cap)
  estimateDedicatedHostRate: async (input: any) => {
    const provider =
      input.billing_state === "stopped"
        ? 0.01
        : input.pricing_model === "spot"
          ? input.nebius_spot_max_price_per_gpu_hour != null
            ? Number(input.nebius_spot_max_price_per_gpu_hour)
            : 1
          : 4.5;
    const usd = provider * 1.1;
    return {
      hourly_cost_usd: usd.toFixed(6),
      pricing_snapshot: {
        version: 1,
        billing_state: input.billing_state,
        hourly_cost_usd: usd.toFixed(6),
        components: [
          {
            key: input.billing_state === "stopped" ? "disk" : "gpu",
            label: "x",
            hourly_cost_usd: usd.toFixed(6),
            billing_states:
              input.billing_state === "stopped"
                ? ["running", "stopped"]
                : ["running"],
          },
        ],
        configuration: {},
      },
    };
  },
}));
jest.mock("@cocalc/server/compute/provider", () => ({
  ...jest.requireActual("@cocalc/server/compute/provider"),
  quoteNebiusComputeSpotPrice: (...a: any[]) => (quote as any)(...a),
}));
jest.mock("@cocalc/server/compute/db", () => ({
  ...jest.requireActual("@cocalc/server/compute/db"),
  insertComputeVm: (...a: any[]) => (insertComputeVm as any)(...a),
  updateComputeVm: (...a: any[]) => (updateComputeVm as any)(...a),
  allocateComputeVmPublicHostname: async () => "vm.example",
  resolveOwnedComputeVm: async () => ownedVm,
  appendComputeEvent: async () => undefined,
  enqueueComputeWork: async () => undefined,
}));

import { createVm, setVmMachineType, setVmPricingModel } from "./compute";

const ACCOUNT = "22222222-2222-4222-8222-222222222222";

const createRequest = (overrides: any = {}) =>
  ({
    account_id: ACCOUNT,
    name: "gpu-box",
    provider: "nebius",
    region: "eu-north1",
    machine_type: "1gpu-16vcpu-200gb",
    provider_spec: { platform: "gpu-h100-sxm" },
    pricing_model: "spot",
    funding_mode: "account-prepaid",
    ssh_public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGx test",
    idempotency_key: "create-1",
    ...overrides,
  }) as any;

function catalogRate(provider: number) {
  const usd = (provider * 1.1).toFixed(6);
  return {
    hourly_cost_usd: usd,
    provider_hourly_cost_usd: provider.toFixed(9),
    pricing_snapshot: {
      version: 1,
      billing_state: "running",
      hourly_cost_usd: usd,
      components: [
        {
          key: "gpu",
          label: "x",
          hourly_cost_usd: usd,
          billing_states: ["running"],
        },
      ],
      configuration: {},
    },
  };
}

function stoppedVm(overrides: any = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "gpu-box",
    owner_account_id: ACCOUNT,
    project_id: null,
    provider: "nebius",
    region: "eu-north1",
    zone: null,
    machine_type: "1gpu-16vcpu-200gb",
    architecture: "x86_64",
    provider_spec: { platform: "gpu-h100-sxm" },
    cpu: 16,
    ram_gb: 200,
    gpu_type: "h100",
    gpu_count: 1,
    boot_disk_gb: 100,
    operating_system: "linux",
    funding_mode: "account-prepaid",
    state: "stopped",
    desired_state: "stopped",
    desired_pricing_model: "on_demand",
    effective_pricing_model: "on_demand",
    spot_hourly_price: catalogRate(1).hourly_cost_usd,
    on_demand_hourly_price: catalogRate(4.5).hourly_cost_usd,
    expires_at: null,
    metadata: {
      billing: {
        spot_supported: true,
        running_rates: { spot: catalogRate(1), on_demand: catalogRate(4.5) },
      },
    },
    ...overrides,
  };
}

describe("compute API Nebius Spot entry points (#684)", () => {
  beforeEach(() => {
    insertComputeVm.mockClear();
    updateComputeVm.mockClear();
    quote.mockClear();
  });

  it("createVm bills a new Spot VM at the live-quoted cap", async () => {
    await expect(createVm(createRequest())).rejects.toThrow(STOP);
    expect(quote).toHaveBeenCalledTimes(1);
    const row = (insertComputeVm.mock.calls[0] as any)[0];
    // live $2.000 + 20% = $2.400 cap; billed at the cap plus the 10% surcharge
    expect(row.metadata.billing.nebius_spot.max_price_per_gpu_hour).toBe(
      "2.400",
    );
    expect(Number(row.spot_hourly_price)).toBeCloseTo(2.4 * 1.1, 6);
    expect(
      Number(row.metadata.billing.running_rates.spot.hourly_cost_usd),
    ).toBeCloseTo(2.4 * 1.1, 6);
  });

  it("createVm refuses Nebius Spot for course-sponsored compute", async () => {
    await expect(
      createVm(
        createRequest({
          funding_source: {
            kind: "course",
            pool_id: "33333333-3333-4333-8333-333333333333",
            grant_id: "44444444-4444-4444-8444-444444444444",
            payer_account_id: "55555555-5555-4555-8555-555555555555",
          },
        }),
      ),
    ).rejects.toThrow(/Course-sponsored compute uses Standard pricing/);
    expect(insertComputeVm).not.toHaveBeenCalled();
  });

  it("(control) createVm on Standard needs no quote", async () => {
    await expect(
      createVm(createRequest({ pricing_model: "on_demand" })),
    ).rejects.toThrow(STOP);
    expect(quote).not.toHaveBeenCalled();
    const row = (insertComputeVm.mock.calls[0] as any)[0];
    expect(row.metadata.billing.nebius_spot).toBeUndefined();
  });

  it("setVmPricingModel to Spot stores the live-quoted cap and rate", async () => {
    ownedVm = stoppedVm();
    await expect(
      setVmPricingModel({
        account_id: ACCOUNT,
        id_or_name: ownedVm.id,
        pricing_model: "spot",
        idempotency_key: "pricing-1",
      } as any),
    ).rejects.toThrow(STOP);
    const patch = (updateComputeVm.mock.calls[0] as any)[1];
    expect(patch.desired_pricing_model).toBe("spot");
    expect(patch.metadata.billing.nebius_spot.max_price_per_gpu_hour).toBe(
      "2.400",
    );
    // never the catalog's $1.10 spot rate
    expect(Number(patch.spot_hourly_price)).toBeCloseTo(2.4 * 1.1, 6);
    expect(
      Number(patch.metadata.billing.running_rates.spot.hourly_cost_usd),
    ).toBeCloseTo(2.4 * 1.1, 6);
  });

  it("setVmMachineType on a Spot VM stores a new cap and rate", async () => {
    ownedVm = stoppedVm({
      machine_type: "1gpu-32vcpu-400gb",
      desired_pricing_model: "spot",
      effective_pricing_model: "spot",
      metadata: {
        billing: {
          spot_supported: true,
          running_rates: {
            spot: catalogRate(1.5),
            on_demand: catalogRate(4.5),
          },
          nebius_spot: { max_price_per_gpu_hour: "1.500" },
        },
      },
    });
    quote.mockResolvedValueOnce({
      region: "eu-north1",
      platform: "gpu-h100-sxm",
      price_per_gpu_hour: "2.500",
      quoted_at: "2026-11-06T00:00:00.000Z",
    });
    await expect(
      setVmMachineType({
        account_id: ACCOUNT,
        id_or_name: ownedVm.id,
        machine_type: "1gpu-16vcpu-200gb",
        idempotency_key: "machine-1",
      } as any),
    ).rejects.toThrow(STOP);
    const patch = (updateComputeVm.mock.calls[0] as any)[1];
    // live $2.500 + 20% = $3.000, never the old $1.500 cap
    expect(patch.metadata.billing.nebius_spot.max_price_per_gpu_hour).toBe(
      "3.000",
    );
    expect(Number(patch.spot_hourly_price)).toBeCloseTo(3 * 1.1, 6);
  });

  it("(control) setVmMachineType on a Standard VM drops any old cap", async () => {
    ownedVm = stoppedVm({
      machine_type: "1gpu-32vcpu-400gb",
      metadata: {
        billing: {
          spot_supported: true,
          running_rates: { spot: catalogRate(1), on_demand: catalogRate(4.5) },
          nebius_spot: { max_price_per_gpu_hour: "1.500" },
        },
      },
    });
    await expect(
      setVmMachineType({
        account_id: ACCOUNT,
        id_or_name: ownedVm.id,
        machine_type: "1gpu-16vcpu-200gb",
        idempotency_key: "machine-2",
      } as any),
    ).rejects.toThrow(STOP);
    expect(quote).not.toHaveBeenCalled();
    const patch = (updateComputeVm.mock.calls[0] as any)[1];
    expect(patch.metadata.billing.nebius_spot).toBeUndefined();
  });
});
