/** @jest-environment jsdom */

import { EventEmitter } from "events";
import { Map } from "immutable";
import { waitFor } from "@testing-library/react";

function loadTerminalModule() {
  class MockProjectStore extends EventEmitter {
    private data = Map({
      status: Map({
        state: "running",
      }),
    });

    get = (key: string) => this.data.get(key);
    getIn = (path: string[]) => this.data.getIn(path);
    setStatus = (state: string) => {
      this.data = this.data.set("status", Map({ state }));
      this.emit("change", this.data);
    };
  }

  const projectStore = new MockProjectStore();

  const makePty = () => ({
    socket: {
      state: "ready",
      on: jest.fn(),
      write: jest.fn(),
    },
    on: jest.fn(),
    once: jest.fn((_event: string, cb?: () => void) => cb?.()),
    spawn: jest.fn(async () => ""),
    resize: jest.fn(async () => {}),
    sizes: jest.fn(async () => []),
    cwd: jest.fn(async () => "/tmp"),
    close: jest.fn(),
    destroy: jest.fn(),
    broadcast: jest.fn(),
    state: jest.fn(async () => "running"),
  });
  const availablePtys = [makePty(), makePty(), makePty()];
  const createdPtys = [...availablePtys];
  const terminalClient = jest.fn(() => availablePtys.shift() ?? makePty());

  jest.resetModules();

  jest.doMock("@xterm/xterm", () => {
    class MockTerminal {
      public options: Record<string, any> = {};
      public element: HTMLElement | null = null;
      public cols = 80;
      public rows = 24;

      loadAddon = jest.fn();
      open = (parent: HTMLElement) => {
        this.element = document.createElement("div");
        parent.appendChild(this.element);
      };
      onKey = jest.fn();
      onData = jest.fn();
      onTitleChange = jest.fn();
      attachCustomKeyEventHandler = jest.fn();
      write = (_data: string, cb?: () => void) => cb?.();
      reset = jest.fn();
      resize = jest.fn((cols: number, rows: number) => {
        this.cols = cols;
        this.rows = rows;
      });
      focus = jest.fn();
      refresh = jest.fn();
      dispose = jest.fn();
      getSelection = () => "";
      clearSelection = jest.fn();
      paste = jest.fn();
      clear = jest.fn();
    }

    return { Terminal: MockTerminal };
  });

  jest.doMock("@cocalc/frontend/webapp-client", () => ({
    webapp_client: {
      conat_client: {
        terminalClient,
      },
    },
  }));

  jest.doMock("@cocalc/frontend/app-framework", () => {
    const accountStore = {
      get: (key: string) => (key === "terminal" ? Map() : undefined),
      on: jest.fn(),
      removeListener: jest.fn(),
    };
    const projectActions = {
      flag_file_activity: jest.fn(),
      open_file: jest.fn(),
      close_tab: jest.fn(),
      isTabClosed: jest.fn(() => false),
      open_directory: jest.fn(),
      get_store: jest.fn(() => projectStore),
    };
    return {
      redux: {
        getStore: jest.fn(() => accountStore),
        getProjectActions: jest.fn(() => projectActions),
      },
    };
  });

  jest.doMock("./themes", () => ({
    setTheme: jest.fn(),
  }));

  jest.doMock("../generic/client", () => ({
    touch: jest.fn(),
    touch_project: jest.fn(),
  }));

  jest.doMock("@cocalc/util/reuse-in-flight", () => ({
    reuseInFlight: (fn: any) => fn,
  }));

  jest.doMock("@cocalc/util/async-utils", () => ({
    asyncDebounce: (fn: any) => fn,
    asyncThrottle: (fn: any) => fn,
  }));

  const { Terminal } = require("./connected-terminal");
  return { Terminal, ptys: createdPtys, projectStore, terminalClient };
}

describe("connected terminal resizing", () => {
  it("swallows xterm resize failures during measureSize", async () => {
    const { Terminal } = loadTerminalModule();
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const actions = {
      project_id: "project-1",
      path: "/tmp/example.term",
      get_term_env: jest.fn(() => ({})),
      set_connection_status: jest.fn(),
      set_title: jest.fn(),
      set_error: jest.fn(),
      _tree_is_single_leaf: jest.fn(() => false),
      close_frame: jest.fn(),
      open_code_editor_frame: jest.fn(),
      _get_project_actions: jest.fn(() => ({
        flag_file_activity: jest.fn(),
        open_file: jest.fn(),
        close_tab: jest.fn(),
        isTabClosed: jest.fn(() => false),
        open_directory: jest.fn(),
      })),
    } as any;

    const terminal = new Terminal(actions, 0, "term-1", parent);
    await Promise.resolve();
    terminal.is_visible = true;
    terminal["pty"] = {
      socket: { state: "ready" },
      resize: jest.fn(async () => {}),
      sizes: jest.fn(async () => []),
    };

    terminal["fitAddon"].proposeDimensions = jest.fn(() => ({
      rows: 24,
      cols: 80,
    }));
    terminal["terminal"].resize = jest.fn(() => {
      throw new Error("xterm resize failed");
    });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    await expect(terminal.measureSize()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "Error resizing terminal",
      expect.any(Error),
      24,
      80,
    );

    warn.mockRestore();
  });
});
