/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getActivityBarCollapsed } from "./activity-bar-storage";

const mockSetActiveTab = jest.fn();
const mockToggleFlyout = jest.fn();
const mockToggleActionButtons = jest.fn();
const mockSetOtherSettings = jest.fn();
const mockConfirmRemoveMyselfFromProject = jest.fn();
const mockRequestAccess = jest.fn();
const mockModalSuccess = jest.fn();
const mockModalError = jest.fn();
let mockAccountStoreReady = true;
let mockLite = true;
let mockPageState: Record<string, any> = {};
let mockProjectAccessRole: "owner" | "collaborator" | "viewer" = "collaborator";
let mockAgentAIEnabled = true;
let mockRootfsImages: any[] = [];

const mockPageStore = {
  get: (key: string) => mockPageState[key],
  setState: (patch: Record<string, any>) => {
    mockPageState = { ...mockPageState, ...patch };
  },
};

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
  Modal.success = (...args: any[]) => mockModalSuccess(...args);
  Modal.error = (...args: any[]) => mockModalError(...args);
  const Tooltip = ({ children }: any) => children;
  return { Button, Checkbox, Dropdown, Modal, Tooltip };
});

jest.mock("react-intl", () => ({
  defineMessage: (value: any) => value,
  defineMessages: (value: any) => value,
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
    if (store === "account" && key === "account_id") {
      return "account-1";
    }
    return undefined;
  },
  redux: {
    getStore: (name: string) => (name === "page" ? mockPageStore : undefined),
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
  isIconName: (name: unknown) => typeof name === "string",
  Tooltip: ({ children }: any) => <>{children}</>,
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
    agentAIEnabled: mockAgentAIEnabled,
    project_id: "project-1",
    project: {
      get: (name: string) => {
        if (name === "rootfs_image_id") return "rootfs-image-1";
        return undefined;
      },
    },
    active_project_tab: "files",
    projectAccess: {
      role: mockProjectAccessRole,
      capabilities: {
        useProjectRuntime: mockProjectAccessRole !== "viewer",
      },
    },
    workspaces: { current: null },
  }),
}));

jest.mock("@cocalc/frontend/rootfs/manifest", () => ({
  managedRootfsCatalogUrl: () => "/rootfs-images.json",
  useRootfsImages: () => ({ images: mockRootfsImages }),
}));

jest.mock("@cocalc/frontend/projects/remove-myself", () => ({
  confirmRemoveMyselfFromProject: (opts: any) =>
    mockConfirmRemoveMyselfFromProject(opts),
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    project_collaborators: {
      request_access: (...args: any[]) => mockRequestAccess(...args),
    },
  },
}));

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
jest.mock("../workspaces/strong-theme", () => ({
  workspaceStrongThemeChrome: () => null,
}));

jest.mock("./file-tabs", () => ({
  __esModule: true,
  default: () => <div data-testid="file-tabs" />,
}));

jest.mock("./file-tab", () => ({
  FileTab: ({ iconName, name }: any) => (
    <div data-testid={`rail-${name}`}>{iconName ?? name}</div>
  ),
  FIXED_PROJECT_TABS: {
    workspaces: { label: "Workspaces", icon: "cube" },
    agents: { label: "Agents", icon: "comment" },
    files: { label: "Files", icon: "folder-open-o" },
    rootfs: { label: "Rootfs", icon: "docker" },
    new: { label: "New", icon: "plus-circle" },
    search: { label: "Search", icon: "search" },
    docs: { label: "Docs", icon: "book" },
    users: { label: "Users", icon: "users" },
    settings: { label: "Settings", icon: "wrench" },
    active: { label: "Tabs", icon: "edit", noFullPage: true },
    log: { label: "Log", icon: "history" },
    servers: { label: "Servers", icon: "server" },
    info: { label: "Info", icon: "info-circle" },
  },
}));

import {
  CustomizeRailButtonsModal,
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
    mockConfirmRemoveMyselfFromProject.mockReset();
    mockRequestAccess.mockReset();
    mockRequestAccess.mockResolvedValue({});
    mockModalSuccess.mockReset();
    mockModalError.mockReset();
    mockAccountStoreReady = true;
    mockLite = true;
    mockPageState = {};
    mockProjectAccessRole = "collaborator";
    mockAgentAIEnabled = true;
    mockRootfsImages = [];
    window.localStorage.clear();
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

  it("hides runtime, log, and process tabs from viewers", () => {
    mockProjectAccessRole = "viewer";

    render(<VerticalFixedTabs setHomePageButtonWidth={() => {}} />);

    expect(screen.getByTestId("rail-files")).toBeTruthy();
    expect(screen.queryByTestId("rail-info")).toBeNull();
    expect(screen.queryByTestId("menu-overflow:log")).toBeNull();
    expect(screen.queryByTestId("menu-overflow:info")).toBeNull();
    expect(screen.queryByTestId("menu-overflow:servers")).toBeNull();
  });

  it("hides the Agents rail entry when AI is disabled", () => {
    mockAgentAIEnabled = false;

    render(<VerticalFixedTabs setHomePageButtonWidth={() => {}} />);

    expect(screen.queryByTestId("rail-agents")).toBeNull();
    expect(screen.queryByTestId("menu-overflow:agents")).toBeNull();
  });

  it("uses the current Rootfs theme icon on the rail", () => {
    mockRootfsImages = [
      {
        id: "rootfs-image-1",
        image: "registry.example/runtime:1",
        label: "Runtime",
        theme: { icon: "python", color: "#3572a5" },
      },
    ];

    render(<VerticalFixedTabs setHomePageButtonWidth={() => {}} />);

    expect(screen.getByTestId("rail-rootfs")).toHaveTextContent("python");
  });

  it("lets viewers remove themselves from the overflow rail menu", () => {
    mockProjectAccessRole = "viewer";

    render(<VerticalFixedTabs setHomePageButtonWidth={() => {}} />);

    fireEvent.click(screen.getByTestId("menu-overflow:remove-self"));

    expect(mockConfirmRemoveMyselfFromProject).toHaveBeenCalledWith({
      project_id: "project-1",
      account_id: "account-1",
      projectLabel: "Project",
      projectLabelLower: "project",
    });
  });

  it("lets viewers request collaborator access from the overflow rail menu", async () => {
    mockProjectAccessRole = "viewer";

    render(<VerticalFixedTabs setHomePageButtonWidth={() => {}} />);

    fireEvent.click(
      screen.getByTestId("menu-overflow:request-collaborator-access"),
    );

    await waitFor(() =>
      expect(mockRequestAccess).toHaveBeenCalledWith({
        project_id: "project-1",
        requested_role: "collaborator",
        source: "rail-menu",
      }),
    );
    expect(mockModalSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Collaborator access requested",
      }),
    );
  });
});

describe("ProjectTabs settings affordance", () => {
  beforeEach(() => {
    mockLite = false;
    mockPageState = {};
    mockProjectAccessRole = "collaborator";
    mockAgentAIEnabled = true;
    mockRootfsImages = [];
  });

  afterEach(() => {
    mockLite = true;
  });

  it("hides account settings in launchpad mode", () => {
    render(<ProjectTabs project_id="project-1" />);

    expect(screen.queryByTestId("account-settings-button")).toBeNull();
  });

  it("shows account settings in lite mode", () => {
    mockLite = true;

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
    mockConfirmRemoveMyselfFromProject.mockReset();
    mockRequestAccess.mockReset();
    mockRequestAccess.mockResolvedValue({});
    mockModalSuccess.mockReset();
    mockModalError.mockReset();
    mockAccountStoreReady = true;
    mockPageState = {};
    mockProjectAccessRole = "collaborator";
    mockAgentAIEnabled = true;
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

    expect(getActivityBarCollapsed()).toBe(false);
  });

  it("hides the activity bar from the overflow menu", () => {
    render(<VerticalFixedTabs setHomePageButtonWidth={() => {}} />);

    fireEvent.click(screen.getByTestId("menu-overflow:toggle-activity-bar"));

    expect(getActivityBarCollapsed()).toBe(true);
  });

  it("hides log and process tabs from viewer hidden-launcher menus", () => {
    mockProjectAccessRole = "viewer";

    render(<HiddenActivityBarLauncher />);

    expect(screen.queryByTestId("menu-launcher:log")).toBeNull();
    expect(screen.queryByTestId("menu-launcher:info")).toBeNull();
    expect(screen.queryByTestId("menu-launcher:servers")).toBeNull();
  });

  it("hides Agents from hidden-launcher menus when AI is disabled", () => {
    mockAgentAIEnabled = false;

    render(<HiddenActivityBarLauncher />);

    expect(screen.queryByTestId("menu-launcher:agents")).toBeNull();
  });

  it("uses the current Rootfs theme icon in hidden-launcher menus", () => {
    mockRootfsImages = [
      {
        id: "rootfs-image-1",
        image: "registry.example/runtime:1",
        label: "Runtime",
        theme: { icon: "python" },
      },
    ];

    render(<HiddenActivityBarLauncher />);

    expect(screen.getByTestId("menu-launcher:rootfs")).toHaveTextContent(
      "python",
    );
  });

  it("lets viewers remove themselves from the hidden rail launcher menu", () => {
    mockProjectAccessRole = "viewer";

    render(<HiddenActivityBarLauncher />);

    fireEvent.click(screen.getByTestId("menu-launcher:remove-self"));

    expect(mockConfirmRemoveMyselfFromProject).toHaveBeenCalledWith({
      project_id: "project-1",
      account_id: "account-1",
      projectLabel: "Project",
      projectLabelLower: "project",
    });
  });

  it("lets viewers request collaborator access from the hidden rail launcher menu", async () => {
    mockProjectAccessRole = "viewer";

    render(<HiddenActivityBarLauncher />);

    fireEvent.click(
      screen.getByTestId("menu-launcher:request-collaborator-access"),
    );

    await waitFor(() =>
      expect(mockRequestAccess).toHaveBeenCalledWith({
        project_id: "project-1",
        requested_role: "collaborator",
        source: "rail-menu",
      }),
    );
    expect(mockModalSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Collaborator access requested",
      }),
    );
  });
});

describe("CustomizeRailButtonsModal", () => {
  it("does not reset checkbox edits when the parent rerenders with fresh preference arrays", () => {
    const onClose = jest.fn();
    const onSave = jest.fn();
    const order = ["files", "agents", "log"] as any;
    const hiddenTabs = ["log"] as any;

    const { rerender } = render(
      <CustomizeRailButtonsModal
        open={true}
        onClose={onClose}
        onSave={onSave}
        order={order}
        hiddenTabs={hiddenTabs}
      />,
    );

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[0]).toBeChecked();
    fireEvent.click(checkboxes[0]);
    expect(checkboxes[0]).not.toBeChecked();

    rerender(
      <CustomizeRailButtonsModal
        open={true}
        onClose={onClose}
        onSave={onSave}
        order={[...order]}
        hiddenTabs={[...hiddenTabs]}
      />,
    );

    expect(screen.getAllByRole("checkbox")[0]).not.toBeChecked();
  });
});
