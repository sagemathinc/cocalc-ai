/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";

const mockSetActiveTab = jest.fn();
const mockToggleFlyout = jest.fn();
const mockToggleActionButtons = jest.fn();
const mockSetOtherSettings = jest.fn();
let mockAccountStoreReady = true;
let mockLite = true;

function flattenMenuItems(items: any[] = []): any[] {
  return items.flatMap((item) => {
    if (item == null || item.type === "divider") return [];
    if (Array.isArray(item.children)) return flattenMenuItems(item.children);
    return [item];
  });
}

jest.mock("antd", () => {
  const Button = ({ children, onClick, block: _block, ...props }: any) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  );
  const Checkbox = ({ checked, onChange }: any) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange?.(e)}
      readOnly={false}
    />
  );
  const Dropdown = ({ children, menu }: any) => (
    <div>
      {children}
      <div>
        {flattenMenuItems(menu?.items).map((item) => (
          <button
            key={item.key}
            type="button"
            data-testid={`menu-${item.key}`}
            onClick={(e) => item.onClick?.({ domEvent: e })}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
  const Modal = ({ children, open }: any) =>
    open ? <div>{children}</div> : null;
  const Tooltip = ({ children }: any) => children;
  return { Button, Checkbox, Dropdown, Modal, Tooltip };
});

jest.mock("react-intl", () => ({
  defineMessage: (value: any) => value,
  useIntl: () => ({
    formatMessage: (value: any, vars?: any) => {
      const text = value?.defaultMessage ?? value?.id ?? "";
      if (!vars) return text;
      return text.replace(/\{(\w+)\}/g, (_m, key) => `${vars[key] ?? ""}`);
    },
  }),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  useActions: (name?: string) =>
    name === "account"
      ? { set_other_settings: mockSetOtherSettings }
      : undefined,
  useTypedRedux: (store: any, key: string) => {
    if ((store as any)?.project_id === "project-1" && key === "flyout") {
      return null;
    }
    if (store === "account" && key === "other_settings") {
      return {
        get: (name: string) => {
          if (name === "vertical_fixed_bar_hidden") return ["log", "info"];
          if (name === "vertical_fixed_bar_labels") return true;
          return undefined;
        },
      };
    }
    return undefined;
  },
  CSS: {},
}));

jest.mock("@cocalc/frontend/app/use-context", () => ({
  __esModule: true,
  default: () => ({ showActBarLabels: true }),
}));

jest.mock("@cocalc/frontend/app/account-store-ready", () => ({
  useAccountStoreReady: () => mockAccountStoreReady,
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: any) => <span>{name}</span>,
}));

jest.mock("@cocalc/frontend/components/sortable-list", () => ({
  DragHandle: () => <div />,
  SortableItem: ({ children }: any) => children,
  SortableList: ({ children }: any) => <div>{children}</div>,
}));

jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({
    actions: {
      set_active_tab: mockSetActiveTab,
      toggleFlyout: mockToggleFlyout,
      toggleActionButtons: mockToggleActionButtons,
    },
    project_id: "project-1",
    active_project_tab: "files",
    workspaces: { current: null },
  }),
}));

jest.mock("@cocalc/frontend/user-tracking", () => jest.fn());

jest.mock("@cocalc/frontend/lite", () => ({
  get lite() {
    return mockLite;
  },
}));

jest.mock("@cocalc/frontend/account/settings-button", () => ({
  __esModule: true,
  default: () => <div data-testid="account-settings-button">settings</div>,
}));
jest.mock("@cocalc/frontend/ssh", () => ({
  RemoteSshButton: () => null,
  SshButton: () => null,
}));
jest.mock("@cocalc/frontend/ssh/ssh-upgrade-button", () => () => null);
jest.mock("@cocalc/frontend/chat/chat-indicator", () => ({
  ChatIndicator: () => null,
}));
jest.mock("./share-indicator", () => ({
  ShareIndicator: () => null,
}));
jest.mock("../workspaces/strong-theme", () => ({
  workspaceStrongThemeChrome: () => null,
}));

jest.mock("./file-tabs", () => ({
  __esModule: true,
  default: () => <div data-testid="file-tabs" />,
}));

jest.mock("./file-tab", () => ({
  FileTab: ({ name }: any) => <div data-testid={`rail-${name}`}>{name}</div>,
  FIXED_PROJECT_TABS: {
    workspaces: { label: "Workspaces", icon: "cube" },
    agents: { label: "Agents", icon: "comment" },
    files: { label: "Files", icon: "folder-open-o" },
    new: { label: "New", icon: "plus-circle" },
    search: { label: "Search", icon: "search" },
    users: { label: "Users", icon: "users" },
    settings: { label: "Settings", icon: "wrench" },
    active: { label: "Tabs", icon: "edit", noFullPage: true },
    log: { label: "Log", icon: "history" },
    servers: { label: "Servers", icon: "server" },
    info: { label: "Info", icon: "info-circle" },
  },
}));

import {
  HiddenActivityBarLauncher,
  default as ProjectTabs,
  VerticalFixedTabs,
} from "./activity-bar-tabs";

describe("VerticalFixedTabs overflow actions", () => {
  beforeEach(() => {
    mockSetActiveTab.mockReset();
    mockToggleFlyout.mockReset();
    mockToggleActionButtons.mockReset();
    mockSetOtherSettings.mockReset();
    mockAccountStoreReady = true;
    mockLite = true;
    (global as any).ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
  });

  it("opens a full page from More on modifier click", () => {
    render(<VerticalFixedTabs setHomePageButtonWidth={() => {}} />);

    fireEvent.click(screen.getByTestId("menu-overflow:log"), {
      ctrlKey: true,
    });

    expect(mockSetActiveTab).toHaveBeenCalledWith("log");
    expect(mockToggleFlyout).not.toHaveBeenCalled();
  });

  it("opens a flyout from More on ordinary click", () => {
    render(<VerticalFixedTabs setHomePageButtonWidth={() => {}} />);

    fireEvent.click(screen.getByTestId("menu-overflow:log"));

    expect(mockToggleFlyout).toHaveBeenCalledWith("log");
    expect(mockSetActiveTab).not.toHaveBeenCalled();
  });

  it("shows no rail buttons until account settings are ready", () => {
    mockAccountStoreReady = false;

    render(<VerticalFixedTabs setHomePageButtonWidth={() => {}} />);

    expect(screen.queryByTestId("rail-workspaces")).toBeNull();
    expect(screen.queryByTestId("menu-overflow:log")).toBeNull();
    expect(screen.queryByTestId("account-settings-button")).toBeNull();
  });
});

describe("ProjectTabs settings affordance", () => {
  beforeEach(() => {
    mockLite = false;
  });

  afterEach(() => {
    mockLite = true;
  });

  it("shows account settings in launchpad mode", () => {
    render(<ProjectTabs project_id="project-1" />);

    expect(screen.getByTestId("account-settings-button")).toBeTruthy();
  });
});

describe("HiddenActivityBarLauncher", () => {
  beforeEach(() => {
    mockSetActiveTab.mockReset();
    mockToggleFlyout.mockReset();
    mockToggleActionButtons.mockReset();
    mockSetOtherSettings.mockReset();
    mockAccountStoreReady = true;
  });

  it("opens a flyout from the hidden launcher on ordinary click", () => {
    render(<HiddenActivityBarLauncher />);

    fireEvent.click(screen.getByTestId("menu-launcher:log"));

    expect(mockToggleFlyout).toHaveBeenCalledWith("log");
    expect(mockSetActiveTab).not.toHaveBeenCalled();
  });

  it("opens a full page from the hidden launcher on modifier click", () => {
    render(<HiddenActivityBarLauncher />);

    fireEvent.click(screen.getByTestId("menu-launcher:log"), {
      ctrlKey: true,
    });

    expect(mockSetActiveTab).toHaveBeenCalledWith("log");
    expect(mockToggleFlyout).not.toHaveBeenCalled();
  });

  it("shows the activity bar from the hidden launcher menu", () => {
    render(<HiddenActivityBarLauncher />);

    fireEvent.click(screen.getByTestId("menu-launcher:toggle-activity-bar"));

    expect(mockToggleActionButtons).toHaveBeenCalled();
  });
});
