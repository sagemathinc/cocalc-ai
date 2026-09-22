import { Form } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { HostCreateForm } from "./host-create-form";
import { addMonthlyDiskPriceLabels } from "./host-create-advanced-fields";
import { HostSharedScratchFields } from "./host-shared-scratch-fields";

jest.mock("@cocalc/frontend/app-framework", () => {
  const actual = jest.requireActual("@cocalc/frontend/app-framework");
  return {
    ...actual,
    useTypedRedux: (_store: string, field: string) => {
      if (field === "country") return "US";
      if (field === "cloudflare_region") return "Washington";
      if (field === "cloudflare_region_code") return "WA";
      return false;
    },
  };
});

function TestHostCreateForm() {
  const [form] = Form.useForm();
  return (
    <HostCreateForm
      form={form}
      canCreateHosts
      provider={{
        providerOptions: [{ value: "gcp", label: "Google Cloud" }],
        selectedProvider: "gcp",
        fields: {
          schema: {
            primary: ["region", "machine_type"],
            advanced: [],
            labels: {},
            tooltips: {},
          },
          options: {
            region: [{ value: "us-west1", label: "US West 1" }],
            zone: [{ value: "us-west1-a", label: "US West 1A" }],
            machine_type: [
              {
                value: "n2d-standard-4",
                label: "n2d-standard-4 · 4 vCPU / 16 GB",
              },
            ],
          },
          labels: {
            region: "Google Region",
          },
          tooltips: {},
        },
        storage: {
          storageModeOptions: [
            {
              value: "persistent",
              label: "Persistent (growable disk)",
            },
          ],
          supportsPersistentStorage: true,
          persistentGrowable: true,
          showDiskFields: true,
        },
      }}
      billing={{
        fundingModeOptions: [
          { value: "account-postpaid", label: "CoCalc subscription" },
        ],
        defaultFundingMode: "account-postpaid",
      }}
    />
  );
}

function TestSharedScratchWithMismatchedCatalog() {
  const [form] = Form.useForm();
  return (
    <Form form={form}>
      <HostSharedScratchFields
        provider="nebius"
        catalog={{
          provider: "gcp",
          entries: [
            {
              kind: "prices",
              scope: "global",
              payload: {
                disks: {
                  "pd-balanced": { "us-west1": 0.0001 },
                },
              },
            },
          ],
          provider_capabilities: {
            nebius: {
              sharedScratchDisk: {
                supported: true,
                growable: true,
                autoGrowable: false,
                disk_types: [
                  {
                    value: "ssd_io_m3",
                    label: "Network SSD IO M3",
                    durability: "replicated",
                    default: true,
                  },
                ],
              },
            },
          },
        }}
      />
    </Form>
  );
}

function TestCreateSimilarSharedScratch({
  onDraftPatch,
}: {
  onDraftPatch: (patch: Record<string, any>) => void;
}) {
  const [form] = Form.useForm();
  React.useEffect(() => {
    form.setFieldsValue({
      shared_disk_gb: 500,
      shared_disk_type: "balanced",
      shared_scratch_auto_grow_enabled: true,
      shared_scratch_auto_grow_max_disk_gb: 600,
      shared_scratch_auto_grow_growth_step_gb: 50,
      shared_scratch_auto_grow_min_grow_interval_minutes: 5,
    });
  }, [form]);
  return (
    <Form form={form}>
      <HostSharedScratchFields
        provider="gcp"
        catalog={{
          provider: "gcp",
          entries: [],
          provider_capabilities: {
            gcp: {
              sharedScratchDisk: {
                supported: true,
                growable: true,
                autoGrowable: true,
                disk_types: [
                  {
                    value: "balanced",
                    label: "Balanced persistent disk",
                    durability: "replicated",
                    default: true,
                  },
                ],
              },
            },
          },
        }}
        draftManaged
        onDraftPatch={onDraftPatch}
      />
    </Form>
  );
}

describe("HostCreateForm", () => {
  it("requires an explicit project-host title without a generic default", () => {
    const html = renderToStaticMarkup(<TestHostCreateForm />);

    expect(html).toContain("Project host title");
    expect(html).toContain("Fall numerical methods course");
    expect(html).not.toContain("My host");
    expect(html).toContain(
      "background:var(--cocalc-ui-inset);color:var(--cocalc-ui-text);border:1px solid var(--cocalc-ui-border)",
    );
  });

  it("mounts advanced storage fields before the panel is expanded", () => {
    const html = renderToStaticMarkup(<TestHostCreateForm />);

    expect(html).toContain("Storage mode");
    expect(html).toContain("Disk type");
  });

  it("shows compact region context and GCP main disk auto-grow at create time", () => {
    const html = renderToStaticMarkup(<TestHostCreateForm />);

    expect(html).not.toContain("Cloudflare location");
    expect(html).toContain("Google Region");
    expect(html).toContain("your region:");
    expect(html).toContain("Western North America");
    expect(html).toContain("Enable guarded auto-grow");
  });

  it("shows monthly per-GB disk prices in disk type options", () => {
    const options = addMonthlyDiskPriceLabels({
      provider: "gcp",
      options: [{ value: "balanced", label: "Balanced SSD" }],
      selection: {
        region: "us-west1",
        zone: "us-west1-a",
        machine_type: "n2d-standard-4",
        pricing_model: "on_demand",
        storage_mode: "persistent",
      },
      catalog: {
        provider: "gcp",
        entries: [
          {
            kind: "machine_types",
            scope: "zone/us-west1-a",
            payload: [
              { name: "n2d-standard-4", guestCpus: 4, memoryMb: 16384 },
            ],
          },
          {
            kind: "prices",
            scope: "global",
            payload: {
              fetched_at: "2026-05-19T00:00:00.000Z",
              service_id: "compute",
              families: {
                n2d: {
                  cpu: { "us-west1": 0.05 },
                  ram: { "us-west1": 0.01 },
                  spot_cpu: {},
                  spot_ram: {},
                },
              },
              gpus: {},
              disks: {
                "pd-balanced": { "us-west1": 0.0001 },
              },
            },
          },
        ],
        provider_capabilities: {},
      },
    });

    expect(options[0].label).toBe("Balanced SSD · $0.08/GB/mo");
  });

  it("renders Nebius shared scratch fields while a non-Nebius price catalog is still loaded", () => {
    expect(() =>
      renderToStaticMarkup(<TestSharedScratchWithMismatchedCatalog />),
    ).not.toThrow();
  });

  it("does not show /scratch auto-grow for providers without online scratch resize", () => {
    const html = renderToStaticMarkup(
      <TestSharedScratchWithMismatchedCatalog />,
    );

    expect(html).toContain("Shared scratch disk");
    expect(html).not.toContain("Automatically grow /scratch");
  });

  it("shows and can remove shared scratch copied into an unregistered draft", async () => {
    const user = userEvent.setup();
    const onDraftPatch = jest.fn();
    render(<TestCreateSimilarSharedScratch onDraftPatch={onDraftPatch} />);

    const toggle = screen.getByRole("switch", {
      name: "Enable shared scratch disk",
    });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(
      screen.getByRole("spinbutton", { name: "Scratch size (GB)" }),
    ).toHaveValue("500");

    await user.click(toggle);

    await waitFor(() =>
      expect(onDraftPatch).toHaveBeenCalledWith(
        expect.objectContaining({
          shared_disk_gb: undefined,
          shared_disk_type: undefined,
          shared_scratch_auto_grow_enabled: false,
          shared_scratch_auto_grow_max_disk_gb: undefined,
        }),
      ),
    );
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });
});
