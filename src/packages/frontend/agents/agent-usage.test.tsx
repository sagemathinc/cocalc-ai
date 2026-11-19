/** @jest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  AgentUsageButton,
  AgentUsageModal,
  agentUsageLabel,
  agentUsageTotals,
  compactTokens,
} from "./agent-usage";

const mockAgentUsage = jest.fn();
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: { agent: { agentUsage: (...args) => mockAgentUsage(...args) } },
    },
  },
}));
const mockLite = { lite: false };
jest.mock("@cocalc/frontend/lite", () => ({
  get lite() {
    return mockLite.lite;
  },
}));

beforeEach(() => {
  mockLite.lite = false;
  mockAgentUsage.mockReset();
});

const row = (over: Record<string, unknown> = {}) => ({
  project_id: "00000000-0000-4000-8000-000000000001",
  path_hash: "a".repeat(64),
  thread_id: "3f2a9c1d-aaaa-bbbb-cccc-000000000000",
  provider: "claude" as const,
  model: "claude-opus-5-5",
  turns: 3,
  input_tokens: 1200,
  cached_input_tokens: 2_500_000,
  cache_write_tokens: 40_000,
  output_tokens: 61_000,
  last_at: "2026-11-19T18:00:00.000Z",
  ...over,
});

test("compact token counts", () => {
  expect(compactTokens(999)).toBe("999");
  expect(compactTokens(1234)).toBe("1.2k");
  expect(compactTokens(61_000)).toBe("61k");
  expect(compactTokens(2_500_000)).toBe("2.5M");
  expect(compactTokens(12_000_000)).toBe("12M");
  expect(compactTokens(3_100_000_000)).toBe("3.1B");
});

test("rows are labeled by agent name, else by conversation", () => {
  expect(agentUsageLabel(row({ name: "reviewer" }) as any)).toBe("@reviewer");
  expect(agentUsageLabel(row() as any)).toBe("Conversation 3f2a9c1d");
});

test("totals by provider", () => {
  const totals = agentUsageTotals([
    row() as any,
    row({ model: "claude-haiku-5-5", output_tokens: 1000 }) as any,
    row({ provider: "codex", model: "gpt-6.1-sol", output_tokens: 5 }) as any,
  ]);
  expect(totals.get("claude")?.output).toBe(62_000);
  expect(totals.get("codex")?.output).toBe(5);
});

test("the dialog loads each period and shows the agents, busiest first", async () => {
  const load = jest.fn(async (hours: number) => ({
    since: "2026-11-18T18:00:00.000Z",
    hours,
    rows:
      hours === 24
        ? [
            row({ name: "reviewer" }),
            row({ model: "claude-haiku-5-5", output_tokens: 7 }),
          ]
        : [],
  }));
  render(<AgentUsageModal open onClose={jest.fn()} load={load as any} />);
  await waitFor(() => expect(screen.getByText("@reviewer")).toBeTruthy());
  expect(load).toHaveBeenCalledWith(24);
  expect(screen.getByText("Conversation 3f2a9c1d")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toMatch(
    /Claude: 61k output and 5\.1M input tokens\./,
  );
  await userEvent.click(screen.getByText("7 days"));
  await waitFor(() => expect(load).toHaveBeenCalledWith(168));
  await waitFor(() =>
    expect(
      screen.getByText("No agent turns recorded in this period."),
    ).toBeTruthy(),
  );
});

test("a failed load says so", async () => {
  render(
    <AgentUsageModal
      open
      onClose={jest.fn()}
      load={async () => {
        throw Error("home bay unreachable");
      }}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toMatch(
      /Could not load usage: Error: home bay unreachable/,
    ),
  );
});

test("a failed period change does not leave the previous period's rows", async () => {
  const load = jest.fn(async (hours: number) => {
    if (hours === 168) throw Error("timeout");
    return {
      since: "2026-11-18T18:00:00.000Z",
      hours,
      rows: [row({ name: "reviewer" })],
    };
  });
  render(<AgentUsageModal open onClose={jest.fn()} load={load as any} />);
  await waitFor(() => expect(screen.getByText("@reviewer")).toBeTruthy());
  await userEvent.click(screen.getByText("7 days"));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toMatch(/timeout/),
  );
  expect(screen.queryByText("@reviewer")).toBeNull();
  expect(screen.queryByRole("status")).toBeNull();
});

test("rows differing only by chat path or provider are distinct rows", async () => {
  const errors = jest.spyOn(console, "error");
  const load = async (hours: number) => ({
    since: "2026-11-18T18:00:00.000Z",
    hours,
    rows: [
      row({ name: "reviewer" }),
      row({ name: "copycat", path_hash: "b".repeat(64) }),
      // After a runtime switch, one conversation can have an "unknown" model
      // under each provider.
      row({ model: "unknown", output_tokens: 3 }),
      row({ provider: "codex", model: "unknown", output_tokens: 2 }),
    ],
  });
  render(<AgentUsageModal open onClose={jest.fn()} load={load as any} />);
  await waitFor(() => expect(screen.getByText("@copycat")).toBeTruthy());
  expect(screen.getByText("@reviewer")).toBeTruthy();
  expect(screen.getAllByText("unknown")).toHaveLength(2);
  // Each row has its own key (React warns about duplicates).
  expect(
    errors.mock.calls.filter((args) => /same key/.test(args.join(" "))),
  ).toEqual([]);
  errors.mockRestore();
});

test("the button opens the dialog by keyboard; Escape closes it and focus returns", async () => {
  const user = userEvent.setup();
  mockAgentUsage.mockResolvedValue({
    since: "2026-11-18T18:00:00.000Z",
    hours: 24,
    rows: [row({ name: "reviewer" })],
  });
  render(<AgentUsageButton />);
  const button = screen.getByRole("button", { name: "Usage by agent" });
  button.focus();
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toMatch(/Usage by agent/);
  await waitFor(() => expect(screen.getByText("@reviewer")).toBeTruthy());
  expect(mockAgentUsage).toHaveBeenCalledWith({ hours: 24 });
  // Focus is inside the dialog (on the period control) when Escape closes it.
  const period = screen.getByRole("radio", { name: "7 days" });
  period.focus();
  expect(dialog.contains(document.activeElement)).toBe(true);
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(
      screen
        .queryAllByRole("dialog")
        .filter((d) => /Usage by agent/.test(d.textContent ?? "")),
    ).toEqual([]),
  );
  expect(document.activeElement).toBe(button);
});

test("CoCalc Plus has no usage button", () => {
  mockLite.lite = true;
  render(<AgentUsageButton />);
  expect(screen.queryByRole("button", { name: "Usage by agent" })).toBeNull();
});
