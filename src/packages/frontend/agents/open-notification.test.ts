import { openAgentNotification } from "./open-notification";

let tab = "agents";
const setState = jest.fn();
const setActiveTab = jest.fn();
const listNamedAgents = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: () => ({ get: () => tab }),
    getActions: () => ({ setState, set_active_tab: setActiveTab }),
  },
}));
jest.mock("./api", () => ({ personalAgentApi: () => ({ listNamedAgents }) }));
beforeEach(() => {
  jest.clearAllMocks();
  tab = "agents";
  listNamedAgents.mockResolvedValue({
    agents: [
      {
        name: "reviewer",
        endpoint: { project_id: "p", agent_id: "a" },
        path: "a.chat",
        thread_id: "t",
      },
    ],
  });
});
test("opens the named agent without navigating to its project file", async () => {
  expect(await openAgentNotification("p", "a.chat", "t")).toBe(true);
  expect(setState).toHaveBeenCalledWith({
    library_open: false,
    library_project_id: undefined,
    library_entry_id: undefined,
    active_agent_id: "a",
    active_agent_name: "reviewer",
  });
  expect(setActiveTab).toHaveBeenCalledWith("agents");
});
test.each(["a", "another-agent"])(
  "exits Library when a notification selects an agent (previous=%s)",
  async (previousAgent) => {
    const state = {
      library_open: true,
      library_project_id: "p" as string | undefined,
      library_entry_id: "entry" as string | undefined,
      active_agent_id: previousAgent,
    };
    setState.mockImplementationOnce((update) => Object.assign(state, update));
    expect(await openAgentNotification("p", "a.chat", "t")).toBe(true);
    expect(state.library_open).toBe(false);
    expect(state.library_project_id).toBeUndefined();
    expect(state.library_entry_id).toBeUndefined();
    expect(state.active_agent_id).toBe("a");
    expect(setState.mock.invocationCallOrder[0]).toBeLessThan(
      setActiveTab.mock.invocationCallOrder[0],
    );
  },
);
test("preserves file navigation outside Agents and for unmatched threads", async () => {
  expect(await openAgentNotification("p", "a.chat", "other")).toBe(false);
  tab = "projects";
  expect(await openAgentNotification("p", "a.chat", "t")).toBe(false);
  expect(setState).not.toHaveBeenCalled();
});
