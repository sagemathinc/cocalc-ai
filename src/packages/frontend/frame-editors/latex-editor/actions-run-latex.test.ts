import { List, Map } from "immutable";

import { Actions } from "./actions";
import { latexmk } from "./latexmk";

jest.mock("./latexmk", () => {
  const actual = jest.requireActual("./latexmk");
  return {
    ...actual,
    latexmk: jest.fn(),
  };
});

describe("LaTeX run_latex", () => {
  function createActions() {
    let state = Map<string, any>({
      build_command: List(["latexmk", "-pdf", "paper.tex"]),
      build_logs: Map(),
    });
    const actions: any = Object.create(Actions.prototype);
    actions.project_id = "project-1";
    actions.path = "/home/user/paper.tex";
    actions.store = {
      get: (key: string) => state.get(key),
      getIn: (path: string[]) => state.getIn(path),
    };
    actions.setState = jest.fn((patch: Record<string, unknown>) => {
      state = state.merge(patch);
    });
    actions.set_status = jest.fn();
    actions.set_error = jest.fn();
    actions.make_timestamp = jest.fn(() => 123);
    actions.get_output_directory = jest.fn(() => undefined);
    actions.check_for_fatal_error = jest.fn();
    actions.update_gutters = jest.fn();
    actions.update_gutters_soon = jest.fn();
    actions.update_pdf = jest.fn();
    actions.set_switch_to_files = jest.fn();
    return actions;
  }

  it("uses streamed latex output instead of showing a generic transport error", async () => {
    jest
      .mocked(latexmk)
      .mockImplementation(
        async (
          _projectId,
          _path,
          _buildCommand,
          _timestamp,
          _status,
          _outputDirectory,
          setJobInfo,
        ) => {
          setJobInfo({
            type: "async",
            job_id: "job-1",
            start: 1,
            status: "completed",
            stdout: "Latexmk: All targets are up-to-date\n",
            stderr: "",
            exit_code: 0,
          });
          throw new Error("An error occurred.");
        },
      );
    const actions = createActions();

    await actions.run_latex(123, false, false);

    expect(actions.set_error).toHaveBeenCalledWith("");
    expect(actions.set_error).toHaveBeenCalledTimes(1);
    expect(actions.check_for_fatal_error).toHaveBeenCalled();
    expect(actions.update_gutters).toHaveBeenCalled();
    expect(actions.setState).toHaveBeenCalledWith(
      expect.objectContaining({
        build_logs: expect.anything(),
      }),
    );
  });

  it("still reports concrete latexmk failures", async () => {
    jest
      .mocked(latexmk)
      .mockRejectedValue(new Error("Project must be running"));
    const actions = createActions();

    await actions.run_latex(123, false, false);

    expect(actions.set_error).toHaveBeenCalledWith(
      new Error("Project must be running"),
    );
    expect(actions.check_for_fatal_error).not.toHaveBeenCalled();
  });
});
