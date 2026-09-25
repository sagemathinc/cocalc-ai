import { fireEvent, render, screen, within } from "@testing-library/react";
import CourseCreditSummary from "./course-credit-summary";

jest.mock("@cocalc/frontend/webapp-client", () => ({ webapp_client: {} }));

it("separates committed funds from credit available for another VM", async () => {
  render(
    <CourseCreditSummary
      api={{
        listSources: async () => ({
          as_of: new Date().toISOString(),
          sources: [
            {
              pool_id: "pool",
              grant_id: "grant",
              payer_account_id: "payer",
              label: "Manchester",
              lane: "prepaid",
              authorized_usd: "50",
              spent_usd: "10",
              reserved_usd: "12",
              released_usd: "3",
              starts_at: "2026-01-01T00:00:00Z",
              ends_at: "2030-01-01T00:00:00Z",
              state: "active",
              pool_state: "active",
              available_for_new_resources: true,
              available_usd: "5",
            },
          ],
        }),
      }}
    />,
  );
  expect(
    await screen.findByRole("region", { name: "Your course credit" }),
  ).toBeVisible();
  const summary = within(
    screen.getByRole("article", { name: "Manchester course credit" }),
  );
  expect(summary.getByText("$5.00 available to start")).toBeVisible();
  expect(summary.getByText("$10.00 spent; $12.00 committed")).toBeVisible();
  expect(summary.queryByText("$25.00 available to start")).toBeNull();
  expect(screen.queryByRole("table")).toBeNull();
  const toggle = summary.getByText("Budget details");
  const details = toggle.closest("details")!;
  expect(details).not.toHaveAttribute("open");
  fireEvent.click(toggle);
  expect(details).toHaveAttribute("open");
  expect(summary.getByText("Estimated compute limit")).toBeVisible();
  expect(summary.getByText("$50.00")).toBeVisible();
  fireEvent.click(toggle);
  expect(details).not.toHaveAttribute("open");
});

it("requests history and keeps closed pool credit visible but unavailable", async () => {
  const listSources = jest.fn().mockResolvedValue({
    as_of: new Date().toISOString(),
    sources: [
      {
        pool_id: "p",
        grant_id: "g",
        payer_account_id: "payer",
        label: "Finished course",
        lane: "prepaid",
        state: "revoked",
        pool_state: "closed",
        available_for_new_resources: false,
        authorized_usd: "50",
        spent_usd: "10",
        reserved_usd: "0",
        released_usd: "40",
        starts_at: "2026-01-01T00:00:00Z",
        ends_at: "2030-01-01T00:00:00Z",
      },
    ],
  });
  render(<CourseCreditSummary api={{ listSources }} />);
  expect(await screen.findByText("Unavailable to start")).toBeVisible();
  fireEvent.click(screen.getByText("Budget details"));
  expect(screen.getByText("closed")).toBeVisible();
  expect(listSources).toHaveBeenCalledWith({ include_inactive: true });
});

it("does not present a stale source snapshot as spendable credit", async () => {
  render(
    <CourseCreditSummary
      api={{
        listSources: async () => ({
          as_of: new Date(Date.now() - 60_000).toISOString(),
          sources: [
            {
              pool_id: "p",
              grant_id: "g",
              payer_account_id: "payer",
              label: "Stale course",
              lane: "prepaid",
              state: "active",
              pool_state: "active",
              available_for_new_resources: true,
              available_usd: "50",
              authorized_usd: "50",
              spent_usd: "0",
              reserved_usd: "0",
              released_usd: "0",
              starts_at: "2026-01-01T00:00:00Z",
              ends_at: "2030-01-01T00:00:00Z",
            },
          ],
        }),
      }}
    />,
  );
  expect(await screen.findByText("Unavailable to start")).toBeVisible();
  expect(screen.queryByText("$50.00 available to start")).toBeNull();
  expect(screen.getByText(/out of date/)).toBeVisible();
});

it("does not report zero funds when lookup fails", async () => {
  render(
    <CourseCreditSummary
      api={{
        listSources: async () => {
          throw new Error("Unavailable");
        },
      }}
    />,
  );
  expect(
    await screen.findByText("Course credit is unavailable."),
  ).toBeVisible();
  expect(screen.queryByRole("table")).toBeNull();
});
