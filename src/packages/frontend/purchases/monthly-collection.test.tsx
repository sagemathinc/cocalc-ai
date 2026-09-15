import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MonthlyCollection from "./monthly-collection";
import type { MonthlyCollectionApi } from "@cocalc/util/monthly-collection";
jest.mock("@cocalc/frontend/webapp-client", () => ({ webapp_client: {} }));
jest.mock("@cocalc/frontend/components/icon", () => ({ Icon: () => null }));
function fixture() {
  return {
    getMonthlyCollection: jest
      .fn()
      .mockResolvedValue({
        consent: { enabled: false, version: 0, terms_version: 1 },
        available: true,
        legacy_enabled: false,
        pending: [],
      }),
    proposeMonthlyCollection: jest
      .fn()
      .mockResolvedValue({
        intent_id: "intent",
        approval_url: "https://approve.example.test/funding/intent",
        status: "pending",
      }),
  } satisfies jest.Mocked<MonthlyCollectionApi>;
}
it("requires explicit consent, then separate approval, and restores focus after confirmation", async () => {
  const api = fixture();
  render(<MonthlyCollection api={api} />);
  const user = userEvent.setup();
  const checkbox = await screen.findByRole("checkbox");
  const button = screen.getByRole("button", {
    name: "Request monthly collection",
  });
  expect(button).toBeDisabled();
  await user.click(checkbox);
  await user.tab();
  expect(button).toHaveFocus();
  await user.keyboard("{Enter}");
  const link = await screen.findByRole("link", {
    name: "Review monthly collection and authorize",
  });
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(screen.getByRole("status")).toHaveTextContent("disabled");
  expect(api.proposeMonthlyCollection).toHaveBeenCalledWith(
    expect.objectContaining({
      terms: {
        kind: "monthlyCollection",
        enabled: true,
        expected_version: 0,
        terms_version: 1,
      },
    }),
  );
  api.getMonthlyCollection.mockResolvedValue({
    consent: { enabled: true, version: 1, terms_version: 1 },
    available: true,
    legacy_enabled: false,
    pending: [],
  });
  await user.click(
    screen.getByRole("button", { name: "Refresh monthly collection" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "Monthly collection" }),
    ).toHaveFocus(),
  );
  expect(screen.getByRole("status")).toHaveTextContent("enabled");
});
it("retries a lost proposal with the same operation and can resume a saved approval", async () => {
  const api = fixture();
  api.proposeMonthlyCollection.mockRejectedValueOnce(Error("lost reply"));
  render(<MonthlyCollection api={api} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("checkbox"));
  await user.click(
    screen.getByRole("button", { name: "Request monthly collection" }),
  );
  await screen.findByRole("alert");
  await user.click(
    screen.getByRole("button", { name: "Request monthly collection" }),
  );
  await screen.findByRole("link");
  expect(api.proposeMonthlyCollection.mock.calls[0]).toEqual(
    api.proposeMonthlyCollection.mock.calls[1],
  );
});
it("allows disabling legacy enrollment", async () => {
  const api = fixture();
  api.getMonthlyCollection.mockResolvedValue({
    consent: { enabled: false, version: 0, terms_version: 1 },
    available: true,
    legacy_enabled: true,
    pending: [],
  });
  render(<MonthlyCollection api={api} />);
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", {
      name: "Request disabling monthly collection",
    }),
  );
  expect(api.proposeMonthlyCollection).toHaveBeenCalledWith(
    expect.objectContaining({
      terms: expect.objectContaining({ enabled: false }),
    }),
  );
});
it("clears an expired proposal and requires a new opt-in", async () => {
  const api = fixture();
  render(<MonthlyCollection api={api} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("checkbox"));
  await user.click(
    screen.getByRole("button", { name: "Request monthly collection" }),
  );
  await screen.findByRole("link");
  await user.click(
    screen.getByRole("button", { name: "Refresh monthly collection" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("link")).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(
    screen.getByRole("button", { name: "Request monthly collection" }),
  ).toBeDisabled();
});
it("recovers a pending approval after reload without proposing another", async () => {
  const api = fixture();
  api.getMonthlyCollection.mockResolvedValue({
    consent: { enabled: false, version: 0, terms_version: 1 },
    available: true,
    legacy_enabled: false,
    pending: [
      {
        intent_id: "saved",
        approval_url: "https://approve.example.test/funding/saved",
        status: "pending",
      },
    ],
  });
  render(<MonthlyCollection api={api} />);
  expect(await screen.findByRole("link")).toHaveAttribute(
    "href",
    "https://approve.example.test/funding/saved",
  );
  expect(api.proposeMonthlyCollection).not.toHaveBeenCalled();
});
