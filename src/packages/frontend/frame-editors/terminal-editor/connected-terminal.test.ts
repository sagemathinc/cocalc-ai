/** @jest-environment jsdom */

import { EventEmitter } from "events";
import { fromJS, Map } from "immutable";

function loadTerminalModule({
  projectState = "running",
  runtimeGeneration,
  runtimeRecoveryNotice,
  startLro,
  terminalSpawnError,
  project,
  socketState = "ready",
}: {
  projectState?: string;
  runtimeGeneration?: number;
  runtimeRecoveryNotice?: {
    id: string;
    reason:
      | "host_session_changed"
      | "project_runtime_changed"
      | "project_runtime_lost";
    occurred_at: number;
  };
  startLro?: any;
  terminalSpawnError?: Error;
  project?: any;
  socketState?: string;
} = {}) {
  class MockProjectStore extends EventEmitter {
    private data = Map({
      status: Map({
        state: projectState,
        runtime_generation: runtimeGeneration,
      }),
      project_map: Map(project ? { "project-1": Map(project) } : {}),
      runtime_recovery_notice: runtimeRecoveryNotice
        ? Map(runtimeRecoveryNotice)
        : undefined,
      start_lro: startLro ? fromJS(startLro) : undefined,
    });

    get = (key: string) => this.data.get(key);
    getIn = (path: string[]) => this.data.getIn(path);
    get_state = () => this.data.getIn(["status", "state"]);
    get_runtime_generation = () =>
      this.data.getIn(["status", "runtime_generation"]);
    setStatus = (state: string, nextRuntimeGeneration?: number) => {
      this.data = this.data.set(
        "status",
        Map({
          state,
          runtime_generation:
            nextRuntimeGeneration ??
            this.data.getIn(["status", "runtime_generation"]),
        }),
      );
      this.emit("change", this.data);
    };
  }

  const projectStore = new MockProjectStore();

  const makePty = () => ({
    socket: {
      state: socketState,
      on: jest.fn(),
      write: jest.fn(),
    },
    on: jest.fn(),
    once: jest.fn((_event: string, cb?: () => void) => cb?.()),
    spawn: jest.fn(async () => {
      if (terminalSpawnError != null) {
        throw terminalSpawnError;
      }
      return "";
    }),
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
  const alertMessage = jest.fn();
  const uxLatencyEvents = jest.fn();

  jest.resetModules();
  const appearance =
    require("@cocalc/util/appearance-store").createAppearanceStore();
  jest.doMock("@cocalc/util/appearance-browser", () => ({
    getBrowserAppearanceStore: () => appearance,
  }));

  jest.doMock("@xterm/xterm", () => {
    class MockTerminal {
      public options: Record<string, any>;
      public element: HTMLElement | null = null;
      public cols = 80;
      public rows = 24;
      public modes = { mouseTrackingMode: "none" };

      constructor(options: Record<string, any> = {}) {
        this.options = options;
      }

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
      hasSelection = jest.fn(() => false);
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

  jest.doMock("@cocalc/frontend/alerts", () => ({
    alert_message: alertMessage,
  }));

  jest.doMock("@cocalc/frontend/monitoring/ux-latency", () => ({
    ...jest.requireActual("@cocalc/frontend/monitoring/ux-latency"),
    recordUxLatencyEvent: uxLatencyEvents,
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
        getProjectStore: jest.fn(() => projectStore),
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

  jest.doMock("awaiting", () => ({
    callback: (fn: any) =>
      new Promise<void>((resolve, reject) => {
        try {
          fn((err?: unknown) => (err == null ? resolve() : reject(err)));
        } catch (err) {
          reject(err);
        }
      }),
    delay: jest.fn(async () => {}),
  }));

  jest.doMock("@cocalc/util/async-utils", () => ({
    asyncDebounce: (fn: any) => fn,
    asyncThrottle: (fn: any) => fn,
  }));

  const { Terminal } = require("./connected-terminal");
  return {
    Terminal,
    appearance,
    setTheme: require("./themes").setTheme,
    ptys: createdPtys,
    projectStore,
    terminalClient,
    showProjectStartRequiredModal,
    ensureProjectRunning,
    alertMessage,
    reconnectResources,
    registerReconnectResource,
    uxLatencyEvents,
  };
}

function makeActions() {
  return {
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
}

describe("connected terminal TUI selection", () => {
  it("updates a Follow palette without replacing the terminal, resetting it, or reconnecting", async () => {
    const { Terminal, appearance, setTheme, terminalClient } =
      loadTerminalModule();
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const terminal = new Terminal(makeActions(), 0, "term-1", parent);
    terminal.set_terminal_theme_override("follow-appearance");
    const xterm = terminal["terminal"];
    const element = xterm.element;
    const connections = terminalClient.mock.calls.length;
    setTheme.mockClear();
    await appearance.choose("dark");
    expect(setTheme).toHaveBeenLastCalledWith(xterm, "cocalc-dark");
    expect(xterm.element).toBe(element);
    expect(xterm.reset).not.toHaveBeenCalled();
    expect(xterm.dispose).not.toHaveBeenCalled();
    expect(terminalClient).toHaveBeenCalledTimes(connections);
    terminal.set_terminal_theme_override("cocalc-light");
    setTheme.mockClear();
    await appearance.choose("light");
    await appearance.choose("dark");
    expect(setTheme).not.toHaveBeenCalled();
    terminal.close();
    await expect(appearance.choose("light")).resolves.toBeUndefined();
    expect(setTheme).not.toHaveBeenCalled();
  });

  it("enables the macOS modifier override for application mouse mode", () => {
    const { Terminal } = loadTerminalModule();
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const terminal = new Terminal(makeActions(), 0, "term-1", parent);

    expect(terminal["terminal"].options.macOptionClickForcesSelection).toBe(
      true,
    );

    terminal.close();
  });

  it("handles uppercase copy shortcuts when xterm owns the selection", () => {
    const { Terminal, alertMessage } = loadTerminalModule();
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const terminal = new Terminal(makeActions(), 0, "term-1", parent);
    const xterm = terminal["terminal"];
    xterm.hasSelection.mockReturnValue(true);
    const handler = xterm.attachCustomKeyEventHandler.mock.calls[0][0];

    const handled = handler(
      new KeyboardEvent("keydown", {
        ctrlKey: true,
        key: "C",
        shiftKey: true,
      }),
    );

    expect(handled).toBe(false);
    expect(alertMessage).not.toHaveBeenCalled();

    terminal.close();
  });

  it("explains forced selection without stealing Ctrl+C from a TUI", () => {
    const { Terminal, alertMessage } = loadTerminalModule();
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const terminal = new Terminal(makeActions(), 0, "term-1", parent);
    const xterm = terminal["terminal"];
    xterm.modes.mouseTrackingMode = "any";
    const handler = xterm.attachCustomKeyEventHandler.mock.calls[0][0];
    const copyEvent = new KeyboardEvent("keydown", {
      ctrlKey: true,
      key: "c",
    });

    expect(handler(copyEvent)).toBe(true);
    expect(handler(copyEvent)).toBe(true);
    expect(alertMessage).toHaveBeenCalledTimes(1);
    expect(alertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        title: "Copy terminal text",
        message: expect.stringContaining("Shift"),
      }),
    );

    terminal.close();
  });

  it("leaves ordinary Ctrl+C alone outside application mouse mode", () => {
    const { Terminal, alertMessage } = loadTerminalModule();
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const terminal = new Terminal(makeActions(), 0, "term-1", parent);
    const xterm = terminal["terminal"];
    const handler = xterm.attachCustomKeyEventHandler.mock.calls[0][0];

    expect(
      handler(
        new KeyboardEvent("keydown", {
          ctrlKey: true,
          key: "c",
        }),
      ),
    ).toBe(true);
    expect(alertMessage).not.toHaveBeenCalled();

    terminal.close();
  });
});

describe("connected terminal resizing", () => {
  it("records input readiness only after spawn and socket readiness", async () => {
    const { Terminal, ptys, terminalClient, uxLatencyEvents } =
      loadTerminalModule({
        socketState: "connecting",
      });
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const terminal = new Terminal(makeActions(), 0, "term-1", parent);

    await terminal.connect();

    const lifecycleReporter = terminalClient.mock.calls[0][0].lifecycleReporter;
    lifecycleReporter("transport_wait_start", {
      transport_connected: false,
    });
    lifecycleReporter("transport_wait_done", {
      transport_connected: true,
    });
    lifecycleReporter("connect_command_start");
    lifecycleReporter("connect_command_start");
    lifecycleReporter("connect_command_done", {
      response_wait_ms: 120,
      wait_for_client_interest_ms: 80,
      server_id: "must-not-be-recorded",
    });

    expect(
      uxLatencyEvents.mock.calls.some(
        ([event]) => event.metric === "terminal_input_ready_v2",
      ),
    ).toBe(false);

    // The editor becomes visible after its connection starts during tab mount.
    terminal.is_visible = true;
    ptys[0].socket.state = "ready";
    const ready = ptys[0].socket.on.mock.calls.find(
      ([event]: [string]) => event === "ready",
    )?.[1];
    ready();

    expect(uxLatencyEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "terminal",
        metric: "terminal_input_ready_v2",
        details: expect.objectContaining({
          trace_version: 2,
          readiness_observer: "spawn_complete_and_socket_ready",
          socket_lifecycle_counts: expect.objectContaining({
            connect_command_start: 2,
            transport_wait_start: 1,
          }),
          marks: expect.objectContaining({
            socket_transport_wait_start_first: expect.any(Number),
            socket_connect_command_done: expect.any(Number),
          }),
          phase_details: expect.objectContaining({
            socket_connect_command_done: {
              attempt: 1,
              response_wait_ms: 120,
              wait_for_client_interest_ms: 80,
            },
          }),
        }),
      }),
    );
    terminal.close();
  });

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
    const {
      Terminal,
      ptys,
      reconnectResources,
      terminalClient,
      registerReconnectResource,
    } = loadTerminalModule();
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
    terminal.is_visible = true;
    await terminal.connect();

    expect(terminalClient).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "project-1",
      }),
    );

    const reconnectOptions = registerReconnectResource.mock.calls[0][0];
    expect(reconnectOptions.probeOnForeground()).toBe(true);
    terminalClient.mockClear();
    await reconnectOptions.reconnect();
    expect(ptys[0].state).toHaveBeenCalled();
    expect(terminalClient).not.toHaveBeenCalled();

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

  it("restores input when the existing terminal socket recovers", async () => {
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
    terminal["history"] = "user@host:~$ existing output\r\n";
    actions.set_connection_status.mockClear();
    terminalClient.mockClear();

    const socketHandler = (event: string) =>
      ptys[0].socket.on.mock.calls
        .filter(([name]: [string]) => name === event)
        .map(([, handler]) => handler)
        .at(-1);
    const disconnectedHandler = socketHandler("disconnected");
    const recoveredHandler = socketHandler("recovered");

    ptys[0].socket.state = "disconnected";
    disconnectedHandler?.();
    terminal.conn_write("echo recovered\n");

    expect(ptys[0].socket.write).not.toHaveBeenCalled();
    expect(terminal.element.style.opacity).toBe("0.62");
    expect(reconnectResources[0].requestReconnect).toHaveBeenCalledWith({
      reason: "terminal_input_not_ready",
      resetBackoff: true,
    });

    ptys[0].socket.state = "ready";
    recoveredHandler?.();

    expect(ptys[0].socket.write).toHaveBeenCalledWith({
      data: "echo recovered\n",
      kind: "user",
    });
    expect(actions.set_connection_status).toHaveBeenLastCalledWith(
      "term-1",
      "connected",
    );
    expect(terminal.element.style.opacity).toBe("");
    expect(terminalClient).not.toHaveBeenCalled();

    terminal.close();
  });

  it("restores input when project output resumes after a missed socket event", async () => {
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
    terminal["history"] = "user@host:~$ existing output\r\n";

    const socketHandler = (event: string) =>
      ptys[0].socket.on.mock.calls
        .filter(([name]: [string]) => name === event)
        .map(([, handler]) => handler)
        .at(-1);

    ptys[0].socket.state = "disconnected";
    socketHandler("disconnected")?.();
    terminal.conn_write("queued input");
    ptys[0].socket.state = "ready";
    socketHandler("data")?.("kk");
    await Promise.resolve();

    expect(ptys[0].socket.write).toHaveBeenCalledWith({
      data: "queued input",
      kind: "user",
    });
    expect(actions.set_connection_status).toHaveBeenLastCalledWith(
      "term-1",
      "connected",
    );
    expect(terminal.element.style.opacity).toBe("");

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

  it("reattaches the frontend socket when initial terminal output never arrives", async () => {
    jest.useFakeTimers();
    try {
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
      terminal.is_visible = true;
      await terminal.connect();

      actions.set_connection_status.mockClear();
      reconnectResources[0].requestReconnect.mockClear();

      jest.advanceTimersByTime(15000);
      await Promise.resolve();

      expect(ptys[0].close).toHaveBeenCalled();
      expect(ptys[0].destroy).not.toHaveBeenCalled();
      expect(actions.set_connection_status).toHaveBeenCalledWith(
        "term-1",
        "disconnected",
      );
      expect(reconnectResources[0].requestReconnect).toHaveBeenCalledWith({
        reason: "terminal_initial_output_timeout",
        resetBackoff: true,
      });
      expect(terminal["pty"]).toBeNull();

      terminal.close();
    } finally {
      jest.useRealTimers();
    }
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

  it("waits for an active RootFS start before lifecycle state catches up", async () => {
    const { Terminal, terminalClient, reconnectResources } = loadTerminalModule(
      {
        projectState: "opened",
        startLro: {
          summary: { status: "running" },
          last_progress: { phase: "cache_rootfs" },
        },
      },
    );
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const terminal = new Terminal(makeActions(), 0, "term-1", parent);

    await terminal.connect();

    expect(terminalClient).not.toHaveBeenCalled();
    expect(reconnectResources[0].requestReconnect).not.toHaveBeenCalled();
    expect(terminal["terminal"].write).toHaveBeenCalledWith(
      expect.stringContaining("Preparing project image"),
      expect.any(Function),
    );
    expect(terminal["terminal"].write).toHaveBeenCalledWith(
      expect.stringContaining("connect automatically"),
      expect.any(Function),
    );

    terminal.close();
  });

  it("treats a RootFS spawn race as preparation instead of a reconnect failure", async () => {
    const { Terminal, ptys, reconnectResources } = loadTerminalModule({
      terminalSpawnError: new Error(
        "rootfs is not mounted; cannot access absolute path '/home'. Start the project and try again.",
      ),
    });
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const terminal = new Terminal(makeActions(), 0, "term-1", parent);

    await terminal.connect();

    expect(ptys[0].close).toHaveBeenCalled();
    expect(terminal["pty"]).toBeNull();
    expect(reconnectResources[0].requestReconnect).not.toHaveBeenCalled();
    expect(terminal["terminal"].write).toHaveBeenCalledWith(
      expect.stringContaining("Preparing project image"),
      expect.any(Function),
    );

    terminal.close();
  });

  it("keeps first-connect autostart intent while project startup is in progress", async () => {
    let terminal: any;
    try {
      const { Terminal, terminalClient, ensureProjectRunning, projectStore } =
        loadTerminalModule({
          projectState: "starting",
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

      terminal = new Terminal(
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

      await terminal.connect();

      expect(terminalClient).not.toHaveBeenCalled();
      expect(ensureProjectRunning).not.toHaveBeenCalled();

      projectStore.setStatus("opened");
      await terminal.connect();

      expect(ensureProjectRunning).toHaveBeenCalledWith(
        "project-1",
        "use this terminal",
      );
      expect(terminalClient).toHaveBeenCalledWith(
        expect.objectContaining({
          project_id: "project-1",
        }),
      );
    } finally {
      terminal?.close();
    }
  });

  it("disconnects the stale pty when a running project enters restart startup", async () => {
    let terminal: any;
    try {
      const { Terminal, ptys, projectStore } = loadTerminalModule({
        projectState: "running",
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
      await terminal.connect();
      expect(ptys[0].close).not.toHaveBeenCalled();

      projectStore.setStatus("starting");

      expect(ptys[0].close).toHaveBeenCalled();
      expect(actions.set_connection_status).toHaveBeenCalledWith(
        "term-1",
        "disconnected",
      );
    } finally {
      terminal?.close();
    }
  });

  it("reconnects immediately when the project runtime is replaced", async () => {
    let terminal: any;
    try {
      const { Terminal, ptys, projectStore, reconnectResources } =
        loadTerminalModule({
          projectState: "running",
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
      await terminal.connect();
      expect(ptys[0].close).not.toHaveBeenCalled();

      projectStore.emit("runtime-recovery", {
        id: "project-1:runtime-2",
        reason: "project_runtime_changed",
        occurred_at: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(ptys[0].close).toHaveBeenCalled();
      expect(actions.set_connection_status).toHaveBeenCalledWith(
        "term-1",
        "disconnected",
      );
      expect(reconnectResources[0].requestReconnect).toHaveBeenCalledWith({
        reason: "project_runtime_changed",
        resetBackoff: true,
      });
      expect(terminal["terminal"].write).toHaveBeenCalledWith(
        expect.stringContaining("Project restarted"),
        expect.any(Function),
      );
    } finally {
      terminal?.close();
    }
  });

  it("ignores a project-host session replacement notice", async () => {
    const { Terminal } = loadTerminalModule({
      runtimeRecoveryNotice: {
        id: "host-1:session-2",
        reason: "host_session_changed",
        occurred_at: Date.now(),
      },
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
      _get_project_actions: jest.fn(() => ({})),
    } as any;

    const terminal = new Terminal(actions, 0, "term-1", parent);
    await terminal.connect();

    expect(terminal["terminal"].write).not.toHaveBeenCalledWith(
      expect.stringContaining("Project host reconnected"),
      expect.any(Function),
    );
    terminal.close();
  });

  it("ignores delayed option updates after the terminal closes", () => {
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
      _get_project_actions: jest.fn(() => ({})),
    } as any;

    const terminal = new Terminal(actions, 0, "term-1", parent);
    terminal.close();

    expect(() => terminal.set_font_size(18)).not.toThrow();
    expect(() => terminal.set_terminal_theme_override("default")).not.toThrow();
    expect(terminal.getOption("fontSize")).toBeUndefined();
  });
});
