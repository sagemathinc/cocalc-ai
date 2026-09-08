import { fireEvent, render, screen } from "@testing-library/react";
import { fromJS } from "immutable";
import Task from "./task";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

jest.mock("./desc", () => ({
  Description: ({ editing }: { editing: boolean }) => (
    <button data-testid="task-desc" type="button">
      {editing ? "editing-desc" : "desc"}
    </button>
  ),
}));

jest.mock("./changed", () => ({
  Changed: () => <span>changed</span>,
}));

jest.mock("./due", () => ({
  DueDate: () => <span>due</span>,
}));

jest.mock("./drag", () => ({
  DragHandle: () => <span>drag</span>,
}));

jest.mock("./done", () => ({
  DoneCheckbox: () => <span>done</span>,
}));

jest.mock("./min-toggle", () => ({
  MinToggle: () => <span>min</span>,
}));

describe("Task", () => {
  beforeAll(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: jest.fn().mockImplementation(() => ({
        matches: false,
        media: "",
        onchange: null,
        addListener: jest.fn(),
        removeListener: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        dispatchEvent: jest.fn(),
      })),
    });
  });

  const task = fromJS({
    task_id: "task-1",
    desc: "Test task",
    deleted: false,
    done: false,
  });

  it.each([
    [{}, UI_COLORS.surface, UI_COLORS.text],
    [{ done: true }, UI_COLORS.surface, UI_COLORS.muted],
    [{ deleted: true }, UI_COLORS.dangerBg, UI_COLORS.danger],
    [{ color: "#ffffff" }, "rgb(255, 255, 255)", undefined],
  ])(
    "preserves semantic task colors and authored backgrounds: %j",
    (state, background, foreground) => {
      const { container } = render(
        <Task
          task={task.merge(state) as any}
          is_current={false}
          editing_desc={false}
          editing_due_date={false}
          font_size={14}
          selectedHashtags={new Set()}
        />,
      );
      const row = container.firstElementChild as HTMLElement;
      expect(row.style.background).toBe(background);
      if (foreground) expect(row.style.color).toBe(foreground);
    },
  );

  it("does not re-enable the global key handler while editing the description", () => {
    const actions = {
      enable_key_handler: jest.fn(),
      set_current_task: jest.fn(),
    } as any;

    render(
      <Task
        actions={actions}
        task={task as any}
        is_current
        editing_desc
        editing_due_date={false}
        font_size={14}
        selectedHashtags={new Set()}
      />,
    );

    fireEvent.click(screen.getByTestId("task-desc"));
    expect(actions.set_current_task).toHaveBeenCalledWith("task-1");
    expect(actions.enable_key_handler).not.toHaveBeenCalled();
  });

  it("re-enables the global key handler when the task is not being edited", () => {
    const actions = {
      enable_key_handler: jest.fn(),
      set_current_task: jest.fn(),
    } as any;

    render(
      <Task
        actions={actions}
        task={task as any}
        is_current
        editing_desc={false}
        editing_due_date={false}
        font_size={14}
        selectedHashtags={new Set()}
      />,
    );

    fireEvent.click(screen.getByTestId("task-desc"));
    expect(actions.set_current_task).toHaveBeenCalledWith("task-1");
    expect(actions.enable_key_handler).toHaveBeenCalled();
  });
});
