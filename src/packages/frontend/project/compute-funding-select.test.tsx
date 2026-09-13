import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ComputeFundingSelect from "./compute-funding-select";

jest.mock("@cocalc/frontend/webapp-client", () => ({ webapp_client: {} }));

const source = {
  pool_id: "pool",
  grant_id: "grant",
  payer_account_id: "payer",
  label: "Manchester course credit",
  lane: "prepaid" as const,
  authorized_usd: "50",
  spent_usd: "10",
  reserved_usd: "3",
  released_usd: "0",
  starts_at: "2026-01-01T00:00:00Z",
  ends_at: "2030-01-01T00:00:00Z",
  state: "active" as const,
  pool_state: "active" as const,
  available_for_new_resources: true,
  available_usd: "5",
};

it("selects a named course source by keyboard without altering its payer", async () => {
  const user = userEvent.setup();
  const onChange = jest.fn();
  const onLaneChange = jest.fn();
  render(
    <ComputeFundingSelect
      api={{
        listSources: async () => ({
          as_of: new Date().toISOString(),
          sources: [source],
        }),
      }}
      onChange={onChange}
      onLaneChange={onLaneChange}
    />,
  );
  const select = screen.getByRole("combobox", { name: "Course funding" });
  await waitFor(() =>
    expect(select.closest(".ant-select")).not.toHaveClass("ant-select-loading"),
  );
  await user.tab();
  expect(select).toHaveFocus();
  fireEvent.keyDown(select, { key: "ArrowDown", keyCode: 40, which: 40 });
  await screen.findAllByText(/Manchester course credit/);
  expect(
    screen.getAllByText(/\$5.00 available to start/).length,
  ).toBeGreaterThan(0);
  expect(screen.queryByText(/\$37.00 available to start/)).toBeNull();
  fireEvent.keyDown(select, { key: "ArrowDown", keyCode: 40, which: 40 });
  fireEvent.keyDown(select, { key: "Enter", keyCode: 13, which: 13 });
  expect(onChange).toHaveBeenCalledWith({
    kind: "course",
    pool_id: "pool",
    grant_id: "grant",
    payer_account_id: "payer",
  });
  expect(onLaneChange).toHaveBeenCalledWith("account-prepaid");
});

it("blocks stale selected sources without silently switching to personal credit", async () => {
  const onChange = jest.fn();
  const onUnavailable = jest.fn();
  render(
    <ComputeFundingSelect
      value={{ kind: "course", pool_id: "pool", grant_id: "grant" }}
      api={{
        listSources: async () => {
          throw new Error("Payer bay unavailable");
        },
      }}
      onChange={onChange}
      onUnavailable={onUnavailable}
    />,
  );
  expect(
    await screen.findByText("Course funding could not be loaded."),
  ).toBeVisible();
  expect(onUnavailable).toHaveBeenLastCalledWith(true);
  expect(onChange).not.toHaveBeenCalled();
});

it("shows reserved and spent amounts separately", async () => {
  render(
    <ComputeFundingSelect
      value={{ kind: "course", pool_id: "pool", grant_id: "grant" }}
      api={{
        listSources: async () => ({
          as_of: new Date().toISOString(),
          sources: [source],
        }),
      }}
    />,
  );
  expect(await screen.findByText(/Spent.*10.*reserved.*3/)).toBeVisible();
});

it.each([
  {
    ...source,
    pool_state: "closed" as const,
    available_for_new_resources: false,
  },
  { ...source, available_for_new_resources: false },
  { ...source, state: "expired" as const },
  { ...source, starts_at: "2099-01-01T00:00:00Z" },
  { ...source, ends_at: "2020-01-01T00:00:00Z" },
  { ...source, available_usd: "0" },
])(
  "does not offer an inactive or fully committed allowance",
  async (unusable) => {
    const onUnavailable = jest.fn();
    const onChange = jest.fn();
    render(
      <ComputeFundingSelect
        value={{ kind: "course", pool_id: "pool", grant_id: "grant" }}
        api={{
          listSources: async () => ({
            as_of: new Date().toISOString(),
            sources: [unusable],
          }),
        }}
        onUnavailable={onUnavailable}
        onChange={onChange}
      />,
    );
    await screen.findByText(/Spent.*10/);
    expect(onUnavailable).toHaveBeenLastCalledWith(true);
    expect(onChange).not.toHaveBeenCalled();
  },
);

it.each(["invalid", "2099-01-01T00:00:00Z", "2020-01-01T00:00:00Z"])(
  "rejects a funding response with an unusable freshness timestamp: %s",
  async (as_of) => {
    const onUnavailable = jest.fn();
    render(
      <ComputeFundingSelect
        value={{ kind: "course", pool_id: "pool", grant_id: "grant" }}
        api={{
          listSources: async () => ({ as_of, sources: [source] }),
        }}
        onUnavailable={onUnavailable}
      />,
    );
    await screen.findByText(/Spent.*10/);
    expect(onUnavailable).toHaveBeenLastCalledWith(true);
  },
);
