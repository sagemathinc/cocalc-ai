import { Map } from "immutable";
import { create_key_handler } from "./keyboard";
import { HEADINGS } from "./headings-info";

describe("task keyboard shortcuts", () => {
  it("does not reorder tasks in read-only mode", () => {
    const move_task_delta = jest.fn();
    const set_current_task_delta = jest.fn();
    const handler = create_key_handler({
      isEditing: () => false,
      store: {
        get: (key: string) => key === "read_only",
        getIn: (path: string[]) =>
          path.join(".") === "local_view_state.sort.column"
            ? HEADINGS[0]
            : undefined,
      },
      move_task_delta,
      set_current_task_delta,
    });

    handler({
      which: 40,
      keyCode: 40,
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      target: null,
    });

    expect(move_task_delta).not.toHaveBeenCalled();
    expect(set_current_task_delta).not.toHaveBeenCalled();
  });

  it("still allows navigation in read-only mode", () => {
    const set_current_task_delta = jest.fn();
    const handler = create_key_handler({
      isEditing: () => false,
      store: {
        get: (key: string) => key === "read_only",
        getIn: () => Map(),
      },
      set_current_task_delta,
    });

    handler({
      which: 40,
      keyCode: 40,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      target: null,
    });

    expect(set_current_task_delta).toHaveBeenCalledWith(1);
  });
});
