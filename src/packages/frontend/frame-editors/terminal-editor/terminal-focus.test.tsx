/** @jest-environment jsdom */

import { Map } from "immutable";
import { fireEvent, render } from "@testing-library/react";
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
});
