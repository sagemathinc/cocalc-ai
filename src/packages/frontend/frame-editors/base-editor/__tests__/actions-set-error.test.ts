import { fromJS } from "immutable";
import { alert_message } from "@cocalc/frontend/alerts";
import { BaseEditorActions } from "../actions-base";

jest.mock("@cocalc/frontend/alerts", () => ({
  alert_message: jest.fn(),
}));

describe("BaseEditorActions.set_error", () => {
  function makeActions(path = "/home/user/test.tex"): any {
    const actions = new BaseEditorActions(path, {
      getStore: jest.fn(() => fromJS({ active_top_tab: "project-1" })),
      getProjectStore: jest.fn(() =>
        fromJS({ active_project_tab: `editor-${path}` }),
      ),
    } as any) as any;
    actions.path = path;
    actions.project_id = "project-1";
    return actions;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("treats an empty string as clearing the error instead of a generic toast", () => {
    makeActions().set_error("");

    expect(alert_message).not.toHaveBeenCalled();
  });

  it("still shows non-empty editor errors for the active file", () => {
    makeActions().set_error("latexmk failed");

    expect(alert_message).toHaveBeenCalledWith({
      type: "error",
      title: "test.tex",
      message: "latexmk failed",
    });
  });
});
