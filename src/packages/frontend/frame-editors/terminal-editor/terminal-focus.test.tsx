/** @jest-environment jsdom */

import { Map } from "immutable";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { TerminalFrame } from "./terminal";

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
