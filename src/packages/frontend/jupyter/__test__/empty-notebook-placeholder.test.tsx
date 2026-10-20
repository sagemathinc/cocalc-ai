/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// An empty notebook shows a placeholder and stores nothing until the user
// starts editing (support ticket 21023).

import { fireEvent, render, screen } from "@testing-library/react";

const frame = {
  set_cur_id: jest.fn(),
  set_mode: jest.fn(),
  set_input_editor_cursor: jest.fn(),
  enable_key_handler: jest.fn(),
  disable_key_handler: jest.fn(),
};

jest.mock(
  "@cocalc/frontend/frame-editors/jupyter-editor/cell-notebook/hook",
  () => ({
    __esModule: true,
    default: () => ({ current: frame }),
  }),
);

import { EmptyNotebookPlaceholder } from "../empty-notebook-placeholder";

function renderPlaceholder() {
  const actions: any = { createFirstCell: jest.fn(() => "alpha") };
  render(<EmptyNotebookPlaceholder actions={actions} />);
  return {
    actions,
    placeholder: screen.getByTestId("jupyter-empty-notebook-placeholder"),
  };
}

describe("EmptyNotebookPlaceholder", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("stores nothing just by being shown", () => {
    const { actions } = renderPlaceholder();
    expect(actions.createFirstCell).not.toHaveBeenCalled();
  });

  it("creates the first cell on click and edits it", () => {
    const { actions, placeholder } = renderPlaceholder();

    fireEvent.click(placeholder);

    expect(actions.createFirstCell).toHaveBeenCalledWith("");
    expect(frame.set_cur_id).toHaveBeenCalledWith("alpha");
    expect(frame.set_mode).toHaveBeenCalledWith("edit");
  });

  it("creates the first cell with a typed character and puts the cursor after it", () => {
    const { actions, placeholder } = renderPlaceholder();

    fireEvent.keyDown(placeholder, { key: "x" });
    jest.runAllTimers();

    expect(actions.createFirstCell).toHaveBeenCalledWith("x");
    expect(frame.set_input_editor_cursor).toHaveBeenCalledWith("alpha", {
      x: 1,
      y: 0,
    });
  });

  it("ignores modified keys and other non-text keys", () => {
    const { actions, placeholder } = renderPlaceholder();

    fireEvent.keyDown(placeholder, { key: "s", ctrlKey: true });
    fireEvent.keyDown(placeholder, { key: "ArrowDown" });

    expect(actions.createFirstCell).not.toHaveBeenCalled();
  });

  it("keeps the notebook's command shortcuts off while focused", () => {
    const { placeholder } = renderPlaceholder();

    fireEvent.focus(placeholder);
    expect(frame.disable_key_handler).toHaveBeenCalled();
    fireEvent.blur(placeholder);
    expect(frame.enable_key_handler).toHaveBeenCalled();
  });
});
