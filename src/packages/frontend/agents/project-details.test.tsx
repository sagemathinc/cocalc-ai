import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ProjectDetails from "./project-details";
const close = jest.fn();
const navigate = jest.fn().mockResolvedValue(true);
const browse = jest.fn().mockResolvedValue(undefined);
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (_store, key) =>
    key === "project_map"
      ? { get: () => ({ getIn: () => "running" }) }
      : key === "account_id"
        ? "account"
        : undefined,
}));
jest.mock("@cocalc/frontend/project/context", () => ({
  ProjectContext: require("react").createContext({}),
  useProjectContextProvider: () => ({}),
}));
jest.mock("@cocalc/frontend/project/start-button", () => ({
  StartButton: () => null,
}));
jest.mock("@cocalc/frontend/project/settings/stop-project", () => ({
  StopProject: () => null,
}));
jest.mock("@cocalc/frontend/project/settings/sections", () => ({
  useProjectSettingsSections: () => ({
    sections: [
      {
        id: "control",
        title: "Project control",
        children: "Existing control component",
      },
    ],
  }),
}));
jest.mock("@cocalc/frontend/project/disk-usage/disk-usage", () => ({
  __esModule: true,
  default: () => <button>Inspect storage and free space</button>,
}));
jest.mock("@cocalc/frontend/project/disk-usage/use-disk-usage", () => ({
  __esModule: true,
  default: () => ({ quotas: [], loading: false }),
}));
jest.mock("@cocalc/frontend/project/settings/managed-egress", () => ({
  ManagedEgress: () => null,
}));
jest.mock("@cocalc/frontend/project/home-directory", () => ({
  getProjectHomeDirectory: () => "/home/user",
}));
jest.mock("@cocalc/frontend/project/browse-directory", () => ({
  browseProjectDirectory: (...args) => browse(...args),
}));
jest.mock("./api", () => ({
  useNamedAgents: () => ({
    directory: {
      agents: [
        {
          name: "helper",
          endpoint: { project_id: "p", agent_id: "a" },
          path: "a.chat",
          thread_id: "t",
        },
      ],
    },
  }),
}));
jest.mock("./agent-running-indicator", () => ({
  AgentRunningIndicator: ({ children }) => children,
}));
jest.mock("./open-notification", () => ({
  openAgentNotification: (...args) => navigate(...args),
}));
test("project agents are buttons; Browse leaves Agents; settings have one accordion level", async () => {
  render(
    <ProjectDetails
      agent={{ endpoint: { project_id: "p" } } as any}
      onClose={close}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "@helper" }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(navigate).toHaveBeenCalledWith("p", "a.chat", "t");
  fireEvent.click(screen.getByRole("button", { name: "Browse" }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(2));
  expect(browse).toHaveBeenCalledWith("p", "/home/user");
  expect(
    screen.getByRole("heading", { name: "Project settings" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Project settings" })).toBeNull();
  expect(screen.getByRole("button", { name: /Project control/ })).toBeTruthy();
});
