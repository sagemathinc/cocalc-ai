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

  it("skips save for unopened background tabs", async () => {
    redux.getProjectStore.mockReturnValue({
      has_file_been_viewed: () => false,
    });

    await save(path, redux, project_id);

    expect(saveHandler).not.toHaveBeenCalled();
  });

  it("saves viewed files", async () => {
    redux.getProjectStore.mockReturnValue({
      has_file_been_viewed: () => true,
    });

    await save(path, redux, project_id);

    expect(saveHandler).toHaveBeenCalledWith(
      path,
      redux,
      project_id,
      undefined,
    );
  });

  it("waits for an asynchronous editor save", async () => {
    redux.getProjectStore.mockReturnValue({
      has_file_been_viewed: () => true,
    });
    let finishSave: () => void = () => {};
    saveHandler.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );

    let finished = false;
    const saving = save(path, redux, project_id).then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);

    finishSave();
    await saving;
    expect(finished).toBe(true);
  });

  it("passes strict to the editor and propagates its save failure", async () => {
    redux.getProjectStore.mockReturnValue({
      has_file_been_viewed: () => true,
    });
    saveHandler.mockRejectedValue(new Error("disk full"));

    await expect(
      save(path, redux, project_id, { strict: true }),
    ).rejects.toThrow("disk full");
    expect(saveHandler).toHaveBeenCalledWith(path, redux, project_id, {
      strict: true,
    });
  });
});
