import { Form } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import { renderToStaticMarkup } from "react-dom/server";
import { HostCreateForm } from "./host-create-form";

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
});
