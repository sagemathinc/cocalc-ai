import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  AgentMemoryButton,
  AgentMemoryPanel,
  agentMemorySummary,
} from "./agent-memory-settings";

const manageAgentMemory = jest.fn();
jest.mock("@cocalc/frontend/agents/api", () => ({
  personalAgentApi: () => ({ manageAgentMemory }),
}));

let state: any;
beforeEach(() => {
  state = { enabled: false, notes: [] as any[] };
  manageAgentMemory.mockReset();
  manageAgentMemory.mockImplementation(async (req: any) => {
    const status = {
      enabled: state.enabled,
      notes: state.notes.length,
      bytes: 100,
    };
    if (req.op === "status") return status;
    if (req.op === "list") return { ...status, notes_list: state.notes };
    if (req.op === "set-enabled") state.enabled = req.enabled;
    if (req.op === "delete")
      state.notes = state.notes.filter((n: any) => n.name !== req.name);
    if (req.op === "delete-all") state.notes = [];
    return {};
  });
});

test("memory is off by default and turning it on shows the disclosure first", async () => {
  render(<AgentMemoryPanel />);
  expect(await screen.findByText("Off")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Turn on…" }));
  expect(
    await screen.findByText(/Your memory follows you into every project/),
  ).toBeTruthy();
  expect(screen.getByText(/It goes where your agents go/)).toBeTruthy();
  expect(screen.getByText(/Never store secrets/)).toBeTruthy();
  expect(manageAgentMemory).not.toHaveBeenCalledWith(
    expect.objectContaining({ op: "set-enabled" }),
  );
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "I understand, turn it on" }),
    );
  });
  expect(manageAgentMemory).toHaveBeenCalledWith({
    op: "set-enabled",
    enabled: true,
  });
  expect(await screen.findByText("On")).toBeTruthy();
});

test("notes can be reviewed and deleted individually", async () => {
  state = {
    enabled: true,
    notes: [
      {
        name: "deploy",
        description: "How to deploy",
        body: "Use a terminal.",
        updated_at: "2026-10-01T00:00:00Z",
      },
    ],
  };
  render(<AgentMemoryPanel />);
  await screen.findByText("On");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Review notes" }));
  });
  expect(await screen.findByText("deploy")).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Delete note deploy" }));
  });
  expect(manageAgentMemory).toHaveBeenCalledWith({
    op: "delete",
    name: "deploy",
  });
});

test("the settings-modal button shows whether memory is on", async () => {
  expect(agentMemorySummary(undefined)).toBe("Memory");
  expect(agentMemorySummary({ enabled: false, notes: 3, bytes: 1 })).toBe(
    "Memory: off",
  );
  expect(agentMemorySummary({ enabled: true, notes: 1, bytes: 1 })).toBe(
    "Memory: on · 1 note",
  );
  state.enabled = true;
  state.notes = [{}, {}];
  render(<AgentMemoryButton />);
  expect(
    await screen.findByRole("button", { name: /Memory: on · 2 notes/ }),
  ).toBeTruthy();
});
