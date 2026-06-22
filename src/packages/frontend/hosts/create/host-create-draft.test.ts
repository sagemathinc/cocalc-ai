import type { Host, HostCatalog } from "@cocalc/conat/hub/api/hosts";
import {
  applyPreset,
  buildCreateHostPayloadFromDraft,
  buildDefaultDraft,
  buildSimilarDraft,
  buildSubmitDraft,
  getAvailablePresets,
  normalizeDraft,
  type HostCreateDraftContext,
} from "./host-create-draft";

const catalog = (
  provider: string,
  entries: HostCatalog["entries"],
): HostCatalog => ({
  provider,
  entries,
  provider_capabilities: {},
});

const billing: HostCreateDraftContext["billing"] = {
  fundingModeOptions: [{ value: "account-postpaid" }],
  defaultFundingMode: "account-postpaid",
};

const gcpCatalog = () =>
  catalog("gcp", [
    {
      kind: "regions",
      scope: "global",
      payload: [
        { name: "us-west1", zones: ["us-west1-a", "us-west1-b"] },
        { name: "us-central1", zones: ["us-central1-a"] },
      ],
    },
    {
      kind: "zones",
      scope: "global",
      payload: [
        { name: "us-west1-a", region: "us-west1" },
        { name: "us-west1-b", region: "us-west1" },
        { name: "us-central1-a", region: "us-central1" },
      ],
    },
    {
      kind: "machine_types",
      scope: "zone/us-west1-a",
      payload: [
        { name: "n2d-standard-4", guestCpus: 4, memoryMb: 16384 },
        { name: "n2d-standard-128", guestCpus: 128, memoryMb: 524288 },
        { name: "g2-standard-4", guestCpus: 4, memoryMb: 16384 },
      ],
    },
    {
      kind: "machine_types",
      scope: "zone/us-west1-b",
      payload: [{ name: "n2d-standard-4", guestCpus: 4, memoryMb: 16384 }],
    },
    {
      kind: "machine_types",
      scope: "zone/us-central1-a",
      payload: [{ name: "n2d-standard-4", guestCpus: 4, memoryMb: 16384 }],
    },
    {
      kind: "gpu_types",
      scope: "zone/us-west1-a",
      payload: [{ name: "nvidia-l4" }],
    },
    {
      kind: "prices",
      scope: "global",
      payload: {
        fetched_at: "2026-05-19T00:00:00.000Z",
        service_id: "compute",
        families: {
          n2d: {
            cpu: { "us-west1": 0.05, "us-central1": 0.05 },
            ram: { "us-west1": 0.01, "us-central1": 0.01 },
            spot_cpu: { "us-west1": 0.02, "us-central1": 0.02 },
            spot_ram: { "us-west1": 0.004, "us-central1": 0.004 },
          },
          g2: {
            cpu: { "us-west1": 0.05 },
            ram: { "us-west1": 0.01 },
            spot_cpu: { "us-west1": 0.02 },
            spot_ram: { "us-west1": 0.004 },
          },
        },
        gpus: {
          "nvidia-l4": {
            on_demand: { "us-west1": 0.5 },
            spot: { "us-west1": 0.2 },
          },
        },
        disks: {},
      },
    },
  ]);

const nebiusCatalog = () =>
  catalog("nebius", [
    {
      kind: "regions",
      scope: "global",
      payload: [{ name: "eu-north1" }],
    },
    {
      kind: "instance_types",
      scope: "global",
      payload: [
        {
          name: "128vcpu-512gb",
          vcpus: 128,
          memory_gib: 512,
          gpus: 0,
          allowed_for_preemptibles: false,
        },
        {
          name: "gpu-rtx6000_1gpu-24vcpu-218gb",
          platform: "gpu-rtx6000",
          platform_label: "NVIDIA RTX PRO 6000",
          vcpus: 24,
          memory_gib: 218,
          gpus: 1,
          gpu_label: "NVIDIA RTX PRO 6000",
          allowed_for_preemptibles: true,
        },
        {
          name: "1gpu-16vcpu-200gb",
          platform: "gpu-h200-sxm",
          platform_label: "NVIDIA H200 NVLink",
          vcpus: 16,
          memory_gib: 200,
          gpus: 1,
          gpu_label: "H200",
          allowed_for_preemptibles: true,
        },
      ],
    },
    {
      kind: "prices",
      scope: "global",
      payload: [
        {
          product: "NVIDIA RTX PRO 6000",
          region: "eu-north1",
          price_usd: "1.8",
          unit: "GPU hour",
        },
        {
          product: "Preemptible NVIDIA RTX PRO 6000",
          region: "eu-north1",
          price_usd: "0.95",
          unit: "GPU hour",
        },
        {
          product: "NVIDIA H200 NVLink with Intel Sapphire Rapids",
          region: "eu-north1",
          price_usd: "3.5",
          unit: "GPU hour",
        },
        {
          product: "Preemptible NVIDIA H200 NVLink with Intel Sapphire Rapids",
          region: "eu-north1",
          price_usd: "1.45",
          unit: "GPU hour",
        },
        {
          product: "Network SSD IO M3 disk",
          region: "eu-north1",
          price_usd: "0.000161111",
          unit: "GiB hour",
        },
      ],
    },
  ]);

const lambdaCatalog = () =>
  catalog("lambda", [
    {
      kind: "instance_types",
      scope: "global",
      payload: [
        {
          name: "gpu_1x_a10",
          vcpus: 30,
          memory_gib: 200,
          gpus: 1,
          regions: ["us-west-1"],
        },
        {
          name: "cpu_16x",
          vcpus: 16,
          memory_gib: 64,
          gpus: 0,
          regions: ["us-east-1"],
        },
      ],
    },
  ]);

const hyperstackCatalog = () =>
  catalog("hyperstack", [
    {
      kind: "regions",
      scope: "global",
      payload: [{ name: "canada-1" }, { name: "us-1" }],
    },
    {
      kind: "flavors",
      scope: "global",
      payload: [
        {
          region_name: "canada-1",
          flavors: [
            {
              name: "cpu-small",
              cpu: 4,
              ram: 16,
              gpu: "none",
              gpu_count: 0,
            },
            {
              name: "gpu-a100",
              cpu: 16,
              ram: 128,
              gpu: "A100",
              gpu_count: 1,
            },
          ],
        },
        {
          region_name: "us-1",
          flavors: [
            {
              name: "cpu-medium",
              cpu: 8,
              ram: 32,
              gpu: "none",
              gpu_count: 0,
            },
          ],
        },
      ],
    },
  ]);

const providerContext = (
  provider: HostCreateDraftContext["enabledProviders"][number],
): HostCreateDraftContext => ({
  enabledProviders: [provider],
  billing,
  catalogByProvider: {
    gcp: gcpCatalog(),
    nebius: nebiusCatalog(),
    lambda: lambdaCatalog(),
    hyperstack: hyperstackCatalog(),
  },
});

const allProvidersContext = (): HostCreateDraftContext => ({
  enabledProviders: ["gcp", "nebius", "lambda", "hyperstack", "self-host"],
  billing,
  catalogByProvider: {
    gcp: gcpCatalog(),
    nebius: nebiusCatalog(),
    lambda: lambdaCatalog(),
    hyperstack: hyperstackCatalog(),
  },
});

const expectIdempotent = (
  draft: Parameters<typeof normalizeDraft>[0],
  context: HostCreateDraftContext,
) => {
  const once = normalizeDraft(draft, context).draft;
  const twice = normalizeDraft(once, context).draft;
  expect(twice).toEqual(once);
};

describe("host-create-draft", () => {
  it("builds a valid default GCP draft from provider options", () => {
    const context: HostCreateDraftContext = {
      enabledProviders: ["gcp"],
      billing,
      catalogByProvider: {
        gcp: catalog("gcp", [
          {
            kind: "regions",
            scope: "global",
            payload: [{ name: "us-west1", zones: ["us-west1-a"] }],
          },
          {
            kind: "zones",
            scope: "global",
            payload: [{ name: "us-west1-a", region: "us-west1" }],
          },
          {
            kind: "machine_types",
            scope: "zone/us-west1-a",
            payload: [
              { name: "n2d-standard-4", guestCpus: 4, memoryMb: 16384 },
            ],
          },
        ]),
      },
    };

    const draft = buildDefaultDraft(context);
    expect(draft).toMatchObject({
      provider: "gcp",
      region: "us-west1",
      zone: "us-west1-a",
      gpu_type: "none",
      machine_type: "n2d-standard-4",
      funding_mode: "account-postpaid",
      storage_mode: "persistent",
      region_preference: "cheapest",
      disk_gb: 100,
      start_after_create: true,
    });

    const payload = buildCreateHostPayloadFromDraft(draft, context);
    expect(payload).toMatchObject({
      name: "My host",
      funding_mode: "account-postpaid",
      start_after_create: true,
      machine: {
        cloud: "gcp",
        zone: "us-west1-a",
        machine_type: "n2d-standard-4",
        disk_gb: 100,
      },
    });
  });

  it("uses the preferred region when choosing default GCP placement", () => {
    const context: HostCreateDraftContext = {
      enabledProviders: ["gcp"],
      preferredRegion: "wnam",
      billing,
      catalogByProvider: {
        gcp: catalog("gcp", [
          {
            kind: "regions",
            scope: "global",
            payload: [
              { name: "africa-south1", zones: ["africa-south1-a"] },
              { name: "us-west1", zones: ["us-west1-a"] },
            ],
          },
          {
            kind: "zones",
            scope: "global",
            payload: [
              { name: "africa-south1-a", region: "africa-south1" },
              { name: "us-west1-a", region: "us-west1" },
            ],
          },
          {
            kind: "machine_types",
            scope: "zone/us-west1-a",
            payload: [
              { name: "n2d-standard-4", guestCpus: 4, memoryMb: 16384 },
            ],
          },
          {
            kind: "machine_types",
            scope: "zone/africa-south1-a",
            payload: [
              { name: "n2d-standard-4", guestCpus: 4, memoryMb: 16384 },
            ],
          },
        ]),
      },
    };

    expect(buildDefaultDraft(context)).toMatchObject({
      region: "us-west1",
      zone: "us-west1-a",
    });
  });

  it("normalizes a similar Nebius draft and blocks unsupported spot choices", () => {
    const context: HostCreateDraftContext = {
      enabledProviders: ["nebius"],
      billing,
      catalogByProvider: {
        nebius: catalog("nebius", [
          {
            kind: "regions",
            scope: "global",
            payload: [{ name: "eu-north1" }],
          },
          {
            kind: "instance_types",
            scope: "global",
            payload: [
              {
                name: "cpu-d3-standard-4",
                vcpus: 4,
                memory_gib: 16,
                gpus: 0,
                allowed_for_preemptibles: false,
              },
            ],
          },
        ]),
      },
    };

    const draft = buildSimilarDraft(
      {
        id: "host-1",
        name: "Nebius CPU",
        region: "eu-north1",
        pricing_model: "spot",
        interruption_restore_policy: "immediate",
        machine: {
          cloud: "nebius",
          machine_type: "cpu-d3-standard-4",
          disk_gb: 100,
          disk_type: "ssd_io_m3",
          storage_mode: "persistent",
        },
      } as unknown as Host,
      context,
    );

    expect(draft).toMatchObject({
      name: "Nebius CPU (similar)",
      provider: "nebius",
      machine_type: "cpu-d3-standard-4",
      pricing_model: "on_demand",
      interruption_restore_policy: "none",
      disk_type: "ssd_io_m3",
      disk_gb: 186,
    });
  });

  it("keeps the canonical provider when submitting with stale hidden form state", () => {
    const context = allProvidersContext();
    const canonical = normalizeDraft(
      {
        ...buildDefaultDraft(context),
        provider: "nebius",
        region: "eu-north1",
        machine_type: "1gpu-16vcpu-200gb",
        pricing_model: "spot",
        interruption_restore_policy: "immediate",
      },
      context,
    ).draft;

    const submitDraft = buildSubmitDraft(
      {
        ...canonical,
        name: "Typed host name",
        provider: "gcp",
        region: "us-west1",
        zone: "us-west1-a",
        machine_type: "n2d-standard-4",
      },
      canonical,
      context,
    );
    const payload = buildCreateHostPayloadFromDraft(submitDraft, context);

    expect(submitDraft).toMatchObject({
      name: "Typed host name",
      provider: "nebius",
      region: "eu-north1",
      machine_type: "1gpu-16vcpu-200gb",
      pricing_model: "spot",
    });
    expect(payload.machine.cloud).toBe("nebius");
    expect(payload.machine.machine_type).toBe("1gpu-16vcpu-200gb");
  });

  it("normalizes Nebius disks to the provider-required 93 GB increments", () => {
    const draft = normalizeDraft(
      {
        provider: "nebius",
        disk_gb: 50,
        disk: 50,
      },
      providerContext("nebius"),
    ).draft;

    expect(draft.disk_type).toBe("ssd_io_m3");
    expect(draft.disk_gb).toBe(93);
    expect(draft.disk).toBe(93);
  });

  it("normalizes managed cloud disks to the project host minimum", () => {
    const draft = normalizeDraft(
      {
        provider: "gcp",
        disk_gb: 50,
        disk: 50,
      },
      providerContext("gcp"),
    ).draft;

    expect(draft.disk_gb).toBe(75);
    expect(draft.disk).toBe(75);
  });

  it("keeps shared scratch for GCP", () => {
    const draft = normalizeDraft(
      {
        provider: "gcp",
        shared_disk_gb: 50,
      },
      providerContext("gcp"),
    ).draft;

    expect(draft.shared_disk_gb).toBe(50);
    expect(draft.shared_disk_type).toBe("balanced");
  });

  it("uses 10 GB as the minimum shared scratch size for GCP", () => {
    const draft = normalizeDraft(
      {
        provider: "gcp",
        shared_disk_gb: 1,
      },
      providerContext("gcp"),
    ).draft;

    expect(draft.shared_disk_gb).toBe(10);
    expect(draft.shared_disk_type).toBe("balanced");
  });

  it("normalizes Nebius shared scratch disks to 93 GB increments", () => {
    const draft = normalizeDraft(
      {
        provider: "nebius",
        shared_disk_gb: 100,
        shared_disk_type: "balanced",
      },
      providerContext("nebius"),
    ).draft;

    expect(draft.shared_disk_gb).toBe(186);
    expect(draft.shared_disk_type).toBe("balanced");
  });

  it("keeps Nebius disk sizes constrained even with network SSD selected", () => {
    const draft = normalizeDraft(
      {
        provider: "nebius",
        disk_type: "ssd",
        disk_gb: 100,
      },
      providerContext("nebius"),
    ).draft;

    expect(draft.disk_type).toBe("ssd");
    expect(draft.disk_gb).toBe(186);
    expect(draft.disk).toBe(186);
  });

  it("uses ephemeral storage for Lambda drafts", () => {
    const context: HostCreateDraftContext = {
      enabledProviders: ["lambda"],
      billing,
      catalogByProvider: {
        lambda: catalog("lambda", [
          {
            kind: "instance_types",
            scope: "global",
            payload: [
              {
                name: "gpu_1x_a10",
                vcpus: 30,
                memory_gib: 200,
                gpus: 1,
                regions: ["us-west-1"],
              },
            ],
          },
        ]),
      },
    };

    const draft = buildDefaultDraft(context);
    expect(draft).toMatchObject({
      provider: "lambda",
      machine_type: "gpu_1x_a10",
      region: "us-west-1",
      storage_mode: "ephemeral",
    });
    expect(draft.disk_gb).toBeUndefined();
    expect(draft.disk_type).toBeUndefined();
  });

  it("preserves create-without-start through normalization and payload build", () => {
    const context = providerContext("gcp");
    const draft = normalizeDraft(
      {
        ...buildDefaultDraft(context),
        start_after_create: false,
      },
      context,
    ).draft;
    const payload = buildCreateHostPayloadFromDraft(draft, context);

    expect(draft.start_after_create).toBe(false);
    expect(payload.start_after_create).toBe(false);
  });

  it("persists GCP main disk auto-grow metadata in create payloads", () => {
    const context = providerContext("gcp");
    const draft = normalizeDraft(
      {
        ...buildDefaultDraft(context),
        disk_gb: 150,
        disk: 150,
        auto_grow_enabled: true,
        auto_grow_max_disk_gb: 400,
      },
      context,
    ).draft;
    const payload = buildCreateHostPayloadFromDraft(draft, context);

    expect(draft).toMatchObject({
      auto_grow_enabled: true,
      auto_grow_max_disk_gb: 400,
      auto_grow_growth_step_gb: 50,
      auto_grow_min_grow_interval_minutes: 60,
    });
    expect(payload.machine.metadata.auto_grow).toEqual({
      enabled: true,
      max_disk_gb: 400,
      growth_step_gb: 50,
      min_grow_interval_minutes: 60,
    });
  });

  it("clears main disk auto-grow when switching away from GCP", () => {
    const draft = normalizeDraft(
      {
        provider: "nebius",
        auto_grow_enabled: true,
        auto_grow_max_disk_gb: 500,
        auto_grow_growth_step_gb: 50,
        auto_grow_min_grow_interval_minutes: 60,
      },
      providerContext("nebius"),
    ).draft;
    const payload = buildCreateHostPayloadFromDraft(
      draft,
      providerContext("nebius"),
    );

    expect(draft.auto_grow_enabled).toBe(false);
    expect(draft.auto_grow_max_disk_gb).toBeUndefined();
    expect(payload.machine.metadata.auto_grow).toBeUndefined();
  });

  it.each([
    ["gcp", { provider: "gcp", region: "bad", zone: "bad" }],
    [
      "nebius",
      {
        provider: "nebius",
        region: "bad",
        machine_type: "gpu-h100-sxm-1",
        disk_type: "ssd_io_m3",
        disk_gb: 100,
      },
    ],
    ["lambda", { provider: "lambda", machine_type: "missing" }],
    ["hyperstack", { provider: "hyperstack", region: "canada-1" }],
    [
      "self-host",
      {
        provider: "self-host",
        machine_type: "n2d-standard-4",
        self_host_ssh_target: "ubuntu@example",
      },
    ],
  ] as const)("normalizes %s drafts idempotently", (_label, input) => {
    expectIdempotent(input, allProvidersContext());
  });

  it.each([
    ["GCP to Nebius", "gcp", "nebius", ["region", "machine_type"]],
    ["Nebius to GCP", "nebius", "gcp", ["region", "zone", "machine_type"]],
    ["Lambda to GCP", "lambda", "gcp", ["region", "zone", "machine_type"]],
    [
      "Hyperstack to Nebius",
      "hyperstack",
      "nebius",
      ["region", "machine_type"],
    ],
  ] as const)(
    "normalizes provider switch %s without blank active fields",
    (_label, fromProvider, toProvider, activeFields) => {
      const context = allProvidersContext();
      const base = buildDefaultDraft({
        ...context,
        enabledProviders: [fromProvider],
      });
      const switched = normalizeDraft(
        { ...base, provider: toProvider },
        context,
      ).draft;

      expect(switched.provider).toBe(toProvider);
      for (const field of activeFields) {
        expect(switched[field]).toBeTruthy();
      }
      expectIdempotent(switched, context);
    },
  );

  it("builds similar Lambda drafts from concrete host settings", () => {
    const context = providerContext("lambda");
    const draft = buildSimilarDraft(
      {
        id: "lambda-host",
        name: "Lambda GPU",
        region: "us-west-1",
        pricing_model: "on_demand",
        machine: {
          cloud: "lambda",
          machine_type: "gpu_1x_a10",
          storage_mode: "ephemeral",
        },
      } as unknown as Host,
      context,
    );

    expect(draft).toMatchObject({
      name: "Lambda GPU (similar)",
      provider: "lambda",
      machine_type: "gpu_1x_a10",
      region: "us-west-1",
      storage_mode: "ephemeral",
    });
    expectIdempotent(draft, context);
  });

  it("builds similar Hyperstack drafts from concrete host settings", () => {
    const context = providerContext("hyperstack");
    const draft = buildSimilarDraft(
      {
        id: "hyperstack-host",
        name: "Hyperstack GPU",
        region: "canada-1",
        pricing_model: "on_demand",
        size: "gpu-a100",
        machine: {
          cloud: "hyperstack",
          machine_type: "gpu-a100",
          disk_gb: 200,
          storage_mode: "persistent",
        },
      } as unknown as Host,
      context,
    );

    expect(draft).toMatchObject({
      name: "Hyperstack GPU (similar)",
      provider: "hyperstack",
      region: "canada-1",
      size: "gpu-a100",
      storage_mode: "persistent",
      disk_gb: 200,
    });
    expectIdempotent(draft, context);
  });

  it("offers simple presets and applies the GPU preset when available", () => {
    const context: HostCreateDraftContext = {
      enabledProviders: ["hyperstack"],
      billing,
      catalogByProvider: {
        hyperstack: catalog("hyperstack", [
          {
            kind: "regions",
            scope: "global",
            payload: [{ name: "canada-1" }],
          },
          {
            kind: "flavors",
            scope: "global",
            payload: [
              {
                region_name: "canada-1",
                flavors: [
                  {
                    name: "cpu-small",
                    cpu: 4,
                    ram: 16,
                    gpu: "none",
                    gpu_count: 0,
                  },
                  {
                    name: "gpu-a100",
                    cpu: 16,
                    ram: 128,
                    gpu: "A100",
                    gpu_count: 1,
                  },
                ],
              },
            ],
          },
        ]),
      },
    };
    const base = buildDefaultDraft(context);

    expect(getAvailablePresets(base, context)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "balanced-cpu" }),
        expect.objectContaining({ id: "gpu-workstation", disabled: false }),
      ]),
    );

    expect(applyPreset("gpu-workstation", base, context)).toMatchObject({
      provider: "hyperstack",
      region: "canada-1",
      size: "gpu-a100",
    });
  });

  it("uses explicit Nebius presets in product order", () => {
    const context = providerContext("nebius");
    const base = buildDefaultDraft(context);

    expect(
      getAvailablePresets(base, context).map((preset) => preset.label),
    ).toEqual(["Standard GPU", "Low cost Spot GPU", "HPC"]);
    expect(applyPreset("gpu-workstation", base, context)).toMatchObject({
      provider: "nebius",
      machine_type: "gpu-rtx6000_1gpu-24vcpu-218gb",
      pricing_model: "on_demand",
    });
    expect(applyPreset("low-cost-spot", base, context)).toMatchObject({
      provider: "nebius",
      machine_type: "gpu-rtx6000_1gpu-24vcpu-218gb",
      pricing_model: "spot",
    });
    expect(applyPreset("balanced-cpu", base, context)).toMatchObject({
      provider: "nebius",
      machine_type: "128vcpu-512gb",
      pricing_model: "on_demand",
    });
  });

  it("does not let Nebius Non-GPU CPU labels satisfy the Standard GPU preset", () => {
    const context: HostCreateDraftContext = {
      enabledProviders: ["nebius"],
      billing,
      catalogByProvider: {
        nebius: catalog("nebius", [
          {
            kind: "regions",
            scope: "global",
            payload: [{ name: "us-central1" }],
          },
          {
            kind: "instance_types",
            scope: "global",
            payload: [
              {
                name: "16vcpu-64gb",
                platform: "cpu-platform",
                platform_label: "Non-GPU AMD Epyc Genoa",
                regions: ["us-central1"],
                vcpus: 16,
                memory_gib: 64,
                gpus: 0,
                gpu_label: "Non-GPU AMD Epyc Genoa",
              },
              {
                name: "1gpu-24vcpu-218gb",
                platform: "gpu-rtx6000",
                platform_label: "NVIDIA® RTX PRO™ 6000",
                regions: ["us-central1"],
                vcpus: 24,
                memory_gib: 218,
                gpus: 1,
                gpu_label: "NVIDIA® RTX PRO™ 6000",
                allowed_for_preemptibles: true,
              },
            ],
          },
          {
            kind: "prices",
            scope: "global",
            payload: [
              {
                product: "Non-GPU AMD Epyc Genoa. CPU",
                region: "us-central1",
                price_usd: "0.01",
                unit: "vCPU hour",
              },
              {
                product: "Non-GPU AMD Epyc Genoa. RAM",
                region: "us-central1",
                price_usd: "0.002",
                unit: "GiB hour",
              },
              {
                product: "NVIDIA® RTX PRO™ 6000",
                region: "us-central1",
                price_usd: "1.80",
                unit: "GPU hour",
              },
              {
                product: "Network SSD IO M3 disk",
                region: "us-central1",
                price_usd: "0.00016164383561643835",
                unit: "GiB hour",
              },
            ],
          },
        ]),
      },
    };
    const base = {
      ...buildDefaultDraft(context),
      region: "us-central1",
      machine_type: "16vcpu-64gb",
    };

    expect(
      getAvailablePresets(base, context).find(
        (preset) => preset.id === "gpu-workstation",
      )?.disabled,
    ).toBeFalsy();
    expect(applyPreset("gpu-workstation", base, context)).toMatchObject({
      provider: "nebius",
      region: "us-central1",
      machine_type: "1gpu-24vcpu-218gb",
      pricing_model: "on_demand",
    });
  });

  it("keeps GCP CPU presets on exactly 16 GiB machines", () => {
    const context = providerContext("gcp");
    const base = {
      ...buildDefaultDraft(context),
      region: "us-west1",
      zone: "us-west1-a",
    };

    expect(applyPreset("balanced-cpu", base, context)).toMatchObject({
      provider: "gcp",
      region: "us-west1",
      machine_type: "n2d-standard-4",
      pricing_model: "on_demand",
    });
    expect(applyPreset("low-cost-spot", base, context)).toMatchObject({
      provider: "gcp",
      region: "us-west1",
      machine_type: "n2d-standard-4",
      pricing_model: "spot",
    });
  });

  it("applies the GCP GPU preset in a compatible zone", () => {
    const context = providerContext("gcp");
    const draft = applyPreset(
      "gpu-workstation",
      {
        ...buildDefaultDraft(context),
        region: "us-west1",
        zone: "us-west1-b",
        machine_type: "n2d-standard-4",
      },
      context,
    );

    expect(draft).toMatchObject({
      provider: "gcp",
      region: "us-west1",
      zone: "us-west1-a",
      gpu_type: "nvidia-l4",
      machine_type: "g2-standard-4",
      pricing_model: "on_demand",
    });
  });

  it.each(["gcp", "nebius", "lambda", "hyperstack"] as const)(
    "visible %s presets normalize to valid idempotent drafts",
    (provider) => {
      const context = providerContext(provider);
      const base = buildDefaultDraft(context);
      const presets = getAvailablePresets(base, context).filter(
        (preset) => !preset.disabled,
      );

      expect(presets.length).toBeGreaterThan(0);
      for (const preset of presets) {
        const draft = applyPreset(preset.id, base, context);
        const normalized = normalizeDraft(draft, context);
        expect(normalized.draft).toEqual(draft);
        for (const field of normalized.activeFields) {
          expect(draft[field]).toBeTruthy();
        }
      }
    },
  );

  it("normalizes inactive provider fields away", () => {
    const context: HostCreateDraftContext = {
      enabledProviders: ["self-host"],
      catalogByProvider: {},
    };
    const { draft } = normalizeDraft(
      {
        provider: "self-host",
        name: "Self hosted",
        machine_type: "n2d-standard-4",
        zone: "us-west1-a",
        self_host_ssh_target: "ubuntu@example",
      },
      context,
    );

    expect(draft.machine_type).toBeUndefined();
    expect(draft.zone).toBeUndefined();
    expect(draft).toMatchObject({
      provider: "self-host",
      self_host_kind: "direct",
      self_host_mode: "local",
      storage_mode: "persistent",
    });
  });
});
