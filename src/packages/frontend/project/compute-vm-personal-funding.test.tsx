import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { VmPersonalFundingApi } from "@cocalc/util/compute-vm-funding";
import VmPersonalFunding from "./compute-vm-personal-funding";

jest.mock("@cocalc/frontend/components/icon", () => ({ Icon: () => null }));

function service(): jest.Mocked<VmPersonalFundingApi> {
  return {
    getVmPersonalFunding: jest.fn().mockResolvedValue(null),
    previewVmPersonalFunding: jest
      .fn()
      .mockImplementation(async ({ terms }) => ({
        terms,
        hourly_usd: "0.1",
        protected_storage_usd: "0.2",
        egress_cap_usd: "0.05",
        available_usd: "10",
        as_of: new Date().toISOString(),
      })),
    proposeVmPersonalFunding: jest
      .fn()
      .mockImplementation(async ({ terms }) => ({
        id: "consent",
        version: 1,
        state: "pending",
        terms,
        spent_usd: "0",
        committed_usd: "0",
        remaining_usd: "2",
        as_of: new Date().toISOString(),
        approval_url: "https://approval.example.test/personal",
      })),
    clearVmPersonalFunding: jest.fn(),
    switchVmPersonalFunding: jest.fn(),
  };
}

async function fill() {
  fireEvent.click(
    screen.getByRole("button", { name: "Personal funding options" }),
  );
  await waitFor(() =>
    expect(
      screen.getByLabelText("Additional personal limit (USD)"),
    ).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText("Additional personal limit (USD)"), {
    target: { value: "2" },
  });
  fireEvent.change(screen.getByLabelText("Personal funding ends"), {
    target: { value: "2030-01-01T12:00" },
  });
}

it("previews by keyboard and only proposes the exact reviewed authorization", async () => {
  const api = service();
  const user = userEvent.setup();
  render(
    <VmPersonalFunding
      vmId="vm"
      fundingVersion="epoch:1"
      homeVolumeIds={[]}
      api={api}
    />,
  );
  await fill();
  const button = screen.getByRole("button", {
    name: "Preview personal funding",
  });
  button.focus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "Personal funding preview" }),
    ).toHaveFocus(),
  );
  expect(api.proposeVmPersonalFunding).not.toHaveBeenCalled();
  expect(api.switchVmPersonalFunding).not.toHaveBeenCalled();
  expect(api.previewVmPersonalFunding).toHaveBeenCalledWith({
    terms: expect.objectContaining({
      vm_id: "vm",
      expected_funding_version: "epoch:1",
      cap_usd: "2",
      activation: "immediate",
      fallback_reasons: [],
    }),
  });
  await user.click(
    screen.getByRole("button", { name: "Request personal authorization" }),
  );
  const link = await screen.findByRole("link", {
    name: "Review personal funding and authorize",
  });
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(api.proposeVmPersonalFunding.mock.calls[0][0].terms).toEqual(
    api.previewVmPersonalFunding.mock.calls[0][0].terms,
  );
  expect(
    screen.getByRole("button", { name: "Preview personal funding" }),
  ).toBeDisabled();
});

it("drops a pending preview after changing the resource funding generation", async () => {
  const api = service();
  let resolve!: (value: any) => void;
  api.previewVmPersonalFunding.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const props = { vmId: "vm", homeVolumeIds: [], api };
  const view = render(<VmPersonalFunding {...props} fundingVersion="1" />);
  await fill();
  fireEvent.click(
    screen.getByRole("button", { name: "Preview personal funding" }),
  );
  await waitFor(() => expect(api.previewVmPersonalFunding).toHaveBeenCalled());
  view.rerender(<VmPersonalFunding {...props} fundingVersion="2" />);
  resolve({
    terms: api.previewVmPersonalFunding.mock.calls[0][0].terms,
    as_of: new Date().toISOString(),
  });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Preview personal funding" }),
    ).not.toHaveClass("ant-btn-loading"),
  );
  expect(
    screen.queryByRole("button", { name: "Request personal authorization" }),
  ).toBeNull();
});

it("fails closed when the existing authorization cannot be loaded", async () => {
  const api = service();
  api.getVmPersonalFunding.mockRejectedValue(
    new Error("Payer bay unavailable"),
  );
  render(
    <VmPersonalFunding
      vmId="vm"
      fundingVersion="1"
      homeVolumeIds={[]}
      api={api}
    />,
  );
  expect(await screen.findByText("Payer bay unavailable")).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Personal funding options" }),
  );
  expect(
    screen.getByRole("button", { name: "Preview personal funding" }),
  ).toBeDisabled();
  expect(api.proposeVmPersonalFunding).not.toHaveBeenCalled();
});

it("applies only an existing approval bound to the current resource version", async () => {
  const api = service();
  const consent = {
    id: "approved",
    version: 3,
    state: "approved",
    terms: {
      vm_id: "vm",
      expected_funding_version: "epoch:1",
      home_volume_ids: [],
      lane: "prepaid",
      cap_usd: "2",
      ends_at: "2030-01-01T00:00:00Z",
      activation: "immediate",
      fallback_reasons: [],
    },
    spent_usd: "0",
    committed_usd: "0",
    remaining_usd: "2",
    as_of: new Date().toISOString(),
  };
  api.getVmPersonalFunding.mockResolvedValue(consent as any);
  api.switchVmPersonalFunding.mockResolvedValue({
    ...consent,
    state: "preparing",
    version: 4,
  } as any);
  const view = render(
    <VmPersonalFunding
      vmId="vm"
      fundingVersion="epoch:2"
      homeVolumeIds={[]}
      api={api}
    />,
  );
  const button = await screen.findByRole("button", {
    name: "Apply approved personal funding",
  });
  expect(button).toBeDisabled();
  view.rerender(
    <VmPersonalFunding
      vmId="vm"
      fundingVersion="epoch:1"
      homeVolumeIds={[]}
      api={api}
    />,
  );
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() =>
    expect(api.switchVmPersonalFunding).toHaveBeenCalledWith({
      vm_id: "vm",
      consent_id: "approved",
      expected_version: 3,
      expected_funding_version: "epoch:1",
      operation_id: expect.any(String),
    }),
  );
  expect(
    await screen.findByText(
      "Switching to personal funding: waiting for VM stop and final usage accounting.",
    ),
  ).toBeVisible();
  expect(api.proposeVmPersonalFunding).not.toHaveBeenCalled();
});
