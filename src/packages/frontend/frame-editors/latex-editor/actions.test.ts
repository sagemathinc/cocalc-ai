import { Map } from "immutable";
import { Actions } from "./actions";

describe("LaTeX persisted source change builds", () => {
  function createActions() {
    const build = jest.fn(async () => undefined);
    const parentBuild = jest.fn(async () => undefined);
    const actions: any = Object.create(Actions.prototype);
    actions.redux = {
      getStore: () =>
        Map({
          editor_settings: Map({
            build_on_save: true,
          }),
        }),
      getEditorActions: jest.fn(() => ({
        build: parentBuild,
      })),
    };
    actions._syncstring = {
      to_str: () => "\\documentclass{article}\\n\\begin{document}Hi\\n",
    };
    actions.not_ready = () => false;
    actions.parent_file = null;
    actions.path = "paper.tex";
    actions.project_id = "project-1";
    actions._last_syncstring_hash = undefined;
    actions.is_likely_master = () => true;
    actions.build = build;
    return { actions, build, parentBuild };
  }

  it("builds once for a filesystem-originated persisted change", async () => {
    const { actions, build } = createActions();
    await (actions as any).maybeBuildAfterPersistedSourceChange();
    await (actions as any).maybeBuildAfterPersistedSourceChange();
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith("", false);
  });

  it("builds the parent master file for included documents", async () => {
    const { actions, build, parentBuild } = createActions();
    actions.parent_file = "master.tex";
    await (actions as any).maybeBuildAfterPersistedSourceChange();
    expect(parentBuild).toHaveBeenCalledTimes(1);
    expect(parentBuild).toHaveBeenCalledWith("", false);
    expect(build).not.toHaveBeenCalled();
  });
});
