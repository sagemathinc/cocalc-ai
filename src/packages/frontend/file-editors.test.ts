import {
  initializeAsync,
  remove,
  register_file_editor,
  save,
  unregister_file_editor,
} from "./file-editors";
import { register_file_editor as registerFrameTreeEditor } from "./frame-editors/frame-tree/register";
import { Actions } from "@cocalc/util/redux/Actions";
import { AppRedux } from "@cocalc/util/redux/AppRedux";
import { redux_name } from "@cocalc/util/redux/name";

describe("file-editors save", () => {
  const saveHandler = jest.fn();
  const project_id = "project-1";
  const path = "notes.chat";
  const redux = {
    getProjectStore: jest.fn(),
  };

  beforeEach(() => {
    saveHandler.mockReset();
    redux.getProjectStore.mockReset();
    register_file_editor({
      ext: "chat",
      save: saveHandler,
    });
  });

  afterEach(() => {
    unregister_file_editor("chat");
  });

  it("skips save for unopened background tabs", () => {
    redux.getProjectStore.mockReturnValue({
      has_file_been_viewed: () => false,
    });

    save(path, redux, project_id);

    expect(saveHandler).not.toHaveBeenCalled();
  });

  it("saves viewed files", () => {
    redux.getProjectStore.mockReturnValue({
      has_file_been_viewed: () => true,
    });

    save(path, redux, project_id);

    expect(saveHandler).toHaveBeenCalledWith(path, redux, project_id);
  });
});

describe("file-editors forced runtime removal", () => {
  const project_id = "00000000-1000-4000-8000-000000000000";
  const ext = "force-remove-test";
  const path = `/tmp/example.${ext}`;

  class TestEditorActions extends Actions<any> {
    _init(_project_id: string, _path: string, _store: any): void {}
    close = jest.fn();
  }

  beforeEach(() => {
    registerFrameTreeEditor({
      ext,
      component: () => null,
      Actions: TestEditorActions,
    });
  });

  afterEach(() => {
    unregister_file_editor(ext);
  });

  it("forces editor teardown even when the runtime reference count is greater than one", async () => {
    const redux = new AppRedux();
    (redux as any).getProjectStore = () => ({
      has_file_been_viewed: () => true,
    });

    await initializeAsync(path, redux, project_id, undefined, ext);
    await initializeAsync(path, redux, project_id, undefined, ext);

    const name = redux_name(project_id, path);
    const actions = redux.getActions(name) as TestEditorActions;
    expect(actions).toBeDefined();

    await remove(path, redux, project_id, { force: true });

    expect(actions.close).toHaveBeenCalledTimes(1);
    expect(redux.getActions(name)).toBeUndefined();
    expect(redux.getStore(name)).toBeUndefined();
  });
});
