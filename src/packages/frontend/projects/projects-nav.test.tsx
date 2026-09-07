/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { List, Map as ImmutableMap } from "immutable";

import { ProjectsNav } from "./projects-nav";

const pageActions = {
  close_project_tab: jest.fn(),
  set_active_tab: jest.fn(),
};
const projectActions = {
  move_project_tab: jest.fn(),
  open_file: jest.fn(),
  open_project: jest.fn(),
};
const mockEnsureProjectReduxRuntime = jest.fn(async () => undefined);
const mockSetProjectBookmarked = jest.fn();
let mockBookmarkedProjects: string[] = [];

jest.mock("antd", () => ({
  Button: ({ children, icon, onClick, ...props }: any) => (
    <button type="button" onClick={onClick} {...props}>
      {icon}
      {children}
    </button>
  ),
  Divider: () => <hr />,
  Popover: ({ children }: any) => <>{children}</>,
  Select: jest.requireActual("antd").Select,
  Tabs: ({ hideAdd, items = [], onEdit, onChange }: any) => (
    <div>
      {!hideAdd && (
        <button type="button" onClick={() => onEdit?.("", "add")}>
          Add project
        </button>
      )}
      {items.map((item: any) => (
        <div
          aria-selected="false"
          key={item.key}
          role="tab"
          tabIndex={0}
          onClick={() => onChange?.(item.key)}
        >
          {item.label}
        </div>
      ))}
    </div>
  ),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getProjectActions: () => projectActions,
  },
  useActions: (name: string) =>
    name === "page" ? pageActions : projectActions,
  useAccountOtherSetting: (key: string) =>
    key === "hide_project_popovers" ? true : undefined,
  useRedux: () =>
    ImmutableMap({
      title: "Alpha",
      description: "",
      state: ImmutableMap({ state: "running" }),
    }),
  useTypedRedux: (store: any, key?: string) => {
    if (typeof store === "object" && key === "status") {
      return ImmutableMap({ alerts: List() });
    }
    if (store === "page" && key === "active_top_tab") return "project-1";
    if (store === "projects" && key === "open_projects")
      return List(["project-1"]);
    if (store === "projects" && key === "project_map") {
      return ImmutableMap({
        "project-1": ImmutableMap({
          title: "Alpha",
          description: "",
          state: ImmutableMap({ state: "running" }),
        }),
      });
    }
    if (store === "projects" && key === "public_project_titles")
      return ImmutableMap();
    if (store === "projects" && key === "host_info") return ImmutableMap();
    if (store === "account" && key === "other_settings") {
      return ImmutableMap({ hide_project_popovers: true });
    }
    return undefined;
  },
}));

jest.mock("@cocalc/frontend/app-framework/project-runtime", () => ({
  ensureProjectReduxRuntime: () => mockEnsureProjectReduxRuntime(),
}));

jest.mock("@cocalc/frontend/browser", () => ({
  set_window_title: jest.fn(),
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: any) => <span data-icon={name} />,
  Loading: () => <span>Loading</span>,
  Tooltip: ({ children }: any) => <>{children}</>,
}));

jest.mock("@cocalc/frontend/components/sortable-tabs", () => ({
  AccessibleAddTabIcon: ({ children }: any) => children,
  SortableTab: ({ children }: any) => <>{children}</>,
  SortableTabs: ({ children }: any) => <div>{children}</div>,
  useItemContext: () => ({}),
  useSortable: () => ({ active: null }),
}));

jest.mock("@cocalc/frontend/components/lazy-markdown", () => ({
  __esModule: true,
  default: ({ value }: any) => <span>{value}</span>,
}));

jest.mock("@cocalc/frontend/feature", () => ({
  IS_MOBILE: false,
}));

jest.mock("@cocalc/frontend/projects/project-avatar", () => ({
  ProjectAvatarImage: () => <span data-testid="project-avatar" />,
}));

jest.mock("../project/page/project-state-hook", () => ({
  useProjectState: () => ImmutableMap({ state: "running" }),
}));

jest.mock("../project/settings/has-internet-access-hook", () => ({
  useProjectHasInternetAccess: () => true,
}));

jest.mock("./create-project", () => ({
  NewProjectCreator: ({ open }: any) => (
    <div data-testid="new-project-creator" data-open={String(open)} />
  ),
}));

jest.mock("./theme", () => ({
  ProjectThemeAvatar: () => <span data-testid="project-theme-avatar" />,
  projectThemeColor: () => undefined,
  projectThemeFromProject: () => ({}),
}));

jest.mock("./use-bookmarked-projects", () => ({
  useBookmarkedProjects: () => ({
    bookmarkedProjects: mockBookmarkedProjects,
    setProjectBookmarked: mockSetProjectBookmarked,
  }),
}));

describe("ProjectsNav", () => {
  beforeEach(() => {
    window.localStorage.setItem("cocalc:projects-nav-mode", "tabs");
    pageActions.close_project_tab.mockReset();
    pageActions.set_active_tab.mockReset();
    projectActions.move_project_tab.mockReset();
    projectActions.open_file.mockReset();
    projectActions.open_project.mockReset();
    mockEnsureProjectReduxRuntime.mockClear();
    mockSetProjectBookmarked.mockReset();
    mockBookmarkedProjects = [];
  });

  it("opens the create-project modal from the native accessible add tab", async () => {
    render(<ProjectsNav height={42} />);

    fireEvent.click(screen.getByRole("button", { name: "Add project" }));

    expect(await screen.findByTestId("new-project-creator")).toHaveAttribute(
      "data-open",
      "true",
    );
    expect(pageActions.set_active_tab).not.toHaveBeenCalledWith("projects");
  });

  it("renders project tabs without star controls", () => {
    render(<ProjectsNav height={42} />);

    expect(screen.getByText("Alpha")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Star project" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unstar project" })).toBeNull();
    expect(mockSetProjectBookmarked).not.toHaveBeenCalled();
  });

  it("labels the project switcher in list mode", () => {
    render(<ProjectsNav height={42} />);

    fireEvent.click(screen.getByRole("button", { name: "Tabs" }));

    expect(
      screen.getByRole("combobox", { name: "Switch project" }),
    ).toBeInTheDocument();
  });

  it("hides the selected rich label during search and restores it on clear or Escape", async () => {
    const user = userEvent.setup();
    const { container } = render(<ProjectsNav height={42} />);
    await user.click(screen.getByRole("button", { name: "Tabs" }));
    const input = screen.getByRole("combobox", { name: "Switch project" });
    const selectedLabel = () => container.querySelector(".ant-select-content");
    expect(selectedLabel()?.textContent).toContain("Alpha");
    expect(
      selectedLabel()?.querySelector('[data-testid="project-theme-avatar"]'),
    ).not.toBeNull();
    await user.type(input, "Al");
    expect(input).toHaveValue("Al");
    expect(selectedLabel()?.textContent ?? "").not.toContain("Alpha");
    expect(
      selectedLabel()?.querySelector('[data-testid="project-theme-avatar"]'),
    ).toBeNull();
    expect(screen.getByText("Alpha")).toBeVisible();
    await user.clear(input);
    expect(selectedLabel()?.textContent).toContain("Alpha");
    await user.type(input, "not a project");
    expect(selectedLabel()?.textContent ?? "").not.toContain("Alpha");
    await user.clear(input);
    await user.type(input, "Al");
    fireEvent.keyDown(input, { key: "Escape", code: "Escape", keyCode: 27 });
    await waitFor(() => expect(input).toHaveValue(""));
    expect(selectedLabel()?.textContent).toContain("Alpha");
    expect(input).toHaveFocus();
    expect(projectActions.open_project).not.toHaveBeenCalled();
  });

  it("reports mode changes to the app navigation", async () => {
    const onModeChange = jest.fn();
    render(<ProjectsNav height={42} onModeChange={onModeChange} />);

    await waitFor(() => expect(onModeChange).toHaveBeenCalledWith("tabs"));
    fireEvent.click(screen.getByRole("button", { name: "Tabs" }));
    await waitFor(() =>
      expect(onModeChange).toHaveBeenLastCalledWith("dropdown"),
    );
  });

  it("closes project tabs with the pointer control or Delete key", () => {
    const { rerender } = render(<ProjectsNav height={42} />);

    fireEvent.click(screen.getByTitle("Close Alpha"));
    expect(pageActions.close_project_tab).toHaveBeenCalledWith("project-1");

    pageActions.close_project_tab.mockReset();
    rerender(<ProjectsNav height={42} />);
    fireEvent.keyDown(screen.getByRole("tab"), { key: "Delete" });
    expect(pageActions.close_project_tab).toHaveBeenCalledWith("project-1");
  });

  it("loads the project runtime before opening a modified tab click", async () => {
    render(<ProjectsNav height={42} />);

    fireEvent.click(screen.getByText("Alpha"), { shiftKey: true });

    await waitFor(() => {
      expect(mockEnsureProjectReduxRuntime).toHaveBeenCalledTimes(1);
      expect(projectActions.open_file).toHaveBeenCalledWith({
        path: "",
        new_browser_window: true,
      });
    });
    expect(
      mockEnsureProjectReduxRuntime.mock.invocationCallOrder[0],
    ).toBeLessThan(projectActions.open_file.mock.invocationCallOrder[0]);
  });
});
