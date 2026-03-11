import { fromJS } from "immutable";
import { TaskActions } from "./actions";

describe("TaskActions.reorder_tasks", () => {
  it("moves a task to the visible top when custom sort is reversed", () => {
    const visible = fromJS(["top", "middle", "bottom"]);
    const localViewState = fromJS({
      sort: {
        column: "Custom",
        dir: "desc",
      },
    });
    const store = fromJS({
      tasks: {
        top: { position: 3 },
        middle: { position: 2 },
        bottom: { position: 1 },
      },
    });
    let patch: any;
    let updateCount = 0;

    TaskActions.prototype.reorder_tasks.call(
      {
        store,
        getFrameData(key: string) {
          if (key === "visible") return visible;
          if (key === "local_view_state") return localViewState;
          return undefined;
        },
        set_task(taskId: string, changes: any) {
          patch = { taskId, changes };
        },
        __update_visible() {
          updateCount += 1;
        },
      },
      2,
      0,
    );

    expect(patch).toEqual({
      taskId: "bottom",
      changes: { position: 4 },
    });
    expect(updateCount).toBe(1);
  });

  it("moves a task to the visible top when custom sort is ascending", () => {
    const visible = fromJS(["top", "middle", "bottom"]);
    const localViewState = fromJS({
      sort: {
        column: "Custom",
        dir: "asc",
      },
    });
    const store = fromJS({
      tasks: {
        top: { position: 1 },
        middle: { position: 2 },
        bottom: { position: 3 },
      },
    });
    let patch: any;

    TaskActions.prototype.reorder_tasks.call(
      {
        store,
        getFrameData(key: string) {
          if (key === "visible") return visible;
          if (key === "local_view_state") return localViewState;
          return undefined;
        },
        set_task(taskId: string, changes: any) {
          patch = { taskId, changes };
        },
        __update_visible() {},
      },
      2,
      0,
    );

    expect(patch).toEqual({
      taskId: "bottom",
      changes: { position: 0 },
    });
  });
});
