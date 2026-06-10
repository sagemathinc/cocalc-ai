/** @jest-environment jsdom */

import immutable from "immutable";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FilesBottom } from "./files-bottom";

const start_project = jest.fn();
let mockProjectMap: any;
let mockFlyoutState: any;

jest.mock("antd", () => {
  const Button = ({ children, ...props }: any) => (
    <button type="button" {...props}>
      {children}
    </button>
  );
  const Collapse = ({ activeKey = [], items, onChange }: any) => {
    const activeKeys = Array.isArray(activeKey) ? activeKey : [activeKey];
    return (
      <div>
        {items.map((item: any) => (
          <section key={item.key}>
            <button
              type="button"
              data-testid={`collapse-${item.key}`}
              onClick={() => {
                onChange(
                  activeKeys.includes(item.key)
                    ? activeKeys.filter((key: string) => key !== item.key)
                    : [...activeKeys, item.key],
                );
              }}
            >
              {item.label}
            </button>
            {activeKeys.includes(item.key) ? <div>{item.children}</div> : null}
          </section>
        ))}
      </div>
    );
  };
  const Space = ({ children }: any) => <div>{children}</div>;
  Space.Compact = ({ children }: any) => <div>{children}</div>;
  return {
    Alert: ({ message, description }: any) => (
      <div>
        <div>{message}</div>
        <div>{description}</div>
      </div>
    ),
    Button,
    Collapse,
    Tooltip: ({ children }: any) => <>{children}</>,
    Space,
  };
});

jest.mock("@ant-design/icons", () => ({
  CaretRightOutlined: () => null,
}));

jest.mock("@cocalc/frontend/antd-bootstrap", () => ({
  Button: ({ children, ...props }: any) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  CSS: {},
  redux: {
    getActions: () => ({ start_project }),
  },
  useActions: () => ({}),
  useEffect: require("react").useEffect,
  useLayoutEffect: require("react").useLayoutEffect,
  useMemo: require("react").useMemo,
  useRef: require("react").useRef,
  useState: require("react").useState,
  useTypedRedux: (store: string, key: string) => {
    if (store === "projects" && key === "project_map") return mockProjectMap;
    if (store === "account" && key === "account_id") return "user-1";
    if (store === "account" && key === "is_admin") return false;
    return undefined;
  },
  useProjectFromMap: (project_id: string) => mockProjectMap?.get(project_id),
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
}));

jest.mock("@cocalc/frontend/course", () => ({
  useStudentProjectFunctionality: () => ({}),
}));

jest.mock("@cocalc/frontend/editor-tmp", () => ({
  file_options: () => undefined,
}));

jest.mock("@cocalc/frontend/frame-editors/frame-tree/title-bar", () => ({
  ConnectionStatusIcon: () => null,
}));

jest.mock("@cocalc/frontend/misc", () => ({
  open_new_tab: jest.fn(),
}));

jest.mock("@cocalc/frontend/project/explorer/file-listing/file-row", () => ({
  VIEWABLE_FILE_EXT: [],
}));

jest.mock("@cocalc/frontend/project/utils", () => ({
  url_href: () => "#",
}));

jest.mock("./consts", () => ({
  FLYOUT_PADDING: 8,
  PANEL_STYLE_BOTTOM: {},
}));

jest.mock("../common", () => ({
  FIX_BORDER: "1px solid #ddd",
}));

jest.mock("./files-controls", () => ({
  FilesSelectedControls: () => <div>FilesSelectedControls</div>,
}));

jest.mock("./files-terminal", () => ({
  TerminalFlyout: () => <div>TerminalFlyout</div>,
}));

jest.mock("./state", () => ({
  getFlyoutFiles: () => mockFlyoutState,
  storeFlyoutState: jest.fn(),
}));

jest.mock("./utils", () => ({
  useSingleFile: () => undefined,
}));

jest.mock("./files-select-extra", () => ({
  FilesSelectButtons: () => <div>FilesSelectButtons</div>,
}));

describe("FilesBottom", () => {
  beforeEach(() => {
    start_project.mockReset();
    mockProjectMap = immutable.Map({
      "project-1": immutable.Map({
        users: immutable.Map({
          "user-1": immutable.Map({ group: "owner" }),
        }),
      }),
    });
    mockFlyoutState = {
      terminal: { show: false },
      selected: { show: false },
    };
    (global as any).ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
  });

  it("does not automatically start just because the terminal panel is restored", async () => {
    mockFlyoutState = {
      terminal: { show: true },
      selected: { show: false },
    };

    render(
      <FilesBottom
        project_id="project-1"
        checked_files={immutable.Set()}
        activeFile={null}
        directoryFiles={[]}
        projectIsRunning={false}
        rootHeightPx={600}
        open={jest.fn()}
        modeState={["open", jest.fn()]}
        clearAllSelections={jest.fn()}
        selectAllFiles={jest.fn()}
        getFile={jest.fn()}
        currentPath="/"
        onNavigate={jest.fn()}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText("Project is stopped. Start it to use this terminal."),
      ).toBeTruthy();
    });
    expect(start_project).not.toHaveBeenCalled();
  });

  it("starts the project automatically once when the terminal panel is explicitly opened", async () => {
    const { rerender } = render(
      <FilesBottom
        project_id="project-1"
        checked_files={immutable.Set()}
        activeFile={null}
        directoryFiles={[]}
        projectIsRunning={false}
        rootHeightPx={600}
        open={jest.fn()}
        modeState={["open", jest.fn()]}
        clearAllSelections={jest.fn()}
        selectAllFiles={jest.fn()}
        getFile={jest.fn()}
        currentPath="/"
        onNavigate={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("collapse-terminal"));

    await waitFor(() => {
      expect(start_project).toHaveBeenCalledWith("project-1", {
        autostart: true,
      });
    });
    expect(
      screen.getByText("Starting the project so the terminal can connect..."),
    ).toBeTruthy();

    rerender(
      <FilesBottom
        project_id="project-1"
        checked_files={immutable.Set()}
        activeFile={null}
        directoryFiles={[]}
        projectIsRunning={true}
        rootHeightPx={600}
        open={jest.fn()}
        modeState={["open", jest.fn()]}
        clearAllSelections={jest.fn()}
        selectAllFiles={jest.fn()}
        getFile={jest.fn()}
        currentPath="/"
        onNavigate={jest.fn()}
      />,
    );
    rerender(
      <FilesBottom
        project_id="project-1"
        checked_files={immutable.Set()}
        activeFile={null}
        directoryFiles={[]}
        projectIsRunning={false}
        rootHeightPx={600}
        open={jest.fn()}
        modeState={["open", jest.fn()]}
        clearAllSelections={jest.fn()}
        selectAllFiles={jest.fn()}
        getFile={jest.fn()}
        currentPath="/"
        onNavigate={jest.fn()}
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByText("Project is stopped. Start it to use this terminal."),
      ).toBeTruthy();
    });
    expect(start_project).toHaveBeenCalledTimes(1);
  });

  it("starts the project manually from a stopped terminal", async () => {
    mockFlyoutState = {
      terminal: { show: true },
      selected: { show: false },
    };

    render(
      <FilesBottom
        project_id="project-1"
        checked_files={immutable.Set()}
        activeFile={null}
        directoryFiles={[]}
        projectIsRunning={false}
        rootHeightPx={600}
        open={jest.fn()}
        modeState={["open", jest.fn()]}
        clearAllSelections={jest.fn()}
        selectAllFiles={jest.fn()}
        getFile={jest.fn()}
        currentPath="/"
        onNavigate={jest.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Start project")).toBeTruthy();
    });
    expect(start_project).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Start project"));
    expect(start_project).toHaveBeenCalledWith("project-1", {
      autostart: false,
    });
  });

  it("does not automatically start terminals when automatic starts are disabled", async () => {
    mockFlyoutState = {
      terminal: { show: true },
      selected: { show: false },
    };
    mockProjectMap = immutable.Map({
      "project-1": immutable.Map({
        autostart_enabled: false,
      }),
    });

    render(
      <FilesBottom
        project_id="project-1"
        checked_files={immutable.Set()}
        activeFile={null}
        directoryFiles={[]}
        projectIsRunning={false}
        rootHeightPx={600}
        open={jest.fn()}
        modeState={["open", jest.fn()]}
        clearAllSelections={jest.fn()}
        selectAllFiles={jest.fn()}
        getFile={jest.fn()}
        currentPath="/"
        onNavigate={jest.fn()}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText("Terminal cannot start this project automatically"),
      ).toBeTruthy();
    });
    expect(screen.getByText(/Automatic starts are disabled/)).toBeTruthy();
    expect(start_project).not.toHaveBeenCalled();
  });
});
