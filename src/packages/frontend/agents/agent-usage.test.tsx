/** @jest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  AgentUsageModal,
  agentUsageLabel,
  agentUsageTotals,
  compactTokens,
} from "./agent-usage";

jest.mock("@cocalc/frontend/webapp-client", () => ({ webapp_client: {} }));
jest.mock("@cocalc/frontend/lite", () => ({ lite: false }));

const row = (over: Record<string, unknown> = {}) => ({
  project_id: "00000000-0000-4000-8000-000000000001",
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
