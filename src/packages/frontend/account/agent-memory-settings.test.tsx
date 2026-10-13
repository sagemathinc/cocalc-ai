import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { fromJS } from "immutable";
import {
  AgentMemoryButton,
  AgentMemoryPanel,
  agentMemorySummary,
} from "./agent-memory-settings";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";

const manageAgentMemory = jest.fn();
jest.mock("@cocalc/frontend/agents/api", () => ({
  personalAgentApi: () => ({ manageAgentMemory }),
}));
const mockProjects = fromJS({
  [P1]: { title: "CoCalc dev" },
  [P2]: { title: "Sagebrush" },
});
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => mockProjects,
  useAccountOtherSetting: () => undefined,
}));

let state: any;
beforeEach(() => {
  state = {
    enabled: false,
    notes: [] as any[],
    namespaces: [] as any[],
    projects: {} as Record<string, string[]>,
  };
  manageAgentMemory.mockReset();
  manageAgentMemory.mockImplementation(async (req: any) => {
    const status = {
      enabled: state.enabled,
      notes: state.notes.length,
      bytes: 100,
      global_notes: state.notes.filter((n: any) => n.namespace === "global")
        .length,
      namespaces: state.namespaces.map((ns: any) => ({
        ...ns,
        notes: state.notes.filter((n: any) => n.namespace === ns.name).length,
      })),
      projects: state.projects,
    };
    switch (req.op) {
      case "status":
        return status;
      case "list":
        return { notes_list: state.notes };
      case "read":
        return state.notes.find(
          (n: any) => n.namespace === req.namespace && n.name === req.name,
        );
      case "set-enabled":
        state.enabled = req.enabled;
        return {};
      case "delete":
        state.notes = state.notes.filter(
          (n: any) => !(n.namespace === req.namespace && n.name === req.name),
        );
        return {};
      case "delete-all":
        state.notes = [];
        return {};
      case "export":
        return { notes: state.notes.length, markdown: "# Agent memory\n" };
      case "namespace-save":
        state.namespaces.push({ name: req.name, description: req.description });
        return {};
      case "set-project-namespaces":
        state.projects[req.project_id] = req.namespaces;
        return {};
      case "move":
        for (const n of state.notes)
          if (n.namespace === req.namespace && n.name === req.name)
            n.namespace = req.to;
        return {};
    }
    return {};
  });
});

const note = (namespace: string, name: string, extra: any = {}) => ({
  namespace,
  name,
  description: `About ${name}`,
  body: `The ${name} note.`,
  updated_at: new Date().toISOString(),
  bytes: 10,
  ...extra,
});

test("memory is off by default and turning it on shows the disclosure first", async () => {
  render(<AgentMemoryPanel />);
  expect(await screen.findByText("Off")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Turn on…" }));
  expect(
    await screen.findByText(/Global notes follow you into every project/),
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

test("notes are reviewed by namespace, filtered, moved and deleted", async () => {
  state.enabled = true;
  state.namespaces = [{ name: "dev", description: "CoCalc development" }];
  state.notes = [
    note("global", "prefs"),
    note("dev", "deploy", { updated_at: "2026-01-01T00:00:00Z" }),
  ];
  render(<AgentMemoryPanel />);
  await screen.findByText("On");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Review notes" }));
  });
  expect(await screen.findByText("Global (every project)")).toBeTruthy();
  expect(screen.getByText("deploy")).toBeTruthy();
  // Not read or changed for months.
  expect(screen.getByText("unused")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Filter notes"), {
    target: { value: "deploy" },
  });
  expect(screen.queryByText("prefs")).toBeNull();
  // Expanding a note loads its text.
  await act(async () => {
    fireEvent.click(screen.getByText("deploy"));
  });
  expect(await screen.findByText("The deploy note.")).toBeTruthy();
  expect(manageAgentMemory).toHaveBeenCalledWith({
    op: "read",
    namespace: "dev",
    name: "deploy",
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Delete note deploy" }));
  });
  expect(manageAgentMemory).toHaveBeenCalledWith({
    op: "delete",
    namespace: "dev",
    name: "deploy",
  });
});

test("export downloads every note as one Markdown file", async () => {
  state.enabled = true;
  state.notes = [note("global", "prefs")];
  const createObjectURL = jest.fn(() => "blob:x");
  const revokeObjectURL = jest.fn();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  const click = jest
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  render(<AgentMemoryPanel />);
  await screen.findByText("On");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Export/ }));
  });
  expect(manageAgentMemory).toHaveBeenCalledWith({ op: "export" });
  expect(createObjectURL).toHaveBeenCalled();
  expect(click).toHaveBeenCalled();
  click.mockRestore();
});

test("namespaces have a name and optional description, and choose their projects", async () => {
  state.enabled = true;
  render(<AgentMemoryPanel />);
  await screen.findByText("On");
  fireEvent.click(screen.getByText(/^Namespaces/));
  fireEvent.change(await screen.findByLabelText("New namespace name"), {
    target: { value: "Dev" },
  });
  fireEvent.change(screen.getByLabelText("New namespace description"), {
    target: { value: "CoCalc development" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Add namespace" }));
  });
  expect(manageAgentMemory).toHaveBeenCalledWith({
    op: "namespace-save",
    name: "dev",
    description: "CoCalc development",
  });
  // Attach a project: pick it from the namespace's project list.
  const select = await screen.findByLabelText("Projects that see dev");
  await act(async () => {
    fireEvent.mouseDown(select);
  });
  await act(async () => {
    fireEvent.click(await screen.findByText("CoCalc dev"));
  });
  expect(manageAgentMemory).toHaveBeenCalledWith({
    op: "set-project-namespaces",
    project_id: P1,
    namespaces: ["dev"],
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
  state.notes = [note("global", "a"), note("global", "b")];
  render(<AgentMemoryButton />);
  expect(
    await screen.findByRole("button", { name: /Memory: on · 2 notes/ }),
  ).toBeTruthy();
});

test("offers a reset when saved memory cannot be read", async () => {
  manageAgentMemory.mockImplementation(async (req: any) => {
    if (req.op === "status")
      throw new Error("stored agent memory is malformed");
    return {};
  });
  render(<AgentMemoryPanel />);
  expect(
    await screen.findByText(/stored agent memory is malformed/),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Reset memory" }));
  const dialog = (await screen.findAllByRole("dialog")).at(-1)!;
  expect(
    within(dialog).getAllByText("Reset agent memory?").length,
  ).toBeGreaterThan(0);
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset" }));
  });
  expect(manageAgentMemory).toHaveBeenCalledWith({ op: "delete-all" });
});
