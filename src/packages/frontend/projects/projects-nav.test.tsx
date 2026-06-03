/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { List, Map as ImmutableMap } from "immutable";

import { ProjectsNav } from "./projects-nav";

const pageActions = {
  close_project_tab: jest.fn(),
  set_active_tab: jest.fn(),
};
const projectActions = {
  move_project_tab: jest.fn(),
  open_project: jest.fn(),
};

jest.mock("antd", () => ({
  Button: ({ children, icon, onClick, ...props }: any) => (
    <button type="button" onClick={onClick} {...props}>
      {icon}
      {children}
    </button>
  ),
  Divider: () => <hr />,
  Popover: ({ children }: any) => <>{children}</>,
  Select: () => <select aria-label="Switch project" />,
  Tabs: ({ items = [], onEdit, onChange }: any) => (
    <div>
      <button type="button" onClick={() => onEdit?.("", "add")}>
        Add project
      </button>
      {items.map((item: any) => (
        <button
          key={item.key}
          type="button"
          onClick={() => onChange?.(item.key)}
        >
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  useActions: (name: string) =>
    name === "page" ? pageActions : projectActions,
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

jest.mock("@cocalc/frontend/browser", () => ({
  set_window_title: jest.fn(),
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: any) => <span data-icon={name} />,
  Loading: () => <span>Loading</span>,
  Tooltip: ({ children }: any) => <>{children}</>,
}));

jest.mock("@cocalc/frontend/components/sortable-tabs", () => ({
  SortableTab: ({ children }: any) => <>{children}</>,
  SortableTabs: ({ children }: any) => <div>{children}</div>,
  useItemContext: () => ({}),
  useSortable: () => ({ active: null }),
}));

jest.mock("@cocalc/frontend/editors/slate/static-markdown", () => ({
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
  useBookmarkedProjects: () => ({ bookmarkedProjects: [] }),
}));

describe("ProjectsNav", () => {
  beforeEach(() => {
    window.localStorage.setItem("cocalc:projects-nav-mode", "tabs");
    pageActions.close_project_tab.mockReset();
    pageActions.set_active_tab.mockReset();
    projectActions.move_project_tab.mockReset();
    projectActions.open_project.mockReset();
  });

  it("opens the create-project modal from the editable tabs add button", () => {
    render(<ProjectsNav height={42} />);

    fireEvent.click(screen.getByRole("button", { name: /Add project/ }));

    expect(screen.getByTestId("new-project-creator")).toHaveAttribute(
      "data-open",
      "true",
    );
    expect(pageActions.set_active_tab).not.toHaveBeenCalledWith("projects");
  });
});
