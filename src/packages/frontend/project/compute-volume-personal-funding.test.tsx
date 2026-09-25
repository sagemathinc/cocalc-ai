import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { VolumePersonalFundingApi } from "@cocalc/util/compute-volume-personal-funding";
import VolumePersonalFunding from "./compute-volume-personal-funding";

jest.mock("@cocalc/frontend/components/icon", () => ({ Icon: () => null }));

function service(): jest.Mocked<VolumePersonalFundingApi> {
  return {
    getVolumePersonalFunding: jest.fn().mockResolvedValue(null),
    previewVolumePersonalFunding: jest.fn(async ({ terms }) => ({
      terms,
      volume_name: "Research data",
      size_gb: 20,
      hourly_usd: "0.003",
      protected_storage_usd: "0.22",
      available_usd: "10",
      storage_delete_at: "2030-01-04T12:00:00Z",
      as_of: new Date().toISOString(),
    })),
    proposeVolumePersonalFunding: jest.fn(async ({ terms }) => ({
      id: "consent",
      terms,
      state: "pending",
      version: 1,
      spent_usd: "0",
      committed_usd: "0",
      remaining_usd: "2",
      approval_url: "https://approval.example/storage",
      as_of: new Date().toISOString(),
    })),
    switchVolumePersonalFunding: jest.fn(),
    clearVolumePersonalFunding: jest.fn(),
  };
}
async function fill() {
  await waitFor(() =>
    expect(
      screen.getByLabelText("Additional storage limit (USD)"),
    ).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText("Additional storage limit (USD)"), {
    target: { value: "2" },
  });
  fireEvent.change(screen.getByLabelText("Storage funding ends"), {
    target: { value: "2030-01-01T12:00" },
  });
}

it("previews storage by keyboard and proposes only the exact reviewed disk terms", async () => {
  const api = service();
  const user = userEvent.setup();
  render(
    <VolumePersonalFunding volumeId="disk" fundingVersion="epoch" api={api} />,
  );
  await fill();
  screen.getByRole("button", { name: "Preview storage funding" }).focus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "Personal storage preview" }),
    ).toHaveFocus(),
  );
  expect(screen.getByText("Research data")).toBeVisible();
  expect(screen.getByText("$0.003")).toBeVisible();
  expect(api.proposeVolumePersonalFunding).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Authorize" }));
  await screen.findByRole("link", { name: "Authorize" });
  expect(screen.getByText("Authorization required")).toBeVisible();
  expect(api.proposeVolumePersonalFunding.mock.calls[0][0].terms).toEqual(
    api.previewVolumePersonalFunding.mock.calls[0][0].terms,
  );
  expect(api.switchVolumePersonalFunding).not.toHaveBeenCalled();
});

it("disables new authorization when the existing consent cannot be loaded", async () => {
  const api = service();
  api.getVolumePersonalFunding.mockRejectedValue(Error("Funding unavailable"));
  render(
    <VolumePersonalFunding volumeId="disk" fundingVersion="epoch" api={api} />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Funding unavailable",
  );
  expect(
    screen.getByRole("button", { name: "Preview storage funding" }),
  ).toBeDisabled();
});

it("discards a pending preview after the disk funding version changes", async () => {
  const api = service();
  let resolve!: (value: any) => void;
  api.previewVolumePersonalFunding.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = render(
    <VolumePersonalFunding volumeId="disk" fundingVersion="old" api={api} />,
  );
  await fill();
  fireEvent.click(
    screen.getByRole("button", { name: "Preview storage funding" }),
  );
  await waitFor(() =>
    expect(api.previewVolumePersonalFunding).toHaveBeenCalled(),
  );
  view.rerender(
    <VolumePersonalFunding volumeId="disk" fundingVersion="new" api={api} />,
  );
  resolve({
    terms: api.previewVolumePersonalFunding.mock.calls[0][0].terms,
    as_of: new Date().toISOString(),
  });
  await waitFor(() =>
    expect(
      screen.queryByRole("heading", { name: "Personal storage preview" }),
    ).not.toBeInTheDocument(),
  );
});

it("keeps cancellation available on attached storage and reuses its operation after a lost response", async () => {
  const api = service();
  const consent = {
    id: "consent",
    version: 2,
    state: "active" as const,
    terms: {
      volume_id: "disk",
      expected_funding_version: "old",
      lane: "prepaid" as const,
      cap_usd: "2",
      ends_at: "2030-01-01T12:00:00Z",
    },
    spent_usd: "0",
    committed_usd: "1",
    remaining_usd: "1",
    as_of: new Date().toISOString(),
  };
  api.getVolumePersonalFunding.mockResolvedValue(consent);
  api.clearVolumePersonalFunding
    .mockRejectedValueOnce(Error("Reply lost"))
    .mockResolvedValue({ ...consent, state: "cancelled", version: 3 });
  render(
    <VolumePersonalFunding
      volumeId="disk"
      fundingVersion="epoch"
      api={api}
      canSwitch={false}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "Preview storage funding" }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    await screen.findByRole("button", { name: "Cancel storage authorization" }),
  );
  expect(await screen.findByText("Error: Reply lost")).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Cancel storage authorization" }),
  );
  await screen.findByText("Storage authorization: cancelled");
  expect(api.clearVolumePersonalFunding.mock.calls[1][0]).toEqual(
    api.clearVolumePersonalFunding.mock.calls[0][0],
  );
});
