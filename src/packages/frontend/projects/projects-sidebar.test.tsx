/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fromJS } from "immutable";
import {
  focusProjectsFilter,
  ProjectsSidebar,
  sidebarProjects,
} from "./projects-sidebar";

const me = "11111111-1111-4111-8111-111111111111";
const openProject = jest.fn();
const setActiveTab = jest.fn();
const setProjectBookmarked = jest.fn();
let mockPins: string[] = [];
let mockCurrent = "p2";

const mockProjects = fromJS({
  p1: { title: "Alpha", last_active: { [me]: "2026-09-01" } },
  p2: {
    title: "Beta",
    last_active: { [me]: "2026-09-20" },
    state: { state: "running" },
  },
  p3: { title: "Gamma", last_edited: "2026-09-10" },
  p4: { title: "Hidden one", users: { [me]: { hide: true } } },
  p5: { title: "Gone", deleted: true },
});

jest.mock("@cocalc/frontend/app-framework", () => ({
  useActions: () => ({
    open_project: (...a) => openProject(...a),
    redux: { getActions: () => ({ set_active_tab: setActiveTab }) },
  }),
  useTypedRedux: (store: string, field: string) =>
    store === "projects"
      ? mockProjects
      : field === "account_id"
        ? me
        : mockCurrent,
}));
jest.mock("@cocalc/frontend/components", () => ({ Icon: () => null }));
jest.mock("./theme", () => ({ ProjectThemeAvatar: () => null }));
jest.mock("./use-bookmarked-projects", () => ({
  useBookmarkedProjects: () => ({
    bookmarkedProjects: mockPins,
    setProjectBookmarked: (...a) => setProjectBookmarked(...a),
    setBookmarkedProjectsOrder: jest.fn(),
  }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockPins = [];
  mockCurrent = "p2";
});

test("pins first in pin order; recent by my last use; hidden and deleted left out", () => {
  const { pinned, recent } = sidebarProjects({
    project_map: mockProjects,
    account_id: me,
    pins: ["p3", "p4"],
  });
  // A pinned project shows even if hidden.
  expect(pinned.map((p) => p.title)).toEqual(["Gamma", "Hidden one"]);
  expect(recent.map((p) => p.title)).toEqual(["Beta", "Alpha"]);
  expect(recent[0].running).toBe(true);
  expect(
    sidebarProjects({
      project_map: mockProjects,
      account_id: me,
      pins: [],
      search: "alp",
    }).recent.map((p) => p.title),
  ).toEqual(["Alpha"]);
});

it("opens projects, marks the current one, and pins", async () => {
  mockPins = ["p1"];
  const user = userEvent.setup();
  const onNavigate = jest.fn();
  render(<ProjectsSidebar onNavigate={onNavigate} />);
  const pinned = screen.getByRole("list", { name: "Pinned projects" });
  expect(
    within(pinned).getByRole("button", { name: "Open project Alpha" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Open project Beta" }),
  ).toHaveAttribute("aria-current", "page");
  await user.click(screen.getByRole("button", { name: "Open project Gamma" }));
  expect(openProject).toHaveBeenCalledWith({
    project_id: "p3",
    switch_to: true,
  });
  expect(onNavigate).toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Pin Gamma" }));
  expect(setProjectBookmarked).toHaveBeenCalledWith("p3", true);
  await user.click(screen.getByRole("button", { name: "Unpin Alpha" }));
  expect(setProjectBookmarked).toHaveBeenCalledWith("p1", false);
});

it("filters, and links to the full Projects page", async () => {
  const user = userEvent.setup();
  render(<ProjectsSidebar />);
  await user.type(
    screen.getByRole("searchbox", { name: "Filter projects" }),
    "gam",
  );
  expect(screen.getByText("Matches")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Open project Beta" }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: /All projects/ }));
  expect(setActiveTab).toHaveBeenCalledWith("projects");
});

it("the project switcher shortcut focuses the filter, even before it mounts", () => {
  focusProjectsFilter();
  render(<ProjectsSidebar />);
  expect(
    screen.getByRole("searchbox", { name: "Filter projects" }),
  ).toHaveFocus();
});

it("New Project goes to the Projects page and asks it to open the create dialog", async () => {
  const user = userEvent.setup();
  const opened = jest.fn();
  const { onNewProjectRequest } = jest.requireActual("./new-project-request");
  const stop = onNewProjectRequest(opened);
  render(<ProjectsSidebar />);
  await user.click(screen.getByRole("button", { name: "New Project" }));
  expect(setActiveTab).toHaveBeenCalledWith("projects");
  expect(opened).toHaveBeenCalledTimes(1);
  stop();
});
