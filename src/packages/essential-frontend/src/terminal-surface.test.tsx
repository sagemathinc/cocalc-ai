/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AccountProjectListWindowRow } from "@cocalc/conat/hub/api/projects";
import type { UltraliteSession } from "./session";
import { EssentialThemeProvider } from "./theme-context";
import { ThemeControl } from "./ui";

let mockXtermOnData: ((data: string) => void) | undefined;
let mockXtermOnKey: ((event: { key: string }) => void) | undefined;
let mockXtermOptions: { theme?: unknown } | undefined;
let mockXtermConstructCount = 0;

jest.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    options: { theme?: unknown };
    rows = 24;
    constructor(options: { theme?: unknown }) {
      mockXtermConstructCount += 1;
      this.options = options;
      mockXtermOptions = options;
    }
    dispose() {}
    focus() {}
    loadAddon() {}
    open(host: HTMLElement) {
      host.dataset.xtermOpened = "true";
    }
    reset() {}
    paste(data: string) {
      mockXtermOnData?.(data);
    }
    write(_data: string, callback?: () => void) {
      callback?.();
    }
    onData(callback: (data: string) => void) {
      mockXtermOnData = callback;
      return { dispose: jest.fn() };
    }
    onKey(callback: (event: { key: string }) => void) {
      mockXtermOnKey = callback;
      return { dispose: jest.fn() };
    }
  },
}));

jest.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

jest.mock("@cocalc/conat/project/terminal", () => ({
  terminalClient: jest.fn(),
}));

const {
  terminalClient: mockTerminalClient,
} = require("@cocalc/conat/project/terminal");
const {
  default: TerminalSurface,
  extractTerminalAutoResponses,
  terminalThemeFor,
  writeTerminalInput,
} = require("./terminal-surface");

const project = {
  host_id: "33333333-3333-4333-8333-333333333333",
  project_id: "11111111-1111-4111-8111-111111111111",
  title: "Test project",
} as AccountProjectListWindowRow;

function makeSession(state = "stopped") {
  const socketHandlers: Record<string, (...args: any[]) => void> = {};
  const terminalHandlers: Record<string, (...args: any[]) => void> = {};
  const terminal = {
    close: jest.fn(),
    on: jest.fn((event: string, callback: (...args: any[]) => void) => {
      terminalHandlers[event] = callback;
    }),
    resize: jest.fn(async () => undefined),
    socket: {
      on: jest.fn((event: string, callback: (...args: any[]) => void) => {
        socketHandlers[event] = callback;
      }),
      state: "ready",
      write: jest.fn(),
    },
    spawn: jest.fn(async () => "prior output\r\n"),
  };
  const getProjectState = jest.fn(async () => ({ state }));
  const ensureProjectRunning = jest.fn(async (_id, onState) => {
    onState?.("Project is starting...");
  });
  const openProjectHost = jest.fn(async () => ({ client: {} }));
  mockTerminalClient.mockReturnValue(terminal);
  const session = {
    accountId: "22222222-2222-4222-8222-222222222222",
    ensureProjectRunning,
    getProjectState,
    openProjectHost,
  } as unknown as UltraliteSession;
  return {
    ensureProjectRunning,
    getProjectState,
    openProjectHost,
    session,
    socketHandlers,
    terminal,
    terminalHandlers,
  };
}

beforeAll(() => {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      disconnect = jest.fn();
      observe = jest.fn();
    },
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockXtermOnData = undefined;
  mockXtermOnKey = undefined;
  mockXtermOptions = undefined;
  mockXtermConstructCount = 0;
  window.localStorage.clear();
});

test("provides legible light and dark terminal palettes", () => {
  expect(terminalThemeFor("light")).toEqual(
    expect.objectContaining({
      background: "white",
      foreground: "#303030",
    }),
  );
  expect(terminalThemeFor("dark")).toEqual(
    expect.objectContaining({
      background: "#303030",
      foreground: "#eeeeee",
    }),
  );
});

test("extracts only complete xterm protocol responses", () => {
  expect(extractTerminalAutoResponses("ordinary keyboard input")).toEqual({
    remaining: "",
    responses: [],
  });
  expect(extractTerminalAutoResponses("\u001b[12;34R")).toEqual({
    remaining: "",
    responses: ["\u001b[12;34R"],
  });
  expect(extractTerminalAutoResponses("\u001b]10;rgb:ffff/ffff/ffff")).toEqual({
    remaining: "\u001b]10;rgb:ffff/ffff/ffff",
    responses: [],
  });
  expect(
    extractTerminalAutoResponses("\u001b]10;rgb:ffff/ffff/ffff\u0007"),
  ).toEqual({
    remaining: "",
    responses: ["\u001b]10;rgb:ffff/ffff/ffff\u0007"],
  });
});

test("viewing Terminal never starts project compute or creates a PTY", async () => {
  const { ensureProjectRunning, openProjectHost, session } = makeSession();
  render(<TerminalSurface project={project} session={session} />);

  await screen.findByText(/This project is stopped/);
  expect(
    screen.getByRole("application", { name: "Project terminal" }),
  ).toHaveAttribute("data-xterm-opened", "true");
  expect(mockXtermOptions?.theme).toEqual(terminalThemeFor("light"));
  expect(
    screen.getByRole("button", { name: "Connect terminal" }),
  ).toBeEnabled();
  expect(
    screen.queryByRole("toolbar", { name: "Mobile terminal controls" }),
  ).not.toBeInTheDocument();
  expect(ensureProjectRunning).not.toHaveBeenCalled();
  expect(openProjectHost).not.toHaveBeenCalled();
  expect(mockTerminalClient).not.toHaveBeenCalled();
});

test("switches a mounted terminal theme without recreating it", async () => {
  const { session } = makeSession();
  render(
    <EssentialThemeProvider>
      <ThemeControl />
      <TerminalSurface project={project} session={session} />
    </EssentialThemeProvider>,
  );

  await screen.findByText(/This project is stopped/);
  expect(mockXtermConstructCount).toBe(1);
  fireEvent.change(screen.getByRole("combobox", { name: "Color theme" }), {
    target: { value: "dark" },
  });
  expect(mockXtermOptions?.theme).toEqual(terminalThemeFor("dark"));
  expect(mockXtermConstructCount).toBe(1);
});

test("a canceled start confirmation leaves the stopped project unchanged", async () => {
  const confirm = jest.spyOn(window, "confirm").mockReturnValue(false);
  const { ensureProjectRunning, openProjectHost, session } = makeSession();
  render(<TerminalSurface project={project} session={session} />);
  await screen.findByText(/This project is stopped/);
  fireEvent.click(screen.getByRole("button", { name: "Connect terminal" }));

  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  expect(ensureProjectRunning).not.toHaveBeenCalled();
  expect(openProjectHost).not.toHaveBeenCalled();
  expect(mockTerminalClient).not.toHaveBeenCalled();
  confirm.mockRestore();
});

test("an approved connection starts compute and uses the direct terminal client", async () => {
  const confirm = jest.spyOn(window, "confirm").mockReturnValue(true);
  const {
    ensureProjectRunning,
    openProjectHost,
    session,
    socketHandlers,
    terminal,
  } = makeSession();
  render(<TerminalSurface project={project} session={session} />);
  await screen.findByText(/This project is stopped/);
  fireEvent.click(screen.getByRole("button", { name: "Connect terminal" }));

  await screen.findByRole("button", { name: "Disconnect" });
  expect(
    screen.getByRole("toolbar", { name: "Mobile terminal controls" }),
  ).toBeInTheDocument();
  expect(ensureProjectRunning).toHaveBeenCalledWith(
    project.project_id,
    expect.any(Function),
  );
  expect(openProjectHost).toHaveBeenCalledWith(
    project.project_id,
    project.host_id,
  );
  expect(mockTerminalClient).toHaveBeenCalledWith({
    client: {},
    getSize: expect.any(Function),
    project_id: project.project_id,
    reconnection: true,
  });
  expect(terminal.spawn).toHaveBeenCalledWith("bash", [], {
    cwd: "/home/user",
    env0: { COLORTERM: "truecolor", TERM: "xterm-256color" },
    id: "ultralite-22222222-2222-4222-8222-222222222222",
    historyLimit: 128 * 1024,
    timeout: 15_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  terminal.socket.write.mockClear();
  mockXtermOnData?.("a");
  socketHandlers.data?.("server output");
  mockXtermOnKey?.({ key: "x" });
  mockXtermOnData?.("x");
  mockXtermOnData?.("\u001b[1;2R");
  expect(terminal.socket.write.mock.calls).toEqual([
    [{ data: "a", kind: "user" }],
    [{ data: "x", kind: "user" }],
    [{ data: "\u001b[1;2R", kind: "auto" }],
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Control+C" }));
  expect(terminal.socket.write).toHaveBeenLastCalledWith({
    data: "\u0003",
    kind: "user",
  });
  writeTerminalInput(terminal, "ls\r");
  expect(terminal.socket.write).toHaveBeenCalledWith({
    data: "ls\r",
    kind: "user",
  });
  writeTerminalInput(terminal, "\u001b[1;2R", "auto");
  expect(terminal.socket.write).toHaveBeenLastCalledWith({
    data: "\u001b[1;2R",
    kind: "auto",
  });
  confirm.mockRestore();
});

test("a running project reconnects its retained terminal automatically", async () => {
  const { ensureProjectRunning, openProjectHost, session, terminal } =
    makeSession("running");
  render(<TerminalSurface project={project} session={session} />);

  await screen.findByRole("button", { name: "Disconnect" });
  expect(ensureProjectRunning).not.toHaveBeenCalled();
  expect(openProjectHost).toHaveBeenCalledWith(
    project.project_id,
    project.host_id,
  );
  expect(terminal.spawn).toHaveBeenCalledWith(
    "bash",
    [],
    expect.objectContaining({
      historyLimit: 128 * 1024,
      id: "ultralite-22222222-2222-4222-8222-222222222222",
    }),
  );
});
