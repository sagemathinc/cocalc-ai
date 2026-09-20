import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import VmFundingStatus from "./compute-vm-funding-status";
import type { ComputeVmFundingStatus } from "@cocalc/util/compute-vm-funding";
import type { CourseFundingSourceSummary } from "@cocalc/conat/hub/api/compute-funding";
import { webapp_client } from "@cocalc/frontend/webapp-client";
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        computeFunding: {
          listSources: jest.fn().mockResolvedValue({ sources: [] }),
        },
      },
    },
  },
}));
const course = {
  grant_id: "grant",
  authorized_usd: "5",
  spent_usd: "0.03",
  released_usd: "0",
  reserved_usd: "1.54",
  running_vms: 1,
} as CourseFundingSourceSummary;

const now = Date.parse("2026-09-12T12:00:00Z");
const funding: ComputeVmFundingStatus = {
  source: { kind: "course", pool_id: "pool", grant_id: "grant" },
  label: "Course allowance",
  state: "running",
  spent_usd: "0.12",
  committed_usd: "0.9",
  protected_storage_usd: "0.2",
  egress_cap_usd: "0.25",
  authorized_until: "2026-09-12T12:15:00Z",
  stop_at: "2026-09-12T12:20:00Z",
  storage_delete_at: "2026-09-15T12:20:00Z",
  as_of: new Date(now).toISOString(),
};

beforeEach(() => {
  (
    webapp_client.conat_client.hub.computeFunding.listSources as jest.Mock
  ).mockResolvedValue({ sources: [] });
});

test("loads the grant balance rather than treating a VM reservation as the grant", async () => {
  (
    webapp_client.conat_client.hub.computeFunding.listSources as jest.Mock
  ).mockResolvedValue({ sources: [course] });
  render(<VmFundingStatus funding={funding} now={now} compact />);
  expect(await screen.findByText("$4.97 (of $5.00) remaining")).toBeVisible();
  expect(screen.getByText("$0.90 reserved")).toBeVisible();
});

test("shows resource funding deadlines and preserves the notebook distinction", () => {
  render(<VmFundingStatus funding={funding} now={now} />);
  expect(
    screen.getByRole("region", { name: "VM course funding" }),
  ).toBeTruthy();
  expect(screen.getByText("Runtime authorized until")).toBeTruthy();
  expect(screen.getByText("Storage deletion deadline")).toBeTruthy();
  expect(screen.getByText("$0.12")).toBeTruthy();
  expect(screen.queryByText("$1.02")).toBeNull();
  expect(
    screen.getByText(/not notebooks saved in your CoCalc project/),
  ).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("shows remaining course funding as visible progress", () => {
  render(
    <VmFundingStatus
      funding={funding}
      courseBudget={course}
      now={now}
      compact
    />,
  );
  expect(
    screen.getByRole("region", { name: "Course funding summary" }),
  ).toBeVisible();
  expect(screen.getByText("$4.97 (of $5.00) remaining")).toBeVisible();
  expect(
    screen.getByLabelText(
      "Course funding: credit used, $4.97 remaining of $5.00",
    ),
  ).toBeVisible();
  expect(screen.queryByText(/Funding stops this VM/)).toBeNull();
  expect(screen.getByText("$0.90 reserved")).toBeVisible();
});

test("explains reserves with a keyboard-accessible popover and fills the used-credit bar", async () => {
  const user = userEvent.setup();
  render(
    <VmFundingStatus
      funding={funding}
      courseBudget={{ ...course, spent_usd: "5" }}
      now={now}
      compact
    />,
  );
  expect(screen.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "100",
  );
  screen.getByRole("button", { name: "About reserved credit" }).focus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(
      screen.getByText(/not an additional charge or money already spent/),
    ).toBeVisible(),
  );
});

test("does not present stale funding as current", () => {
  render(<VmFundingStatus funding={funding} now={now + 60_000} />);
  expect(screen.getByRole("alert").textContent).toContain("out of date");
});

test("distinguishes unavailable commitments from settled zero", () => {
  const { rerender } = render(
    <VmFundingStatus
      funding={{ ...funding, state: "settling", committed_usd: undefined }}
      now={now}
    />,
  );
  expect(screen.getByText("Finalizing charges")).toBeTruthy();
  expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
  expect(screen.queryByText("$0.00")).toBeNull();
  rerender(
    <VmFundingStatus
      funding={{ ...funding, state: "closed", committed_usd: "0" }}
      now={now}
    />,
  );
  expect(screen.getByText("Settled")).toBeTruthy();
  expect(screen.getByText("$0.00")).toBeTruthy();
});

test("does not label personal VMs as sponsored", () => {
  const { container } = render(<VmFundingStatus />);
  expect(container.textContent).toBe("");
});

test("shows the authorized personal payer after handoff", () => {
  render(
    <VmFundingStatus
      funding={{
        ...funding,
        source: { kind: "personal", consent_id: "consent" },
        label: "My personal credit",
      }}
      now={now}
    />,
  );
  expect(
    screen.getByRole("region", { name: "VM personal funding" }),
  ).toBeTruthy();
  expect(screen.getByText("Maximum personal network charge")).toBeTruthy();
  expect(screen.queryByText("Maximum sponsored network charge")).toBeNull();
  expect(
    screen.getByText(/Charges use your approved personal limit/),
  ).toBeTruthy();
  expect(
    screen.getByText(/not notebooks saved in your CoCalc project/),
  ).toBeTruthy();
});

test("marks implausibly future observations unavailable", () => {
  render(
    <VmFundingStatus
      funding={{ ...funding, as_of: new Date(now + 60_000).toISOString() }}
      now={now}
    />,
  );
  expect(screen.getByRole("alert").textContent).toContain("out of date");
});
