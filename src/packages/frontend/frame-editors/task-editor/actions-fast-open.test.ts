import {
  Actions,
  MAX_FAST_OPEN_TASKS_BYTES,
  parseTasksPreviewContent,
} from "./actions";

describe("task editor fast-open preview", () => {
  it("parses a task syncdb file into task maps", () => {
    const tasks = parseTasksPreviewContent(
      [
        JSON.stringify({
          task_id: "task-1",
          desc: "first task",
          position: 0,
        }),
        JSON.stringify({
          task_id: "task-2",
          desc: "second task",
          done: true,
          position: 1,
        }),
      ].join("\n"),
    );

    expect(tasks.size).toBe(2);
    expect(tasks.getIn(["task-1", "desc"])).toBe("first task");
    expect(tasks.getIn(["task-2", "done"])).toBe(true);
  });

  it("does not merge pre-ready live changes into preview state", () => {
    const setTasks = jest.fn();

    (Actions.prototype as any).syncdbChange.call(
      {
        taskFastOpenApplied: true,
        taskLiveReady: false,
        _syncstring: {},
        store: {},
        setTasks,
      },
      {
        forEach() {
          throw new Error("should not iterate pre-ready changes");
        },
      },
    );

    expect(setTasks).not.toHaveBeenCalled();
  });

  it("skips large task files before parsing the preview", async () => {
    const readFile = jest.fn(async () => ({
      byteLength: MAX_FAST_OPEN_TASKS_BYTES + 1,
      toString() {
        throw new Error("large task file should not be decoded");
      },
    }));
    const setTasks = jest.fn();
    const setState = jest.fn();

    (Actions.prototype as any).startOptimisticTaskFastOpen.call(
      {
        _get_project_actions: () => ({ fs: () => ({ readFile }) }),
        isClosed: () => false,
        taskFastOpenToken: 0,
        project_id: "project",
        path: "large.tasks",
        setTasks,
        setState,
      },
      { get_state: () => "init" },
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(readFile).toHaveBeenCalledWith("large.tasks", "utf8");
    expect(setTasks).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalled();
  });
});
