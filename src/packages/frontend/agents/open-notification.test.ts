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
    active_agent_id: "a",
    active_agent_name: "reviewer",
  });
  expect(setActiveTab).toHaveBeenCalledWith("agents");
});
test("preserves file navigation outside Agents and for unmatched threads", async () => {
  expect(await openAgentNotification("p", "a.chat", "other")).toBe(false);
  tab = "projects";
  expect(await openAgentNotification("p", "a.chat", "t")).toBe(false);
  expect(setState).not.toHaveBeenCalled();
});
