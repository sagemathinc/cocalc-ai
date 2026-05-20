import { Form } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import { renderToStaticMarkup } from "react-dom/server";
import { HostCreateForm } from "./host-create-form";
import { addMonthlyDiskPriceLabels } from "./host-create-advanced-fields";

jest.mock("@cocalc/frontend/app-framework", () => {
  const actual = jest.requireActual("@cocalc/frontend/app-framework");
  return {
    ...actual,
    useTypedRedux: () => false,
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
                label: "n2d-standard-4 · 4 vCPU / 16 GiB",
              },
            ],
          },
          labels: {},
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

describe("HostCreateForm", () => {
  it("mounts advanced storage fields before the panel is expanded", () => {
    const html = renderToStaticMarkup(<TestHostCreateForm />);

    expect(html).toContain("Storage mode");
    expect(html).toContain("Disk type");
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
});
