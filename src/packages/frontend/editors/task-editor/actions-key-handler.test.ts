import { fromJS } from "immutable";

const mockCreateKeyHandler = jest.fn();

jest.mock("./keyboard", () => ({
  create_key_handler: (...args) => mockCreateKeyHandler(...args),
}));

import { TaskActions } from "./actions";

describe("TaskActions.enable_key_handler", () => {
  beforeEach(() => {
    mockCreateKeyHandler.mockReset();
  });

  it("registers the task key handler against the frame display path", () => {
    const handler = jest.fn();
    mockCreateKeyHandler.mockReturnValue(handler);
    const setActiveKeyHandler = jest.fn();

    TaskActions.prototype.enable_key_handler.call({
      is_closed: false,
      key_handler: undefined,
      getFrameData(key: string) {
        if (key === "display_path") return "/home/wstein/x.tasks";
        return undefined;
      },
      frameActions: {
        set_active_key_handler: setActiveKeyHandler,
      },
    });

    expect(setActiveKeyHandler).toHaveBeenCalledWith(
      handler,
      "/home/wstein/x.tasks",
    );
  });

  it("clears editing state when focusing the filter box", () => {
    const disableKeyHandler = jest.fn();
    const setFrameData = jest.fn();
    const localTaskState = fromJS({
      "task-1": { editing_desc: true, editing_due_date: false },
      "task-2": { editing_desc: false, editing_due_date: true },
    });

    TaskActions.prototype.focus_find_box.call({
      disable_key_handler: disableKeyHandler,
      getFrameData(key: string) {
        if (key === "local_task_state") return localTaskState;
        return undefined;
      },
      setFrameData,
    });

    expect(disableKeyHandler).toHaveBeenCalledTimes(1);
    expect(setFrameData).toHaveBeenCalledWith(
      expect.objectContaining({
        focus_find_box: true,
        local_task_state: expect.objectContaining({
          getIn: expect.any(Function),
        }),
      }),
    );
    const payload = setFrameData.mock.calls[0][0];
    expect(payload.local_task_state.getIn(["task-1", "editing_desc"])).toBe(
      false,
    );
    expect(payload.local_task_state.getIn(["task-2", "editing_due_date"])).toBe(
      false,
    );
  });

  it("does not recursively clear already-empty selected hashtags", () => {
    const clearAllHashtags = jest.fn();
    const setFrameData = jest.fn();

    (TaskActions.prototype as any).__update_visible.call({
      store: {
        get(key: string) {
          if (key === "tasks") return fromJS({});
          return undefined;
        },
      },
      getFrameData(key: string) {
        if (key === "local_view_state") {
          return fromJS({ selected_hashtags: {} });
        }
        if (key === "local_task_state") return fromJS({});
        if (key === "counts") return fromJS({});
        return undefined;
      },
      clear_all_hashtags: clearAllHashtags,
      setFrameData,
    });

    expect(clearAllHashtags).not.toHaveBeenCalled();
    expect(setFrameData).toHaveBeenCalledTimes(1);
  });
});
