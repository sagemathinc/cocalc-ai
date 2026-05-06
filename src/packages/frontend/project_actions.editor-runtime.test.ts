import {
  cleanupBrokenNamedEditorRuntime,
  hasUsableNamedEditorRuntime,
} from "./project_actions";

describe("ProjectActions editor runtime recovery", () => {
  it("treats a runtime with missing store as unusable", () => {
    expect(
      hasUsableNamedEditorRuntime({
        runtimeName: "editor-1",
        getStore: () => undefined,
        getActions: () => ({ close: jest.fn() }),
      }),
    ).toBe(false);
  });

  it("treats a runtime with closed actions as unusable", () => {
    expect(
      hasUsableNamedEditorRuntime({
        runtimeName: "editor-1",
        getStore: () => ({}),
        getActions: () => ({
          isClosed: () => true,
        }),
      }),
    ).toBe(false);
  });

  it("cleans up orphaned actions when the store is gone", () => {
    const close = jest.fn();
    const removeActions = jest.fn();
    const removeStore = jest.fn();
    cleanupBrokenNamedEditorRuntime({
      runtimeName: "editor-1",
      getStore: () => undefined,
      getActions: () => ({ close }),
      removeActions,
      removeStore,
    });

    expect(close).toHaveBeenCalledTimes(1);
    expect(removeActions).toHaveBeenCalledWith("editor-1");
    expect(removeStore).not.toHaveBeenCalled();
  });

  it("cleans up an orphaned store when the actions are gone", () => {
    const removeActions = jest.fn();
    const removeStore = jest.fn();
    cleanupBrokenNamedEditorRuntime({
      runtimeName: "editor-1",
      getStore: () => ({}),
      getActions: () => undefined,
      removeActions,
      removeStore,
    });

    expect(removeActions).not.toHaveBeenCalled();
    expect(removeStore).toHaveBeenCalledWith("editor-1");
  });

  it("leaves a healthy runtime intact", () => {
    const close = jest.fn();
    const removeActions = jest.fn();
    const removeStore = jest.fn();
    cleanupBrokenNamedEditorRuntime({
      runtimeName: "editor-1",
      getStore: () => ({}),
      getActions: () => ({
        close,
        isClosed: () => false,
      }),
      removeActions,
      removeStore,
    });

    expect(close).not.toHaveBeenCalled();
    expect(removeActions).not.toHaveBeenCalled();
    expect(removeStore).not.toHaveBeenCalled();
  });
});
