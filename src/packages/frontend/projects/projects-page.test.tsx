/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { Map as ImmutableMap, Set as ImmutableSet } from "immutable";

import { ProjectsPage } from "./projects-page";

const useTypedReduxMock = jest.fn();
const mockEmptyMap = ImmutableMap();
const mockVisibleProjects: string[] = [];
const mockScheduledDeleteProjectIds: string[] = [];
let mockProjectListWindow: any;
let mockHidden = false;
let mockSearch = "";
let mockSelectedHashtags: any = mockEmptyMap;
const mockLoadProjectListWindow = jest.fn();

jest.mock("./actions", () => ({}));

jest.mock("antd", () => {
  const React = require("react");
  const Layout = ({ children, ...props }: any) => (
    <div {...props}>{children}</div>
  );
  Layout.Content = ({ children, ...props }: any) => (
    <main {...props}>{children}</main>
  );
  return {
    Button: React.forwardRef(({ children, icon, ...props }: any, ref: any) => (
      <button ref={ref} type="button" {...props}>
        {icon}
        {children}
      </button>
    )),
    Col: ({ children }: any) => <div>{children}</div>,
    Grid: { useBreakpoint: () => ({ lg: true }) },
    Layout,
    Row: ({ children }: any) => <div>{children}</div>,
    Space: ({ children }: any) => <div>{children}</div>,
  };
});

jest.mock("react-intl", () => ({
  useIntl: () => ({
    formatMessage: (message: any) =>
      message?.defaultMessage ?? message?.id ?? "",
  }),
}));

jest.mock("@cocalc/frontend/app-framework", () => {
  const React = require("react");
  return {
    React,
    redux: {
      getActions: (name: string) => {
        if (name === "projects")
          return {
            ensure_host_info: jest.fn(),
            loadProjectListWindowForCurrentAccount: mockLoadProjectListWindow,
          };
        if (name === "mentions") return { set_filter: jest.fn() };
        if (name === "page") return { set_active_tab: jest.fn() };
        return {};
      },
      getStore: () => ({ get_user_type: () => "signed_in" }),
    },
    useEffect: React.useEffect,
    useMemo: React.useMemo,
    useState: React.useState,
    useTypedRedux: (...args: unknown[]) => useTypedReduxMock(...args),
  };
});

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: any) => <span data-icon={name} />,
  Loading: () => <span>Loading</span>,
  LoginLink: () => <a href="/sign-in">Sign in</a>,
  Title: ({ children }: any) => <h1>{children}</h1>,
}));

jest.mock("@cocalc/frontend/i18n", () => ({
  labels: {
    create: { defaultMessage: "create" },
    projects: { defaultMessage: "Projects" },
  },
}));

jest.mock("@cocalc/frontend/collaborators", () => ({
  IncomingInviteBanner: () => <div data-testid="invite-banner" />,
  useInviteInboxState: () => ({}),
}));

jest.mock("./create-project", () => ({
  NewProjectCreator: ({ open }: any) => (
    <div data-testid="new-project-creator" data-open={String(open)} />
  ),
}));

jest.mock("./projects-operations", () => ({
  ProjectsOperations: () => <div data-testid="projects-operations" />,
}));

jest.mock("./projects-starred", () => ({
  StarredProjectsBar: () => <div data-testid="starred-projects" />,
}));

jest.mock("./projects-table", () => ({
  ProjectsTable: ({ freezeOrder, visible_projects }: any) => (
    <div
      data-testid="projects-table"
      data-freeze-order={String(!!freezeOrder)}
      data-visible-projects={JSON.stringify(visible_projects)}
    />
  ),
}));

jest.mock("./mobile-projects-list", () => ({
  MobileProjectsList: () => <div data-testid="mobile-projects-list" />,
}));

jest.mock("./projects-table-controls", () => ({
  ProjectsTableControls: ({
    onRefreshProjectList,
    projectListChanged,
    projectListChangedCount,
  }: any) => (
    <div data-testid="projects-table-controls">
      {projectListChanged && (
        <button type="button" onClick={onRefreshProjectList}>
          Refresh project list
          {projectListChangedCount > 1 ? ` (${projectListChangedCount})` : ""}
        </button>
      )}
    </div>
  ),
}));

jest.mock("./project-drawer", () => ({
  ProjectDrawer: () => <div data-testid="project-drawer" />,
}));

jest.mock("./tour", () => ({
  __esModule: true,
  default: () => <div data-testid="projects-tour" />,
}));

jest.mock("./use-bookmarked-projects", () => ({
  useBookmarkedProjects: () => ({ bookmarkedProjects: [] }),
}));

jest.mock("./util", () => ({
  getVisibleProjects: () => mockVisibleProjects,
}));

jest.mock("@cocalc/frontend/file-use/button", () => ({
  RecentDocumentActivityButton: () => <button type="button">Recent</button>,
}));

jest.mock("./filename-search", () => ({
  FilenameSearch: () => <input aria-label="Filename search" />,
}));

jest.mock("./project-delete-queue", () => ({
  retainScheduledProjectDeletes: jest.fn(),
  useProjectDeleteQueue: () => ({
    scheduledDeleteProjectIds: mockScheduledDeleteProjectIds,
  }),
}));

beforeEach(() => {
  window.localStorage.clear();
  mockVisibleProjects.length = 0;
  mockProjectListWindow = undefined;
  mockHidden = false;
  mockSearch = "";
  mockSelectedHashtags = mockEmptyMap;
  mockLoadProjectListWindow.mockClear();
  (globalThis as any).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  useTypedReduxMock.mockImplementation((store: string, key: string) => {
    if (store === "projects" && key === "project_map") return mockEmptyMap;
    if (store === "projects" && key === "host_info") return mockEmptyMap;
    if (store === "users" && key === "user_map") return mockEmptyMap;
    if (store === "projects" && key === "hidden") return mockHidden;
    if (store === "projects" && key === "search") return mockSearch;
    if (store === "projects" && key === "selected_hashtags")
      return mockSelectedHashtags;
    if (store === "projects" && key === "project_list_window")
      return mockProjectListWindow;
    return undefined;
  });
});

test("project creation modal does not auto-open for an empty project list", () => {
  window.localStorage.setItem("cocalc:projects:createPanelOpen", "true");

  render(<ProjectsPage />);

  expect(screen.getByTestId("new-project-creator")).toHaveAttribute(
    "data-open",
    "false",
  );
  expect(screen.getByRole("button", { name: /create/i })).toBeInTheDocument();
});

test("project creation modal opens from the explicit create button", () => {
  render(<ProjectsPage />);

  fireEvent.click(screen.getByRole("button", { name: /create/i }));

  expect(screen.getByTestId("new-project-creator")).toHaveAttribute(
    "data-open",
    "true",
  );
});

test("projects page falls back to locally visible projects without a matching backend window", () => {
  mockVisibleProjects.push("local-project");

  render(<ProjectsPage />);

  expect(screen.getByTestId("projects-table")).toHaveAttribute(
    "data-visible-projects",
    JSON.stringify(["local-project"]),
  );
});

test("projects page renders matching backend project window ids", () => {
  mockVisibleProjects.push("local-project");
  mockProjectListWindow = ImmutableMap({
    key: JSON.stringify({
      limit: 200,
      offset: 0,
      hidden: false,
      search: "",
      sort: "last_edited",
    }),
    project_ids: ["backend-project-1", "backend-project-2"],
    loading: false,
  });

  render(<ProjectsPage />);

  expect(screen.getByTestId("projects-table")).toHaveAttribute(
    "data-visible-projects",
    JSON.stringify(["backend-project-1", "backend-project-2"]),
  );
});

test("projects page ignores backend project window while hashtag filters are active", () => {
  mockVisibleProjects.push("local-hashtag-project");
  mockSelectedHashtags = ImmutableMap({
    false: ImmutableSet(["release"]),
  });
  mockProjectListWindow = ImmutableMap({
    key: JSON.stringify({
      limit: 200,
      offset: 0,
      hidden: false,
      search: "",
      sort: "last_edited",
    }),
    project_ids: ["backend-project"],
    loading: false,
  });

  render(<ProjectsPage />);

  expect(screen.getByTestId("projects-table")).toHaveAttribute(
    "data-visible-projects",
    JSON.stringify(["local-hashtag-project"]),
  );
});

test("projects page shows explicit refresh for dirty backend window", () => {
  mockVisibleProjects.push("local-project-1", "local-project-2");
  mockProjectListWindow = ImmutableMap({
    key: JSON.stringify({
      limit: 200,
      offset: 0,
      hidden: false,
      search: "",
      sort: "last_edited",
    }),
    project_ids: ["backend-project-1", "backend-project-2"],
    loading: false,
    dirty: true,
    dirty_count: 3,
  });

  render(<ProjectsPage />);

  expect(
    screen.getByRole("button", { name: "Refresh project list (3)" }),
  ).toBeVisible();
  expect(screen.getByTestId("projects-table")).toHaveAttribute(
    "data-visible-projects",
    JSON.stringify(["backend-project-1", "backend-project-2"]),
  );
  expect(screen.getByTestId("projects-table")).toHaveAttribute(
    "data-freeze-order",
    "true",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh project list (3)" }),
  );
  expect(mockLoadProjectListWindow).toHaveBeenCalledWith({
    limit: 200,
    offset: 0,
    hidden: false,
    search: "",
    sort: "last_edited",
    force: true,
  });
});

test("projects page keeps dirty backend window ids while the window is reloading", () => {
  mockVisibleProjects.push("locally-resorted-project");
  mockProjectListWindow = ImmutableMap({
    key: JSON.stringify({
      limit: 200,
      offset: 0,
      hidden: false,
      search: "",
      sort: "last_edited",
    }),
    project_ids: ["stable-backend-project"],
    loading: true,
    dirty: true,
    dirty_count: 1,
  });

  render(<ProjectsPage />);

  expect(screen.getByTestId("projects-table")).toHaveAttribute(
    "data-visible-projects",
    JSON.stringify(["stable-backend-project"]),
  );
  expect(screen.getByTestId("projects-table")).toHaveAttribute(
    "data-freeze-order",
    "true",
  );
});

test("projects page cancels pending automatic window refresh when the window becomes dirty", () => {
  jest.useFakeTimers();
  mockProjectListWindow = ImmutableMap({
    key: JSON.stringify({
      limit: 200,
      offset: 0,
      hidden: false,
      search: "",
      sort: "last_edited",
    }),
    project_ids: ["stable-backend-project"],
    loading: false,
  });

  const { rerender } = render(<ProjectsPage />);

  mockProjectListWindow = mockProjectListWindow
    .set("dirty", true)
    .set("dirty_count", 1);
  rerender(<ProjectsPage />);

  act(() => {
    jest.advanceTimersByTime(600);
  });

  expect(mockLoadProjectListWindow).not.toHaveBeenCalled();
  jest.useRealTimers();
});
