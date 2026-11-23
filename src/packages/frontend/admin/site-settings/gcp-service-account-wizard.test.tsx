/**
 * @jest-environment jsdom
 * @jest-environment-options {"url":"https://staging.cocalc.ai"}
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import GcpServiceAccountWizard from "./gcp-service-account-wizard";
import { webapp_client } from "@cocalc/frontend/webapp-client";

jest.mock("@cocalc/frontend/editors/slate/static-markdown", () => ({
  __esModule: true,
  default: ({ value }: { value: string }) => <pre>{value}</pre>,
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        system: {
          createProviderSetupChallenge: jest.fn(),
          getProviderSetupChallenge: jest.fn(),
          clearProviderSetupChallenge: jest.fn(),
        },
      },
    },
  },
}));

const system = webapp_client.conat_client.hub.system as any;
const serviceAccount = {
  type: "service_account",
  project_id: "compute-test",
  private_key_id: "key-1",
  private_key: "secret",
  client_email: "cocalc-compute-vm@compute-test.iam.gserviceaccount.com",
};

function renderWizard(
  opts: Partial<React.ComponentProps<typeof GcpServiceAccountWizard>> = {},
) {
  const onClose = jest.fn();
  const onSave = jest.fn(async () => {});
  render(
    <GcpServiceAccountWizard
      open
      computeVm
      onClose={onClose}
      onSave={onSave}
      domainName="staging.cocalc.ai"
      {...opts}
    />,
  );
  return { onClose, onSave };
}

async function enterProjectAndContinue() {
  fireEvent.change(screen.getByPlaceholderText("my-gcp-project"), {
    target: { value: "compute-test" },
  });
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "I opened gcloud (Cloud Shell or local install)",
    }),
  );
  await waitFor(() =>
    expect(system.createProviderSetupChallenge).toHaveBeenCalledWith({
      provider: "gcp",
    }),
  );
}

describe("GcpServiceAccountWizard", () => {
  const originalGetComputedStyle = window.getComputedStyle;

  beforeAll(() => {
    jest
      .spyOn(window, "getComputedStyle")
      .mockImplementation((elt: Element) => originalGetComputedStyle(elt));
  });

  afterAll(() => {
    (window.getComputedStyle as jest.Mock).mockRestore();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    system.clearProviderSetupChallenge.mockResolvedValue({ deleted: true });
  });

  it("passes the configured SSH source ranges to the compute setup script", async () => {
    system.createProviderSetupChallenge.mockResolvedValue({
      id: "challenge-1",
      token: "upload-token",
      provider: "gcp",
      status: "pending",
      created_at: "2026-08-07T00:00:00.000Z",
      expires_at: "2026-08-07T01:00:00.000Z",
    });
    renderWizard({ sshSourceRanges: "203.0.113.7/32,198.51.100.0/24" });
    await enterProjectAndContinue();
    expect(
      await screen.findByText(
        /SSH_SOURCE_RANGES='203\.0\.113\.7\/32,198\.51\.100\.0\/24'/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Set Managed Compute VMs: SSH Source Ranges first"),
    ).not.toBeInTheDocument();
  });

  it("warns that compute setup needs SSH source ranges", async () => {
    system.createProviderSetupChallenge.mockResolvedValue({
      id: "challenge-1",
      token: "upload-token",
      provider: "gcp",
      status: "pending",
      created_at: "2026-08-07T00:00:00.000Z",
      expires_at: "2026-08-07T01:00:00.000Z",
    });
    renderWizard();
    await enterProjectAndContinue();
    expect(
      await screen.findByText(
        "Set Managed Compute VMs: SSH Source Ranges first",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/SSH_SOURCE_RANGES=/)).not.toBeInTheDocument();
  });

  it("keeps the compute setup flow compact and isolates deletion instructions", async () => {
    system.createProviderSetupChallenge.mockResolvedValue({
      id: "challenge-1",
      token: "upload-token",
      provider: "gcp",
      status: "pending",
      created_at: "2026-08-07T00:00:00.000Z",
      expires_at: "2026-08-07T01:00:00.000Z",
    });
    renderWizard();

    expect(
      screen.getByText(
        "Use a GCP project dedicated exclusively to this CoCalc site.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Name your service account/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Cleanup if needed/)).not.toBeInTheDocument();

    await enterProjectAndContinue();

    expect(await screen.findByText(/compute-vm-setup\.sh/)).toBeInTheDocument();
    expect(screen.getByText(/SA_NAME="cocalc-compute-vm"/)).toBeInTheDocument();
    expect(
      screen.getByText("Waiting for setup to finish..."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: /Copy Commands/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/gcloud iam service-accounts delete/),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Delete Service Account..." }),
    );
    expect(
      screen.getByText("Use this only to undo the setup"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/gcloud iam service-accounts delete/),
    ).toBeInTheDocument();
  });

  it("preserves an existing custom service account name", async () => {
    system.createProviderSetupChallenge.mockResolvedValue({
      id: "challenge-custom",
      token: "upload-token",
      provider: "gcp",
      status: "pending",
      created_at: "2026-08-07T00:00:00.000Z",
      expires_at: "2026-08-07T01:00:00.000Z",
    });
    renderWizard({
      currentJson: JSON.stringify({
        ...serviceAccount,
        client_email:
          "existing-custom-account@compute-test.iam.gserviceaccount.com",
      }),
    });

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "I opened gcloud (Cloud Shell or local install)",
      }),
    );

    expect(
      await screen.findByText(/SA_NAME="existing-custom-account"/),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Delete Service Account..." }),
    );
    expect(
      screen.getByText(
        /existing-custom-account@compute-test\.iam\.gserviceaccount\.com/,
      ),
    ).toBeInTheDocument();
  });

  it("saves the uploaded compute credentials and network from the modal footer", async () => {
    system.createProviderSetupChallenge.mockResolvedValue({
      id: "challenge-2",
      token: "upload-token",
      provider: "gcp",
      status: "uploaded",
      created_at: "2026-08-07T00:00:00.000Z",
      expires_at: "2026-08-07T01:00:00.000Z",
      uploaded_at: "2026-08-07T00:05:00.000Z",
      payload: {
        compute_vm_gcp_service_account_json: serviceAccount,
        compute_vm_gcp_network:
          "projects/compute-test/global/networks/cocalc-compute-vm",
      },
    });
    const { onClose, onSave } = renderWizard();
    await enterProjectAndContinue();

    expect(
      await screen.findByText("Setup finished successfully"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Apply Uploaded JSON")).not.toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save Changes" });
    expect(save).toBeEnabled();

    await act(async () => {
      fireEvent.click(save);
    });

    expect(onSave).toHaveBeenCalledWith({
      compute_vm_gcp_service_account_json: JSON.stringify(
        serviceAccount,
        null,
        2,
      ),
      compute_vm_gcp_network:
        "projects/compute-test/global/networks/cocalc-compute-vm",
    });
    expect(system.clearProviderSetupChallenge).toHaveBeenCalledWith({
      id: "challenge-2",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("uses the same save flow for the project-host GCP credential", async () => {
    const hostServiceAccount = {
      ...serviceAccount,
      client_email: "cocalc-host@compute-test.iam.gserviceaccount.com",
    };
    system.createProviderSetupChallenge.mockResolvedValue({
      id: "challenge-3",
      token: "upload-token",
      provider: "gcp",
      status: "uploaded",
      created_at: "2026-08-07T00:00:00.000Z",
      expires_at: "2026-08-07T01:00:00.000Z",
      payload: { google_cloud_service_account_json: hostServiceAccount },
    });
    const onSave = jest.fn(async () => {});
    renderWizard({ computeVm: false, onSave });
    await enterProjectAndContinue();

    await act(async () => {
      fireEvent.click(
        await screen.findByRole("button", { name: "Save Changes" }),
      );
    });

    expect(onSave).toHaveBeenCalledWith({
      google_cloud_service_account_json: JSON.stringify(
        hostServiceAccount,
        null,
        2,
      ),
    });
  });
});
