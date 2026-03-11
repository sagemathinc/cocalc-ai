/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { create_key_handler } from "./keyboard";

describe("task editor keyboard shortcuts", () => {
  it("ignores shortcuts when a real input target has focus", () => {
    render(<input data-testid="filter" />);
    const input = screen.getByTestId("filter");
    input.focus();

    const actions = {
      isEditing: jest.fn(() => false),
      store: {
        get: jest.fn(() => false),
        getIn: jest.fn(() => "Custom"),
      },
      set_current_task_delta: jest.fn(),
      move_task_delta: jest.fn(),
      focus_find_box: jest.fn(),
      save: jest.fn(),
      new_task: jest.fn(),
      toggleHideBody: jest.fn(),
      edit_desc: jest.fn(),
    };

    const handler = create_key_handler(actions);
    const event = new KeyboardEvent("keydown", { bubbles: true, key: "j" });
    Object.defineProperty(event, "which", { value: 74 });
    Object.defineProperty(event, "keyCode", { value: 74 });
    Object.defineProperty(event, "target", { value: input });

    handler(event);

    expect(actions.set_current_task_delta).not.toHaveBeenCalled();
    expect(actions.move_task_delta).not.toHaveBeenCalled();
    expect(actions.focus_find_box).not.toHaveBeenCalled();
    expect(actions.save).not.toHaveBeenCalled();
    expect(actions.new_task).not.toHaveBeenCalled();
  });

  it("keeps task shortcuts active when a checkbox has focus", () => {
    render(<input data-testid="done" type="checkbox" />);
    const checkbox = screen.getByTestId("done");
    checkbox.focus();

    const actions = {
      isEditing: jest.fn(() => false),
      store: {
        get: jest.fn(() => false),
        getIn: jest.fn(() => "Custom"),
      },
      set_current_task_delta: jest.fn(),
      move_task_delta: jest.fn(),
      focus_find_box: jest.fn(),
      save: jest.fn(),
      new_task: jest.fn(),
      toggleHideBody: jest.fn(),
      edit_desc: jest.fn(),
    };

    const handler = create_key_handler(actions);
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      key: "s",
      ctrlKey: true,
    });
    Object.defineProperty(event, "which", { value: 83 });
    Object.defineProperty(event, "keyCode", { value: 83 });
    Object.defineProperty(event, "target", { value: checkbox });

    handler(event);

    expect(actions.save).toHaveBeenCalledTimes(1);
  });
});
