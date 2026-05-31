/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { Map as ImmutableMap } from "immutable";

import { ProjectsPage } from "./projects-page";

const useTypedReduxMock = jest.fn();
const mockEmptyMap = ImmutableMap();
const mockVisibleProjects: string[] = [];
const mockScheduledDeleteProjectIds: string[] = [];

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
        if (name === "projects") return { ensure_host_info: jest.fn() };
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
  ProjectsTable: () => <div data-testid="projects-table" />,
}));

jest.mock("./mobile-projects-list", () => ({
  MobileProjectsList: () => <div data-testid="mobile-projects-list" />,
}));

jest.mock("./projects-table-controls", () => ({
  ProjectsTableControls: () => <div data-testid="projects-table-controls" />,
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
  (globalThis as any).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  useTypedReduxMock.mockImplementation((store: string, key: string) => {
    if (store === "projects" && key === "project_map") return mockEmptyMap;
    if (store === "projects" && key === "host_info") return mockEmptyMap;
    if (store === "users" && key === "user_map") return mockEmptyMap;
    if (store === "projects" && key === "hidden") return false;
    if (store === "projects" && key === "search") return "";
    if (store === "projects" && key === "selected_hashtags")
      return mockEmptyMap;
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
