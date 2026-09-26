/** @jest-environment jsdom */

import { Map } from "immutable";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { TerminalFrame } from "./terminal";
import { TerminalManager } from "./terminal-manager";

jest.mock("@cocalc/frontend/course", () => ({
  useStudentProjectFunctionality: () => ({}),
}));

jest.mock("use-resize-observer", () => ({
  __esModule: true,
  default: () => ({}),
}));

describe("TerminalFrame focus sync", () => {
  it("reports focus events back to the frame tree", () => {
    const onFocus = jest.fn();
    const { container } = render(
      <TerminalFrame
        actions={{ _get_terminal: jest.fn() }}
        desc={Map()}
        editor_state={Map()}
        font_size={14}
        id="term-frame"
        is_current={false}
        is_visible={false}
        name="TerminalEditor"
        onFocus={onFocus}
        path="/tmp/example.term"
        project_id="project-1"
        resize={0}
        terminal={Map()}
      />,
    );

    const node = container.querySelector(".cocalc-xtermjs");
    if (!(node instanceof HTMLElement)) {
      throw Error("expected terminal DOM wrapper");
    }
    fireEvent.focus(node);

    expect(onFocus).toHaveBeenCalled();
  });

  it("reclaims a shared terminal on foreground and does not detach a newer view on unmount", async () => {
    const terminal = {
      element: document.createElement("div"),
      is_visible: false,
      usesNativeTouchSelection: () => false,
      getOption: () => 14,
      measureSize: jest.fn(),
      focus: jest.fn(),
    };
    const actions = {
      _get_terminal: jest.fn(async (_id, node) => {
        node.appendChild(terminal.element);
        return terminal;
      }),
    };
    const props = {
      actions,
      desc: Map(),
      editor_state: Map(),
      font_size: 14,
      id: "term-shared",
      is_current: false,
      name: "TerminalEditor",
      onFocus: jest.fn(),
      path: "agent.chat",
      project_id: "project-1",
      resize: 0,
      terminal: Map(),
    };
    const first = render(<TerminalFrame {...props} is_visible />);
    await waitFor(() => expect(terminal.is_visible).toBe(true));
    first.rerender(<TerminalFrame {...props} is_visible={false} />);
    const second = render(<TerminalFrame {...props} is_visible />);
    await waitFor(() =>
      expect(second.container).toContainElement(terminal.element),
    );
    first.unmount();
    expect(second.container).toContainElement(terminal.element);
    expect(terminal.is_visible).toBe(true);

    second.rerender(<TerminalFrame {...props} is_visible={false} />);
    const third = render(<TerminalFrame {...props} is_visible />);
    await waitFor(() =>
      expect(third.container).toContainElement(terminal.element),
    );
    third.rerender(<TerminalFrame {...props} is_visible={false} />);
    second.rerender(<TerminalFrame {...props} is_visible />);
    await waitFor(() =>
      expect(second.container).toContainElement(terminal.element),
    );
    third.unmount();
    expect(second.container).toContainElement(terminal.element);
    expect(terminal.is_visible).toBe(true);
  });

  it("does not detach a shared terminal when an obsolete load completes", async () => {
    const terminal = {
      element: document.createElement("div"),
      is_visible: false,
      usesNativeTouchSelection: () => false,
      getOption: () => 14,
      measureSize: jest.fn(),
      focus: jest.fn(),
    };
    let finishFirst!: () => void;
    const actions = {
      _get_terminal: jest
        .fn()
        .mockImplementationOnce((_id, node) => {
          node.appendChild(terminal.element);
          return new Promise((resolve) => {
            finishFirst = () => resolve(terminal);
          });
        })
        .mockImplementation(async (_id, node) => {
          node.appendChild(terminal.element);
          return terminal;
        }),
    };
    const props = {
      actions,
      desc: Map(),
      editor_state: Map(),
      font_size: 14,
      id: "term-shared",
      is_current: false,
      name: "TerminalEditor",
      onFocus: jest.fn(),
      path: "agent.chat",
      project_id: "project-1",
      resize: 0,
      terminal: Map(),
    };
    const first = render(<TerminalFrame {...props} is_visible />);
    first.unmount();
    const second = render(<TerminalFrame {...props} is_visible />);
    await waitFor(() => expect(terminal.is_visible).toBe(true));
    await act(async () => finishFirst());
    expect(second.container).toContainElement(terminal.element);
    expect(terminal.is_visible).toBe(true);
  });
});

function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function fakeTerminal(label: string) {
  const element = document.createElement("div");
  const input = document.createElement("textarea");
  input.setAttribute("aria-label", label);
  element.appendChild(input);
  return {
    element,
    input,
    is_visible: false,
    usesNativeTouchSelection: () => false,
    getOption: () => 14,
    measureSize: jest.fn(),
    focus: jest.fn(() => input.focus()),
    set_terminal_theme_override: jest.fn(),
  };
}

const frameProps = {
  desc: Map(),
  editor_state: Map(),
  font_size: 14,
  id: "shared",
  is_current: true,
  is_visible: true,
  name: "TerminalEditor",
  path: "agent.chat",
  project_id: "project-1",
  resize: 0,
  terminal: Map(),
};

describe("TerminalFrame late attachment", () => {
  it("only claims a shared editor's terminal in its visible tab", async () => {
    const terminal = fakeTerminal("Shared shell");
    const actions = {
      _get_terminal: jest.fn(async (_id, node) => {
        node.appendChild(terminal.element);
        return terminal;
      }),
    };
    const first = render(
      <TerminalFrame {...frameProps} actions={actions} tab_is_visible />,
    );
    await waitFor(() => expect(terminal.input).toHaveFocus());
    const second = render(
      <TerminalFrame
        {...frameProps}
        actions={actions}
        tab_is_visible={false}
      />,
    );
    expect(actions._get_terminal).toHaveBeenCalledTimes(1);
    expect(first.container).toContainElement(terminal.element);
    first.rerender(
      <TerminalFrame
        {...frameProps}
        actions={actions}
        tab_is_visible={false}
      />,
    );
    second.rerender(
      <TerminalFrame {...frameProps} actions={actions} tab_is_visible />,
    );
    await waitFor(() =>
      expect(second.container).toContainElement(terminal.element),
    );
    first.unmount();
    expect(terminal.input).toHaveFocus();
    expect(terminal.is_visible).toBe(true);
  });

  it("removes an obsolete session attached after a hidden frame changes ID", async () => {
    const old = fakeTerminal("Old shell");
    const next = fakeTerminal("New shell");
    const load = pending<void>();
    const actions = {
      _get_terminal: async (id, node) => {
        if (id === "old") await load.promise;
        const terminal = id === "old" ? old : next;
        node.appendChild(terminal.element);
        return terminal;
      },
    };
    const view = (id, visible) => (
      <TerminalFrame
        {...frameProps}
        actions={actions}
        id={id}
        is_visible={visible}
      />
    );
    const rendered = render(view("old", true));
    rendered.rerender(view("old", false));
    rendered.rerender(view("new", false));
    rendered.rerender(view("new", true));
    await waitFor(() => expect(next.input).toHaveFocus());
    await act(async () => load.resolve());
    expect(rendered.getAllByRole("textbox")).toEqual([next.input]);
    expect(old.element.parentElement).toBeNull();
    expect(next.input).toHaveFocus();
    expect(old.focus).not.toHaveBeenCalled();
  });

  it.each(["first", "second"])(
    "keeps the surviving owner when the %s shared cold-load waiter unmounts",
    async (removed) => {
      const terminal = fakeTerminal("Shared shell");
      const load = pending<any>();
      const manager = new TerminalManager({
        _get_frame_node: () => undefined,
      } as any);
      // Use the real manager's per-waiter .then attachment, not an eager mock.
      (manager as any).terminalLoads.shared = load.promise;
      const actions = { _get_terminal: manager.get_terminal.bind(manager) };
      const first = render(<TerminalFrame {...frameProps} actions={actions} />);
      const second = render(
        <TerminalFrame {...frameProps} actions={actions} />,
      );
      const survivor = removed === "first" ? second : first;
      (removed === "first" ? first : second).unmount();
      await act(async () => load.resolve(terminal));
      expect(
        survivor.getByRole("textbox", { name: "Shared shell" }),
      ).toHaveFocus();
      expect(terminal.element.isConnected).toBe(true);
      expect(terminal.is_visible).toBe(true);
    },
  );

  it("does not steal focus when selection changes during a load", async () => {
    const terminal = fakeTerminal("Shell");
    const load = pending<void>();
    const actions = {
      _get_terminal: async (_id, node) => {
        await load.promise;
        node.appendChild(terminal.element);
        return terminal;
      },
    };
    const view = (current) => (
      <>
        <input aria-label="Composer" />
        <TerminalFrame {...frameProps} actions={actions} is_current={current} />
      </>
    );
    const rendered = render(view(true));
    rendered.rerender(view(false));
    rendered.getByRole("textbox", { name: "Composer" }).focus();
    await act(async () => load.resolve());
    expect(rendered.getByRole("textbox", { name: "Composer" })).toHaveFocus();
    expect(terminal.focus).not.toHaveBeenCalled();
  });
});
