import { NBGraderActions } from "./actions";

describe("NBGraderActions", () => {
  it("hydrates the generated notebook store before transforming and saving", async () => {
    const calls: string[] = [];
    const targetJupyterActions = {
      wait_until_ready: jest.fn(async () => {
        calls.push("wait_until_ready");
      }),
      setToIpynb: jest.fn(async () => {
        calls.push("setToIpynb");
      }),
      _syncdb_change: jest.fn(() => {
        calls.push("_syncdb_change");
      }),
      nbgrader_actions: {
        apply_assign_transformations: jest.fn(() => {
          calls.push("apply_assign_transformations");
        }),
      },
      save: jest.fn(async () => {
        calls.push("save");
      }),
    };
    const redux = {
      getProjectActions: jest.fn(() => ({
        createFile: jest.fn(async () => {
          calls.push("createFile");
        }),
      })),
      getEditorActions: jest.fn(() => ({
        jupyter_actions: targetJupyterActions,
      })),
    };
    const sourceJupyterActions = {
      project_id: "project-1",
      toIpynb: jest.fn(async () => {
        calls.push("toIpynb");
        return {
          cells: [{ cell_type: "markdown", metadata: {}, source: ["Hello"] }],
          metadata: {},
          nbformat: 4,
          nbformat_minor: 5,
        };
      }),
    };

    const actions = new NBGraderActions(sourceJupyterActions, redux);
    await actions.assign("student/a.ipynb");

    expect(targetJupyterActions._syncdb_change).toHaveBeenCalledWith("all");
    expect(calls).toEqual([
      "createFile",
      "wait_until_ready",
      "toIpynb",
      "setToIpynb",
      "_syncdb_change",
      "apply_assign_transformations",
      "save",
    ]);
  });
});
