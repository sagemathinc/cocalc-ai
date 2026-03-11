import { fromJS } from "immutable";

import { TaskActions } from "./actions";

describe("TaskActions.edit_desc", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it("falls back to the current task when no task id is provided", () => {
    const setLocalTaskState = jest.fn();
    const disableKeyHandler = jest.fn();

    TaskActions.prototype.edit_desc.call(
      {
        getFrameData: jest.fn((key: string) => {
          if (key === "current_task_id") {
            return "task-1";
          }
          if (key === "local_task_state") {
            return fromJS({});
          }
          return undefined;
        }),
        stop_editing_desc: jest.fn(),
        set_local_task_state: setLocalTaskState,
        disable_key_handler: disableKeyHandler,
        store: {
          getIn: jest.fn(() => 123),
        },
      },
      undefined,
    );

    expect(setLocalTaskState).toHaveBeenCalledWith("task-1", {
      editing_desc: true,
      editing_desc_last_edited: 123,
    });
    expect(disableKeyHandler).toHaveBeenCalledTimes(1);

    jest.runOnlyPendingTimers();
    expect(disableKeyHandler).toHaveBeenCalledTimes(2);
  });

  it("preserves null as an explicit do-not-open-edit-mode signal", () => {
    const setLocalTaskState = jest.fn();

    TaskActions.prototype.edit_desc.call(
      {
        getFrameData: jest.fn(() => fromJS({})),
        stop_editing_desc: jest.fn(),
        set_local_task_state: setLocalTaskState,
        disable_key_handler: jest.fn(),
        store: {
          getIn: jest.fn(),
        },
      },
      null,
    );

    expect(setLocalTaskState).not.toHaveBeenCalled();
  });
});
