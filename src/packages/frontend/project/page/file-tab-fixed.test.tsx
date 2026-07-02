/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";

const mockSetActiveTab = jest.fn();
const mockToggleFlyout = jest.fn();
const mockSetFlyoutExpanded = jest.fn();
let mockStatusAlerts: any[] = [];
let mockActiveProjectTab = "files";

jest.mock("antd", () => ({
  Button: ({ children, onClick }: any) => (
    <button onClick={onClick}>{children}</button>
  ),
  Popover: ({ children, content }: any) => (
    <span>
      {children}
      {content}
    </span>
  ),
  Space: ({ children }: any) => <div>{children}</div>,
  Tag: ({ children }: any) => <span>{children}</span>,
  Tooltip: ({ children }: any) => children,
}));

jest.mock("react-intl", () => ({
  defineMessage: (value: any) => value,
  useIntl: () => ({
    formatMessage: (value: any) => value?.defaultMessage ?? value?.id ?? "",
  }),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  useActions: () => ({
    set_active_tab: mockSetActiveTab,
    toggleFlyout: mockToggleFlyout,
    setFlyoutExpanded: mockSetFlyoutExpanded,
    open_file: jest.fn(),
  }),
  useRedux: () => undefined,
  useAccountOtherSetting: (key: string) => {
    if (key === "hide_file_popovers") return false;
    if (key === "file_tab_accent_mode") return "bright";
    return undefined;
  },
  useTypedRedux: (_store: any, key: string) => {
    if (key === "active_project_tab") {
      return mockActiveProjectTab;
    }
    if (key === "status") {
      return {
        get: (name: string) => {
          if (name === "alerts") {
            return {
              toJS: () => mockStatusAlerts,
            };
          }
          return undefined;
        },
      };
    }
    if (key === "other_settings") {
      return {
        get: (name: string) => {
          if (name === "hide_file_popovers") return false;
          if (name === "file_tab_accent_mode") return "bright";
          return undefined;
        },
      };
    }
    return undefined;
  },
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: any) => <span>{name}</span>,
  r_join: (items: any[]) => items,
}));

jest.mock("@cocalc/frontend/feature", () => ({
  IS_MOBILE: false,
}));

jest.mock("@cocalc/frontend/i18n", () => ({
  labels: {
    settings: "Settings",
    users: "Users",
    tabs: "Tabs",
    project_info_title: "Project Info",
  },
  isIntlMessage: (value: any) => value?.defaultMessage != null,
}));

jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({
    onCoCalcDocker: false,
    workspaces: {
      resolveWorkspaceForPath: () => null,
    },
  }),
}));

jest.mock("@cocalc/frontend/project/servers/consts", () => ({
  ICON_USERS: "users",
}));

jest.mock("@cocalc/frontend/project/workspaces/chat-display", () => ({
  generatedWorkspaceChatLabel: () => null,
}));

jest.mock("./flyouts", () => ({
  AgentsFlyout: () => null,
  DocsFlyout: () => null,
  FilesFlyout: () => null,
  LogFlyout: () => null,
  NewFlyout: () => null,
  ProjectInfoFlyout: () => null,
  SearchFlyout: () => null,
  ServersFlyout: () => null,
  SettingsFlyout: () => null,
  WorkspacesFlyout: () => null,
}));

jest.mock("./flyouts/active", () => ({
  ActiveFlyout: () => null,
}));

jest.mock("@cocalc/frontend/editor-tmp", () => ({
  file_options: () => ({}),
}));

import { FileTab } from "./file-tab";
import {
  getActivityBarPanelMode,
  setActivityBarPanelMode,
} from "./activity-bar-storage";

describe("FileTab fixed-tab behavior", () => {
  beforeEach(() => {
    mockSetActiveTab.mockReset();
    mockToggleFlyout.mockReset();
    mockSetFlyoutExpanded.mockReset();
    mockStatusAlerts = [];
    mockActiveProjectTab = "files";
    window.localStorage.clear();
  });

  it("opens the full page on ordinary click by default", () => {
    const { container } = render(
      <FileTab
        project_id="project-1"
        name="agents"
        flyout="agents"
        isFixedTab
        showLabel
      />,
    );
    const tab = container.querySelector('[cocalc-test="Agents"]') as Element;
    fireEvent.click(tab);
    expect(mockSetActiveTab).toHaveBeenCalledWith("agents");
    expect(mockSetFlyoutExpanded).toHaveBeenCalledWith("agents", false, false);
    expect(mockToggleFlyout).not.toHaveBeenCalled();
    expect(getActivityBarPanelMode("agents")).toBeUndefined();
  });

  it("opens the full page on shift-click", () => {
    const { container } = render(
      <FileTab
        project_id="project-1"
        name="agents"
        flyout="agents"
        isFixedTab
        showLabel
      />,
    );
    const tab = container.querySelector('[cocalc-test="Agents"]') as Element;
    fireEvent.click(tab, { shiftKey: true });
    expect(mockSetActiveTab).toHaveBeenCalledWith("agents");
    expect(mockSetFlyoutExpanded).toHaveBeenCalledWith("agents", false, false);
    expect(getActivityBarPanelMode("agents")).toBe("full");
    expect(mockToggleFlyout).not.toHaveBeenCalled();
  });

  it("forces the flyout on control-click even when full page is remembered", () => {
    setActivityBarPanelMode("agents", "full");
    const { container } = render(
      <FileTab
        project_id="project-1"
        name="agents"
        flyout="agents"
        isFixedTab
        showLabel
      />,
    );
    const tab = container.querySelector('[cocalc-test="Agents"]') as Element;
    fireEvent.click(tab, { ctrlKey: true });
    expect(mockSetFlyoutExpanded).toHaveBeenCalledWith("agents", true);
    expect(getActivityBarPanelMode("agents")).toBe("flyout");
    expect(mockSetActiveTab).not.toHaveBeenCalled();
    expect(mockToggleFlyout).not.toHaveBeenCalled();
  });

  it("opens remembered full page on ordinary click", () => {
    setActivityBarPanelMode("agents", "full");
    const { container } = render(
      <FileTab
        project_id="project-1"
        name="agents"
        flyout="agents"
        isFixedTab
        showLabel
      />,
    );
    const tab = container.querySelector('[cocalc-test="Agents"]') as Element;
    fireEvent.click(tab);
    expect(mockSetActiveTab).toHaveBeenCalledWith("agents");
    expect(mockSetFlyoutExpanded).toHaveBeenCalledWith("agents", false, false);
    expect(mockToggleFlyout).not.toHaveBeenCalled();
  });

  it("opens remembered flyout on ordinary click", () => {
    setActivityBarPanelMode("agents", "flyout");
    const { container } = render(
      <FileTab
        project_id="project-1"
        name="agents"
        flyout="agents"
        isFixedTab
        showLabel
      />,
    );
    const tab = container.querySelector('[cocalc-test="Agents"]') as Element;
    fireEvent.click(tab);
    expect(mockToggleFlyout).toHaveBeenCalledWith("agents");
    expect(mockSetActiveTab).not.toHaveBeenCalled();
    expect(getActivityBarPanelMode("agents")).toBe("flyout");
  });

  it("keeps remembered full page behavior even when already active", () => {
    mockActiveProjectTab = "agents";
    setActivityBarPanelMode("agents", "full");
    const { container } = render(
      <FileTab
        project_id="project-1"
        name="agents"
        flyout="agents"
        isFixedTab
        showLabel
      />,
    );
    const tab = container.querySelector('[cocalc-test="Agents"]') as Element;
    fireEvent.click(tab);
    expect(mockSetActiveTab).toHaveBeenCalledWith("agents");
    expect(mockSetFlyoutExpanded).toHaveBeenCalledWith("agents", false, false);
    expect(mockToggleFlyout).not.toHaveBeenCalled();
    expect(getActivityBarPanelMode("agents")).toBe("full");
  });

  it("keeps opening the full page on double click by default", () => {
    const { container } = render(
      <FileTab
        project_id="project-1"
        name="agents"
        flyout="agents"
        isFixedTab
        showLabel
      />,
    );
    const tab = container.querySelector('[cocalc-test="Agents"]') as Element;
    fireEvent.click(tab, { detail: 2 });
    expect(mockSetActiveTab).toHaveBeenCalledWith("agents");
    expect(mockSetFlyoutExpanded).toHaveBeenCalledWith("agents", false, false);
    expect(mockToggleFlyout).not.toHaveBeenCalled();
  });

  it("does not show stale cgroup CPU alerts on the info fixed tab", () => {
    mockStatusAlerts = [{ type: "cpu-cgroup" }];

    render(<FileTab project_id="project-1" name="info" isFixedTab showLabel />);

    expect(screen.queryByText("CPU warning")).toBeNull();
  });

  it("explains project process CPU alerts on the info fixed tab", () => {
    mockStatusAlerts = [{ type: "cpu-process", pids: ["1234"] }];

    render(<FileTab project_id="project-1" name="info" isFixedTab showLabel />);

    expect(screen.getByText("CPU warning")).toBeTruthy();
    expect(screen.getByText(/project process samples/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open process list" }));
    expect(mockSetActiveTab).toHaveBeenCalledWith("info");
  });
});
