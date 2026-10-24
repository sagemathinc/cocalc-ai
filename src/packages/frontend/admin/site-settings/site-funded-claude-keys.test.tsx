/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SiteFundedClaudeKeysCard from "./site-funded-claude-keys";

const getKeys = jest.fn();
const manageKeys = jest.fn();

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    browser_id: "browser-1",
    conat_client: {
      hub: {
        system: {
          getSiteFundedClaudeKeys: (...args) => getKeys(...args),
          manageSiteFundedClaudeKeys: (...args) => manageKeys(...args),
        },
      },
    },
  },
}));

const key = (label: string, keyId: string, exposureMicrousd = 0) => ({
  keyId,
  provider: "anthropic",
  label,
  last4: "6789",
  monthlyLimitMicrousd: 100_000_000,
  resetDay: 15,
  resetHour: 8,
  position: 0,
  enabled: true,
  periodStart: "2026-10-15T08:00:00.000Z",
  periodEnd: "2026-11-15T08:00:00.000Z",
  exposureMicrousd,
});

beforeEach(() => {
  getKeys.mockReset();
  manageKeys.mockReset();
});

describe("SiteFundedClaudeKeysCard", () => {
  it("lists keys in order with this month's spend and reset point", async () => {
    getKeys.mockResolvedValue([
      key("Workspace A", "a", 25_000_000),
      key("Workspace B", "b"),
    ]);
    render(<SiteFundedClaudeKeysCard />);
    expect(await screen.findByText("Workspace A")).toBeTruthy();
    expect(
      screen.getByText("$25.00 of $100.00", { exact: false }),
    ).toBeTruthy();
    expect(screen.getAllByText("Day 15, 08:00 UTC")).toHaveLength(2);
    // Never the secret: only its last four characters.
    expect(screen.getAllByText("…6789")).toHaveLength(2);
  });

  it("moves a key down by sending the whole new order", async () => {
    getKeys.mockResolvedValue([
      key("Workspace A", "a"),
      key("Workspace B", "b"),
    ]);
    manageKeys.mockResolvedValue([
      key("Workspace B", "b"),
      key("Workspace A", "a"),
    ]);
    render(<SiteFundedClaudeKeysCard />);
    await screen.findByText("Workspace A");
    fireEvent.click(screen.getAllByRole("button", { name: "Move down" })[0]);
    await waitFor(() =>
      expect(manageKeys).toHaveBeenCalledWith({
        action: { op: "reorder", keyIds: ["b", "a"] },
        browser_id: "browser-1",
      }),
    );
  });

  it("adds a key with its limit and reset point", async () => {
    getKeys.mockResolvedValue([]);
    manageKeys.mockResolvedValue([key("New", "n")]);
    render(<SiteFundedClaudeKeysCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Add key" }));
    fireEvent.change(screen.getByLabelText("Label"), {
      target: { value: "New" },
    });
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "sk-ant-test-0123456789" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Add key" }).at(-1)!);
    await waitFor(() =>
      expect(manageKeys).toHaveBeenCalledWith({
        action: {
          op: "add",
          label: "New",
          apiKey: "sk-ant-test-0123456789",
          monthlyLimitUsd: 100,
          resetDay: 1,
          resetHour: 0,
        },
        browser_id: "browser-1",
      }),
    );
  });
});
