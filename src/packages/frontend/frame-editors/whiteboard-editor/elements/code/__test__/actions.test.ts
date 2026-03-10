jest.mock("awaiting", () => ({
  delay: jest.fn(async () => {}),
}));

const getEditorActions = jest.fn();
const getProjectActions = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getEditorActions: (...args) => getEditorActions(...args),
    getProjectActions: (...args) => getProjectActions(...args),
  },
}));

import { getJupyterFrameEditorActions, pathToIpynb } from "../actions";

describe("whiteboard code aux notebook actions", () => {
  beforeEach(() => {
    getEditorActions.mockReset();
    getProjectActions.mockReset();
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
  });
});
