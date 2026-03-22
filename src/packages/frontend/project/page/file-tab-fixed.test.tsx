/** @jest-environment jsdom */

import { fireEvent, render } from "@testing-library/react";

const mockSetActiveTab = jest.fn();
const mockToggleFlyout = jest.fn();

jest.mock("antd", () => ({
  Popover: ({ children }: any) => children,
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
    open_file: jest.fn(),
  }),
  useRedux: () => undefined,
  useTypedRedux: (_store: any, key: string) => {
    if (key === "status") return undefined;
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

jest.mock("@cocalc/frontend/user-tracking", () => jest.fn());

jest.mock("./flyouts", () => ({
  AgentsFlyout: () => null,
  CollabsFlyout: () => null,
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

describe("FileTab fixed-tab behavior", () => {
  beforeEach(() => {
    mockSetActiveTab.mockReset();
    mockToggleFlyout.mockReset();
  });

  it("opens the flyout on ordinary click", () => {
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
  });

  it("opens the full page on modifier click", () => {
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
    expect(mockSetActiveTab).toHaveBeenCalledWith("agents");
    expect(mockToggleFlyout).not.toHaveBeenCalled();
  });

  it("opens the full page on double click", () => {
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
    expect(mockToggleFlyout).not.toHaveBeenCalled();
  });
});
