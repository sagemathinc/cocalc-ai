import type { Host, HostCatalog } from "@cocalc/conat/hub/api/hosts";
import {
  applyPreset,
  buildCreateHostPayloadFromDraft,
  buildDefaultDraft,
  buildSimilarDraft,
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
          name: "cpu-d3-standard-4",
          vcpus: 4,
          memory_gib: 16,
          gpus: 0,
          allowed_for_preemptibles: false,
        },
        {
          name: "gpu-h100-sxm-1",
          vcpus: 16,
          memory_gib: 200,
          gpus: 1,
          gpu_label: "H100",
          allowed_for_preemptibles: true,
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
