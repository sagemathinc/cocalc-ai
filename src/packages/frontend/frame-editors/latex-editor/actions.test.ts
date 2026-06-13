import { Map } from "immutable";
import { Actions } from "./actions";
import { EventEmitter } from "events";

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

describe("LaTeX initial build", () => {
  it("waits for the source syncstring before deciding whether to build on open", async () => {
    const syncstring = new EventEmitter() as any;
    let syncState = "loading";
    syncstring.is_fake = false;
    syncstring.get_state = () => syncState;
    syncstring.to_str = () =>
      syncState === "ready"
        ? "\\documentclass{article}\n\\begin{document}Hi\n\\end{document}\n"
        : "";

    const syncdb = new EventEmitter() as any;
    syncdb.is_fake = false;
    syncdb.get_state = () => "ready";
    syncdb.get_one = jest.fn(() => undefined);
    syncdb.on = jest.fn();

    const forceBuild = jest.fn(async () => undefined);
    const actions: any = Object.create(Actions.prototype);
    actions._state = "open";
    actions._syncstring = syncstring;
    actions._syncdb = syncdb;
    actions._init_syncdb = jest.fn();
    actions.isClosed = () => false;
    actions.is_read_only_preview = () => false;
    actions.setState = jest.fn();
    actions.set_default_build_command = jest.fn(() => ["latexmk"]);
    actions.force_build = forceBuild;
    actions.path = "paper.tex";
    actions.knitr = false;

    const promise = (actions as any).init_config();
    await Promise.resolve();
    expect(forceBuild).not.toHaveBeenCalled();

    syncState = "ready";
    syncstring.emit("ready");
    await promise;

    expect(forceBuild).toHaveBeenCalledTimes(1);
  });
});
