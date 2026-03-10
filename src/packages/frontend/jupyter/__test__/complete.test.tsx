import { Map, fromJS } from "immutable";
import { fireEvent, render, screen } from "@testing-library/react";

const saveInputEditor = jest.fn();
const setMode = jest.fn();
const jqueryFocus = jest.fn();
const useNotebookFrameActions = jest.fn(() => ({
  current: {
    save_input_editor: saveInputEditor,
    set_mode: setMode,
  },
}));

(global as any).$ = jest.fn(() => ({
  find: jest.fn(() => ({
    focus: jqueryFocus,
    data: jest.fn(),
  })),
}));

jest.mock(
  "@cocalc/frontend/frame-editors/jupyter-editor/cell-notebook/hook",
  () => () => useNotebookFrameActions(),
);

import { Complete } from "../complete";

describe("Jupyter completion menu", () => {
  beforeEach(() => {
    saveInputEditor.mockReset();
    setMode.mockReset();
    jqueryFocus.mockReset();
  });

  it("selects a completion on mouse down before blur can clear the menu", () => {
    const select_complete = jest.fn();
    const clear_complete = jest.fn();
    const focus_complete = jest.fn();
    jest.useFakeTimers();
    const complete = fromJS({
      matches: ["input"],
      offset: { top: 0, left: 0, gutter: 0 },
    }) as Map<string, any>;

    render(
      <Complete
        actions={{ select_complete, clear_complete, focus_complete }}
        id="cell-1"
        complete={complete}
      />,
    );

    fireEvent.mouseDown(screen.getByRole("menuitem", { name: "input" }));
    jest.runAllTimers();

    expect(saveInputEditor).toHaveBeenCalledWith("cell-1");
    expect(select_complete).toHaveBeenCalledWith("cell-1", "input");
    expect(focus_complete).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it("falls back to the first completion on enter if focus lookup is lost", () => {
    const select_complete = jest.fn();
    const clear_complete = jest.fn();
    const focus_complete = jest.fn();
    jest.useFakeTimers();
    const complete = fromJS({
      matches: ["input", "int"],
      offset: { top: 0, left: 0, gutter: 0 },
    }) as Map<string, any>;

    render(
      <Complete
        actions={{ select_complete, clear_complete, focus_complete }}
        id="cell-1"
        complete={complete}
      />,
    );

    fireEvent.keyDown(screen.getByRole("list"), { keyCode: 13 });
    jest.runAllTimers();

    expect(select_complete).toHaveBeenCalledWith("cell-1", "input");
    expect(focus_complete).toHaveBeenCalled();
    jest.useRealTimers();
  });
});
