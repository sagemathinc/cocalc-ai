import {
  compoundExtension,
  generateAsync,
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

describe("two-part extensions", () => {
  const Json = () => null;
  const Todo = () => null;
  const Markdown = () => null;

  beforeEach(() => {
    register_file_editor({ ext: "json", component: Json });
    register_file_editor({ ext: "todo.json", component: Todo });
    register_file_editor({ ext: "md", component: Markdown });
  });

  afterEach(() => {
    unregister_file_editor(["json", "todo.json", "md"]);
  });

  it("names the last two parts of a longer extension", () => {
    expect(compoundExtension("/home/user/polish.todo.json")).toBe("todo.json");
    expect(compoundExtension("A.Cal.JSON")).toBe("cal.json");
    expect(compoundExtension("todo.json")).toBeUndefined();
    expect(compoundExtension(".todo.json")).toBeUndefined();
    expect(compoundExtension("a..json")).toBeUndefined();
  });

  it("a registered two-part extension wins over the last part", async () => {
    const redux = {};
    expect(await generateAsync("a/polish.todo.json", redux, "p")).toBe(Todo);
    // open-file passes the last part explicitly.
    expect(await generateAsync("a/b.todo.json", redux, "p", "json")).toBe(Todo);
    expect(await generateAsync("a/todo.json", redux, "p")).toBe(Json);
    expect(await generateAsync("a/data.other.json", redux, "p")).toBe(Json);
  });

  it("an editor asked for by name still wins", async () => {
    expect(await generateAsync("a/c.todo.json", {}, "p", "md")).toBe(Markdown);
  });
});
