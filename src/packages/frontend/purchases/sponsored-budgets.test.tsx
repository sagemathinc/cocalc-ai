import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SponsoredBudgets from "./sponsored-budgets";

jest.mock("@cocalc/frontend/webapp-client", () => ({ webapp_client: {} }));
jest.mock("@cocalc/frontend/components/icon", () => ({ Icon: () => null }));
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => ({ clear_all_handlers: () => {} }) },
}));

const pool = {
  id: "11111111-1111-4111-8111-111111111111",
  version: 1,
  course_project_id: "22222222-2222-4222-8222-222222222222",
  course_instance_id: "33333333-3333-4333-8333-333333333333",
  state: "active",
  lane: "prepaid",
  authorized_usd: "50",
  spent_usd: "0",
  reserved_usd: "0",
  released_usd: "0",
  starts_at: "2026-01-01T00:00:00Z",
  ends_at: "2030-01-01T00:00:00Z",
  grants: [],
};
function fixture() {
  const api = {
    getOwnedPools: jest.fn().mockResolvedValue({
      as_of: new Date().toISOString(),
      pools: [pool],
      sponsorship: {
        enabled: false,
        available: false,
        reason: "New course sponsorship is disabled.",
      },
    }),
    previewPoolChange: jest.fn().mockImplementation(async ({ terms }) => ({
      terms,
      pool: { ...pool, state: "closed", released_usd: "50" },
      requires_course_access: false,
      as_of: new Date().toISOString(),
    })),
    proposePoolChange: jest.fn().mockResolvedValue({
      id: "intent",
      status: "pending",
      approval_url: "https://approve.example.test/funding/intent",
      expires_at: "2030-01-01T00:00:00Z",
    }),
    getAllocationStatus: jest.fn().mockResolvedValue({
      id: "intent",
      status: "pending",
      approval_url: "https://approve.example.test/funding/intent",
      expires_at: "2030-01-01T00:00:00Z",
    }),
  };
  return api;
}

it("reaches payer closure by keyboard without course access or sponsorship enabled", async () => {
  const api = fixture(),
    user = userEvent.setup();
  render(<SponsoredBudgets api={api} />);
  const close = await screen.findByRole("button", { name: "Close pool" });
  expect(api.getOwnedPools).toHaveBeenCalledWith();
  expect(close).toBeEnabled();
  close.focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("heading", { name: "Close pool" })).toHaveFocus();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(close).toHaveFocus());
  await user.keyboard("{Enter}");
  await user.click(screen.getByRole("button", { name: "Preview pool change" }));
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "Pool change preview" }),
    ).toHaveFocus(),
  );
  expect(api.previewPoolChange).toHaveBeenCalledWith({
    terms: {
      pool_id: pool.id,
      expected_version: 1,
      action: "close",
      course_project_id: pool.course_project_id,
      course_instance_id: pool.course_instance_id,
    },
  });
  await user.click(
    screen.getByRole("button", { name: "Request pool authorization" }),
  );
  expect(
    await screen.findByRole("link", {
      name: "Review pool change and authorize",
    }),
  ).toHaveAttribute("href", "https://approve.example.test/funding/intent");
  expect(api.proposePoolChange).toHaveBeenCalledTimes(1);
});

it("reports lookup failure rather than claiming there are no owned pools", async () => {
  const api = fixture();
  api.getOwnedPools.mockRejectedValue(Error("Payer bay offline"));
  render(<SponsoredBudgets api={api} />);
  expect(
    await screen.findByText("Sponsored budgets could not be loaded."),
  ).toBeVisible();
  expect(screen.queryByText("No sponsored budgets")).toBeNull();
  expect(screen.queryByRole("button", { name: "Close pool" })).toBeNull();
});
