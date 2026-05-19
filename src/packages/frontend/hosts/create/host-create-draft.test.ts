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
