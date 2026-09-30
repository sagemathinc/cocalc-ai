/** @jest-environment jsdom */

import { Map } from "immutable";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TerminalFrame } from "./terminal";
import { TerminalManager } from "./terminal-manager";

jest.mock("@cocalc/frontend/course", () => ({
  useStudentProjectFunctionality: () => ({}),
}));

jest.mock("use-resize-observer", () => ({
  __esModule: true,
  default: () => ({}),
}));

const mockReload = jest.fn();
jest.mock("@cocalc/frontend/app/frontend-build-monitor", () => ({
  ...jest.requireActual("@cocalc/frontend/app/frontend-build-monitor"),
  reloadForFrontendBuild: () => mockReload(),
}));

// The first load of the terminal chunk fails, like a dropped request.
let mockChunkLoads = 0;
jest.mock("./connected-terminal", () => {
  mockChunkLoads += 1;
  if (mockChunkLoads === 1) throw new Error("Loading chunk 95636 failed.");
  return {
    Terminal: class {
      element = document.createElement("div");
      constructor(_actions, _number, _id, parent: HTMLElement) {
        parent.appendChild(this.element);
      }
      connect() {}
      set_terminal_theme_override() {}
      unpause() {}
    },
  };
});

function fakeTerminal() {
  return {
    element: document.createElement("div"),
    is_visible: false,
    usesNativeTouchSelection: () => false,
    getOption: () => 14,
    measureSize: jest.fn(),
    focus: jest.fn(),
  };
}

const baseProps = {
  desc: Map(),
  editor_state: Map(),
  font_size: 14,
  id: "term-1",
  is_current: false,
  is_visible: true,
  name: "TerminalEditor",
  path: "agent.chat",
  project_id: "project-1",
  resize: 0,
  terminal: Map(),
};

beforeEach(() => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

test("a failed open shows an error that Retry recovers from", async () => {
  const terminal = fakeTerminal();
  const actions = {
    _get_terminal: jest
      .fn()
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockImplementation(async (_id, node) => {
        node.appendChild(terminal.element);
        return terminal;
      }),
  };
  const { container } = render(
    <TerminalFrame {...baseProps} actions={actions} />,
  );
  await screen.findByText(/Terminal failed to open: socket closed/);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(container).toContainElement(terminal.element));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(terminal.is_visible).toBe(true);
});

test("an open that silently yields no terminal is reported, not left blank", async () => {
  const actions = { _get_terminal: jest.fn(async () => undefined) };
  render(<TerminalFrame {...baseProps} actions={actions} />);
  await screen.findByText(/The terminal did not start/);
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});

test("chunk failures keep keyboard Retry before offering a page reload", async () => {
  const user = userEvent.setup();
  const err = Object.assign(new Error("Loading chunk 95636 failed."), {
    name: "ChunkLoadError",
  });
  const actions = { _get_terminal: jest.fn().mockRejectedValue(err) };
  render(<TerminalFrame {...baseProps} actions={actions} />);
  await screen.findByText(/Terminal code failed to load/);
  expect(screen.queryByRole("button", { name: "Reload page" })).toBeNull();
  const retry = screen.getByRole("button", { name: "Retry" });
  retry.focus();
  expect(retry).toHaveFocus();
  await user.keyboard("{Enter}");
  await screen.findByRole("button", { name: "Reload page" });
  expect(actions._get_terminal).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  screen.getByRole("button", { name: "Retry" }).focus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Reload page" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(mockReload).toHaveBeenCalled();
});

test("the terminal manager retries a failed chunk load", async () => {
  const actions = {
    project_id: "project-1",
    path: "agent.chat",
    _get_frame_node: () => Map({ type: "terminal" }),
    _get_leaf_ids: () => ({}),
    _get_tree: () => Map(),
    set_frame_tree: jest.fn(),
  };
  const manager = new TerminalManager(actions as any);
  const parent = document.createElement("div");
  await expect(manager.get_terminal("term-1", parent)).rejects.toThrow(
    /Loading chunk/,
  );
  const terminal = await manager.get_terminal("term-1", parent);
  expect(terminal).toBeDefined();
  expect(parent).toContainElement(terminal!.element);
});
