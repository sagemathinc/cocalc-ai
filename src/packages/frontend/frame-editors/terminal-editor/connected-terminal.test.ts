/** @jest-environment jsdom */

import { EventEmitter } from "events";
import { Map } from "immutable";

function loadTerminalModule({
  projectState = "running",
  project,
}: {
  projectState?: string;
  project?: any;
} = {}) {
  class MockProjectStore extends EventEmitter {
    private data = Map({
      status: Map({
        state: projectState,
      }),
      project_map: Map(project ? { "project-1": Map(project) } : {}),
    });

    get = (key: string) => this.data.get(key);
    getIn = (path: string[]) => this.data.getIn(path);
    get_state = () => this.data.getIn(["status", "state"]);
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
  const showProjectStartRequiredModal = jest.fn();
  const ensureProjectRunning = jest.fn(async () => {
    if (project?.autostart_enabled === false) {
      return false;
    }
    projectStore.setStatus("running");
    return true;
  });
  const reconnectResources: {
    requestReconnect: jest.Mock;
    close: jest.Mock;
  }[] = [];
  const registerReconnectResource = jest.fn(() => {
    const resource = {
      requestReconnect: jest.fn(),
      close: jest.fn(),
    };
    reconnectResources.push(resource);
    return resource;
  });

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
      write = jest.fn((_data: string, cb?: () => void) => cb?.());
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
        registerReconnectResource,
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
        getStore: jest.fn((name: string) =>
          name === "projects" ? projectStore : accountStore,
        ),
        getProjectsStore: jest.fn(() => projectStore),
        getProjectActions: jest.fn(() => projectActions),
      },
    };
  });

  jest.doMock("@cocalc/frontend/project/project-start-warning", () => ({
    classifyProjectReadinessUxSegment: jest.fn(() => ({
      segment: projectState === "running" ? "warm" : "autostart",
      initial_state: projectState,
    })),
    ensure_project_running: ensureProjectRunning,
  }));

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
  return {
    Terminal,
    ptys: createdPtys,
    projectStore,
    terminalClient,
    showProjectStartRequiredModal,
    ensureProjectRunning,
    reconnectResources,
    registerReconnectResource,
  };
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

  it("routes terminal socket reconnects through the shared reconnect coordinator", async () => {
    const { Terminal, ptys, reconnectResources, terminalClient } =
      loadTerminalModule();
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
    await terminal.connect();

    expect(terminalClient).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "project-1",
      }),
    );
    expect(terminal["terminal"].write).toHaveBeenCalledWith(
      expect.stringContaining("Connecting terminal"),
      expect.any(Function),
    );
    expect(terminal["terminal"].write).toHaveBeenCalledWith(
      expect.stringContaining("Preparing your terminal session..."),
      expect.any(Function),
    );

    const disconnectedHandler = ptys
      .flatMap((pty) =>
        pty.socket.on.mock.calls
          .filter(([event]: [string]) => event === "disconnected")
          .map(([, handler]) => handler),
      )
      .at(0);

    expect(disconnectedHandler).toBeInstanceOf(Function);
    disconnectedHandler?.();

    expect(reconnectResources[0].requestReconnect).toHaveBeenCalledWith({
      reason: "terminal_socket_disconnected",
    });

    terminal.close();
  });

  it("preserves visible terminal content during transient reconnects", async () => {
    const { Terminal, ptys, reconnectResources } = loadTerminalModule();
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
    await terminal.connect();
    terminal["history"] = "user@host:~$ existing output\r\n";
    terminal["terminal"].write.mockClear();
    terminal["terminal"].reset.mockClear();

    const disconnectedHandler = ptys
      .flatMap((pty) =>
        pty.socket.on.mock.calls
          .filter(([event]: [string]) => event === "disconnected")
          .map(([, handler]) => handler),
      )
      .at(-1);

    expect(disconnectedHandler).toBeInstanceOf(Function);
    disconnectedHandler?.();

    expect(terminal.element.style.opacity).toBe("0.62");
    expect(reconnectResources[0].requestReconnect).toHaveBeenCalledWith({
      reason: "terminal_socket_disconnected",
    });

    await terminal.connect();

    expect(terminal["terminal"].write).not.toHaveBeenCalledWith(
      expect.stringContaining("Connecting terminal"),
      expect.any(Function),
    );
    expect(terminal["terminal"].reset).not.toHaveBeenCalled();
    expect(terminal.element.style.opacity).toBe("");

    terminal.close();
  });

  it("does not let new input overtake buffered disconnected input during reconnect", async () => {
    const { Terminal, ptys } = loadTerminalModule();
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
    await terminal.connect();

    ptys[0].socket.state = "closed";
    terminal["ptyInputReady"] = false;
    terminal.conn_write("git pu");

    let resolveSpawn: (history: string) => void = () => {};
    const spawnPromise = new Promise<string>((resolve) => {
      resolveSpawn = resolve;
    });
    ptys[1].spawn = jest.fn(() => spawnPromise);
    const reconnect = terminal.connect();
    await Promise.resolve();

    terminal.conn_write("sh");

    expect(ptys[1].socket.write).not.toHaveBeenCalled();

    resolveSpawn("");
    await reconnect;

    expect(ptys[1].socket.write.mock.calls.map(([message]) => message)).toEqual(
      [
        { data: "git pu", kind: "user" },
        { data: "sh", kind: "user" },
      ],
    );

    terminal.close();
  });

  it("expedites reconnect when a disconnected terminal becomes visible", async () => {
    const { Terminal, reconnectResources } = loadTerminalModule();
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
    await terminal.connect();
    terminal["pty"] = null;

    terminal.is_visible = true;

    expect(reconnectResources[0].requestReconnect).toHaveBeenCalledWith({
      reason: "terminal_became_visible",
      resetBackoff: true,
    });

    terminal.close();
  });

  it("shows an inline manual-start message instead of connecting when automatic starts are disabled", async () => {
    const { Terminal, terminalClient, ensureProjectRunning } =
      loadTerminalModule({
        projectState: "opened",
        project: { autostart_enabled: false },
      });
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

    const terminal = new Terminal(
      actions,
      0,
      "term-1",
      parent,
      undefined,
      undefined,
      undefined,
      undefined,
      { autoStartProjectOnFirstConnect: true },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await terminal.connect();

    expect(terminalClient).not.toHaveBeenCalled();
    expect(ensureProjectRunning).toHaveBeenCalledWith(
      "project-1",
      "use this terminal",
    );
    expect(actions.set_connection_status).toHaveBeenCalledWith(
      "term-1",
      "disconnected",
    );
    expect(terminal["terminal"].write).toHaveBeenCalledWith(
      expect.stringContaining("Project is stopped"),
      expect.any(Function),
    );
    expect(terminal["terminal"].write).toHaveBeenCalledWith(
      expect.stringContaining("Start the project to use this terminal."),
      expect.any(Function),
    );
    expect(terminal["terminal"].write).toHaveBeenCalledWith(
      expect.stringContaining("connect automatically"),
      expect.any(Function),
    );

    terminal.close();
  });

  it("autostarts and connects for a stopped project when automatic starts are enabled", async () => {
    const { Terminal, terminalClient, ensureProjectRunning, projectStore } =
      loadTerminalModule({
        projectState: "opened",
        project: { autostart_enabled: true },
      });
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

    const terminal = new Terminal(
      actions,
      0,
      "term-1",
      parent,
      undefined,
      undefined,
      undefined,
      undefined,
      { autoStartProjectOnFirstConnect: true },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await terminal.connect();

    expect(ensureProjectRunning).toHaveBeenCalledWith(
      "project-1",
      "use this terminal",
    );
    expect(terminalClient).toHaveBeenCalled();
    expect(terminal["terminal"].write).toHaveBeenCalledWith(
      expect.stringContaining("Connecting terminal"),
      expect.any(Function),
    );

    ensureProjectRunning.mockClear();
    terminalClient.mockClear();
    terminal["terminal"].write.mockClear();

    projectStore.setStatus("opened");
    await terminal.connect();

    expect(ensureProjectRunning).not.toHaveBeenCalled();
    expect(terminalClient).not.toHaveBeenCalled();
    expect(terminal["terminal"].write).toHaveBeenCalledWith(
      expect.stringContaining("Project is stopped"),
      expect.any(Function),
    );

    terminal.close();
  });

  it("waits during project startup and connects promptly when the project becomes running", async () => {
    let terminal: any;
    try {
      const { Terminal, terminalClient, projectStore, reconnectResources } =
        loadTerminalModule({
          projectState: "starting",
        });
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

      terminal = new Terminal(actions, 0, "term-1", parent);
      await Promise.resolve();

      expect(terminalClient).not.toHaveBeenCalled();

      projectStore.setStatus("running");
      await new Promise((resolve) => setTimeout(resolve, 1100));

      expect(terminalClient).toHaveBeenCalledWith(
        expect.objectContaining({
          project_id: "project-1",
        }),
      );
      expect(reconnectResources[0].requestReconnect).toHaveBeenCalledWith({
        reason: "project_became_running",
        resetBackoff: true,
      });
    } finally {
      terminal?.close();
    }
  });
});
