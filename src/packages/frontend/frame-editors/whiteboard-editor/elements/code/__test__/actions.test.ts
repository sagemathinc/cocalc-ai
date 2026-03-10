jest.mock("awaiting", () => ({
  delay: jest.fn(async () => {}),
}));

jest.mock("@cocalc/frontend/jupyter/new-notebook", () => ({
  createInitialIpynbContent: jest.fn(
    async () => '{"metadata":{"kernelspec":{"name":"python3"}}}',
  ),
}));

const getEditorActions = jest.fn();
const getProjectActions = jest.fn();
const ensureContainingDirectoryExists = jest.fn(async () => {});
const fsExists = jest.fn(async () => false);
const fsReadFile = jest.fn(async () => Buffer.alloc(0));
const fsWriteFile = jest.fn(async () => {});
const getStore = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getEditorActions: (...args) => getEditorActions(...args),
    getProjectActions: (...args) => getProjectActions(...args),
    getStore: (...args) => getStore(...args),
  },
}));

import { getJupyterFrameEditorActions, pathToIpynb } from "../actions";

describe("whiteboard code aux notebook actions", () => {
  beforeEach(() => {
    getEditorActions.mockReset();
    getProjectActions.mockReset();
    ensureContainingDirectoryExists.mockReset();
    fsExists.mockReset();
    fsReadFile.mockReset();
    fsWriteFile.mockReset();
    getStore.mockReset();
    getStore.mockReturnValue({
      getIn: () => "python3",
    });
  });

  it("initializes the aux notebook using the ipynb editor type", async () => {
    const editorActions = { jupyter_actions: {} } as any;
    let currentActions: any;
    const initFileRedux = jest.fn(async (_path: string, ext?: string) => {
      if (ext === "ipynb") {
        currentActions = editorActions;
      }
    });

    getEditorActions.mockImplementation(() => currentActions);
    getProjectActions.mockReturnValue({
      fs: () => ({
        exists: fsExists,
        readFile: fsReadFile,
        writeFile: fsWriteFile,
      }),
      ensureContainingDirectoryExists,
      initFileRedux,
    });

    await expect(
      getJupyterFrameEditorActions({
        project_id: "project-id",
        path: "notes/example.board",
      }),
    ).resolves.toBe(editorActions);

    expect(initFileRedux).toHaveBeenCalledWith(
      pathToIpynb("notes/example.board"),
      "ipynb",
    );
    expect(fsWriteFile).toHaveBeenCalledWith(
      pathToIpynb("notes/example.board"),
      '{"metadata":{"kernelspec":{"name":"python3"}}}',
    );
  });

  it("does not overwrite an existing non-empty aux notebook", async () => {
    const editorActions = { jupyter_actions: {} } as any;
    let currentActions: any;
    fsExists.mockResolvedValue(true);
    fsReadFile.mockResolvedValue(
      Buffer.from('{"metadata":{"kernelspec":{"name":"python3"}}}'),
    );
    const initFileRedux = jest.fn(async (_path: string, ext?: string) => {
      if (ext === "ipynb") {
        currentActions = editorActions;
      }
    });

    getEditorActions.mockImplementation(() => currentActions);
    getProjectActions.mockReturnValue({
      fs: () => ({
        exists: fsExists,
        readFile: fsReadFile,
        writeFile: fsWriteFile,
      }),
      ensureContainingDirectoryExists,
      initFileRedux,
    });

    await expect(
      getJupyterFrameEditorActions({
        project_id: "project-id",
        path: "notes/example.board",
      }),
    ).resolves.toBe(editorActions);

    expect(fsWriteFile).not.toHaveBeenCalled();
  });
});
