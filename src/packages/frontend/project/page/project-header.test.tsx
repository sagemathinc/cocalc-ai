/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Map } from "immutable";

const restartProject = jest.fn();
const stopProject = jest.fn();
const setActiveTab = jest.fn();
let mockState = "running";

jest.mock("@cocalc/frontend/app-framework", () => ({
  useProjectFromMap: () =>
    Map({ title: "Thesis", state: Map({ started_at: "t0" }) }),
  useTypedRedux: () => undefined,
  redux: {
    getActions: () => ({
      restart_project: (...a) => restartProject(...a),
      stop_project: (...a) => stopProject(...a),
    }),
    getProjectActions: () => ({ set_active_tab: (...a) => setActiveTab(...a) }),
  },
}));
jest.mock("./project-state-hook", () => ({
  useProjectState: () => Map({ state: mockState }),
}));
jest.mock("@cocalc/frontend/projects/project-status-display", () => ({
  ...jest.requireActual("@cocalc/frontend/projects/project-status-display"),
  useRestarting: () => false,
}));
jest.mock("@cocalc/frontend/project/start-button", () => ({
  StartButton: () => <button>Start</button>,
}));
let mockTheme: any = null;
jest.mock("@cocalc/frontend/projects/theme", () => ({
  ProjectThemeAvatar: () => <span data-testid="avatar" />,
  projectThemeFromProject: () => mockTheme,
}));
jest.mock("./project-version-update", () => ({
  ProjectUpdateIndicator: () => <span>Update</span>,
}));
jest.mock("@cocalc/frontend/components/icon", () => ({ Icon: () => null }));

import { ProjectPageHeader } from "./project-header";

beforeEach(() => {
  jest.clearAllMocks();
  mockState = "running";
  mockTheme = null;
});

test("says which project this is, whether it runs, and its update", async () => {
  render(<ProjectPageHeader project_id="p1" runtimeControls showUpdate />);
  expect(screen.getByRole("heading", { name: "Thesis" })).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Running");
  expect(screen.getByText("Update")).toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Project actions" }));
  await user.click(await screen.findByText("Restart project"));
  expect(restartProject).toHaveBeenCalledWith("p1");
  await user.click(screen.getByRole("button", { name: "Project settings" }));
  expect(setActiveTab).toHaveBeenCalledWith("settings");
});

test("viewers get no runtime controls and no update", async () => {
  mockState = "opened";
  render(<ProjectPageHeader project_id="p1" />);
  expect(screen.getByRole("status")).toHaveTextContent("Stopped");
  expect(screen.queryByText("Start")).toBeNull();
  expect(screen.queryByText("Update")).toBeNull();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Project actions" }));
  expect(await screen.findByText("Project settings")).toBeInTheDocument();
  expect(screen.queryByText("Restart project")).toBeNull();
});

test("the project's theme colors the header like an agent's", () => {
  // The accent color fills the header, with readable text.
  mockTheme = { color: "#123456", accent_color: "#0000ff" };
  const { rerender } = render(<ProjectPageHeader project_id="p1" />);
  const header = screen.getByRole("banner");
  expect(header).toHaveStyle({ background: "#0000ff" });
  expect(header).toHaveStyle({ boxShadow: "inset 0 3px 0 #123456" });
  // Only a main color: a pale tint of it.
  mockTheme = { color: "#123456" };
  rerender(<ProjectPageHeader project_id="p1" />);
  expect(screen.getByRole("banner").style.background).toContain("#123456");
});
