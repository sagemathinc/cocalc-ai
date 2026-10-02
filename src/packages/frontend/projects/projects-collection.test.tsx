/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectsCollection, sortProjectRecords } from "./projects-collection";

const openProject = jest.fn();
const setProjectBookmarked = jest.fn();
const setBookmarkedProjectsOrder = jest.fn();
let mockBookmarks: string[] = [];

const record = (project_id: string, title: string, host = "host-1") => ({
  project_id,
  title,
  description: "",
  host,
  starred: false,
  hidden: false,
  collaborators: [],
  currentRole: "owner" as const,
});
const mockRecords = [
  record("p1", "Beta"),
  record("p2", "Alpha", "host-2"),
  record("p3", "Gamma"),
];

jest.mock("@cocalc/frontend/app-framework", () => ({
  useActions: () => ({
    open_project: (...a) => openProject(...a),
    toggle_expanded_project: jest.fn(),
  }),
}));
jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  TimeAgo: () => null,
}));
jest.mock("@cocalc/frontend/i18n", () => ({
  labels: {
    project: { defaultMessage: "Project" },
    projects: { defaultMessage: "Projects" },
  },
}));
jest.mock("react-intl", () => ({
  ...jest.requireActual("react-intl"),
  useIntl: () => ({ formatMessage: (m) => m.defaultMessage }),
}));
jest.mock("./collaborators-avatars", () => ({
  CollaboratorsAvatars: () => null,
}));
jest.mock("./project-rootfs-badge", () => ({
  ProjectRootfsBadge: () => null,
  ProjectRootfsRuntimeModal: () => null,
}));
jest.mock("./projects-actions-menu", () => ({
  ProjectActionsMenu: () => <button type="button">Project actions</button>,
}));
jest.mock("./theme", () => ({ ProjectThemeAvatar: () => null }));
jest.mock("./projects-table-columns", () => ({
  getStateIcon: () => undefined,
  projectDescriptionText: (d) => d ?? "",
  projectRoleTag: () => null,
}));
jest.mock("./use-project-table-records", () => ({
  useProjectTableRecords: () => mockRecords,
}));
jest.mock("./use-bookmarked-projects", () => ({
  useBookmarkedProjects: () => ({
    bookmarkedProjects: mockBookmarks,
    setProjectBookmarked: (...a) => setProjectBookmarked(...a),
    setBookmarkedProjectsOrder: (...a) => setBookmarkedProjectsOrder(...a),
  }),
}));

function view(extra = {}) {
  const props = {
    visible_projects: ["p1", "p2", "p3"],
    rootfsImages: [],
    selectedProjectIds: [] as string[],
    onSelectedProjectIdsChange: jest.fn(),
    view: "list" as const,
    onViewChange: jest.fn(),
    ...extra,
  };
  render(<ProjectsCollection {...props} />);
  return props;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockBookmarks = [];
});

it("starred projects form the Pinned section, in star order", () => {
  mockBookmarks = ["p3", "p1"];
  view();
  const pinned = screen.getByRole("region", { name: "Pinned" });
  expect(
    within(pinned)
      .getAllByRole("button", { name: /^Open project/ })
      .map((b) => b.getAttribute("aria-label")),
  ).toEqual(["Open project Gamma", "Open project Beta"]);
  expect(
    within(screen.getByRole("region", { name: "Projects" })).getByRole(
      "button",
      { name: "Open project Alpha" },
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Drag Gamma to reorder" }),
  ).toBeInTheDocument();
});

it("pinning stars the project; opening and selecting work", async () => {
  const user = userEvent.setup();
  const props = view();
  await user.click(screen.getByRole("button", { name: "Pin Alpha" }));
  expect(setProjectBookmarked).toHaveBeenCalledWith("p2", true);
  await user.click(screen.getByRole("button", { name: "Open project Alpha" }));
  expect(openProject).toHaveBeenCalledTimes(1);
  expect(openProject).toHaveBeenCalledWith(
    expect.objectContaining({ project_id: "p2", switch_to: true }),
  );
  await user.click(
    screen.getByRole("checkbox", { name: "Select project Beta" }),
  );
  expect(props.onSelectedProjectIdsChange).toHaveBeenCalledWith(["p1"]);
  await user.click(
    screen.getByRole("checkbox", { name: "Select all projects" }),
  );
  expect(props.onSelectedProjectIdsChange).toHaveBeenLastCalledWith([
    "p1",
    "p2",
    "p3",
  ]);
});

it("can group by host", async () => {
  const user = userEvent.setup();
  view();
  await user.click(screen.getByRole("combobox", { name: "Group projects" }));
  await user.click(await screen.findByText("By host"));
  expect(
    screen.getByRole("region", { name: "Projects: host-2" }),
  ).toBeInTheDocument();
});

test("sorting by title or host; last edited keeps the given order", () => {
  expect(
    sortProjectRecords(mockRecords as any, "title").map((r) => r.title),
  ).toEqual(["Alpha", "Beta", "Gamma"]);
  expect(
    sortProjectRecords(mockRecords as any, "host").map((r) => r.project_id),
  ).toEqual(["p1", "p3", "p2"]);
  expect(sortProjectRecords(mockRecords as any, "last_edited")).toBe(
    mockRecords,
  );
});
