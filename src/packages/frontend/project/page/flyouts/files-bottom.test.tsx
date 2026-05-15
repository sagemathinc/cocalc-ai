/** @jest-environment jsdom */

import immutable from "immutable";
import { render, screen, waitFor } from "@testing-library/react";
import { FilesBottom } from "./files-bottom";

const start_project = jest.fn();
let mockProjectMap: any;

jest.mock("antd", () => {
  const Button = ({ children, ...props }: any) => (
    <button type="button" {...props}>
      {children}
    </button>
  );
  const Collapse = ({ items }: any) => (
    <div>
      {items.map((item: any) => (
        <section key={item.key}>
          <div>{item.label}</div>
          <div>{item.children}</div>
        </section>
      ))}
    </div>
  );
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
  getFlyoutFiles: () => ({
    terminal: { show: true },
    selected: { show: false },
  }),
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
    (global as any).ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
  });

  it("starts the project automatically when the terminal panel is shown", async () => {
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
      expect(start_project).toHaveBeenCalledWith("project-1", {
        autostart: true,
      });
    });
    expect(
      screen.getByText("Starting the project so the terminal can connect..."),
    ).toBeTruthy();
  });

  it("does not automatically start terminals when automatic starts are disabled", async () => {
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
