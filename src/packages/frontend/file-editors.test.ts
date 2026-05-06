import {
  register_file_editor,
  save,
  unregister_file_editor,
} from "./file-editors";

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
