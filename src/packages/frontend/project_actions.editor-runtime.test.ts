import {
  cleanupBrokenNamedEditorRuntime,
  hasUsableNamedEditorRuntime,
  teardownNamedEditorRuntime,
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

  it("tears down a healthy named runtime directly", () => {
    const close = jest.fn();
    const removeActions = jest.fn();
    const removeStore = jest.fn();
    teardownNamedEditorRuntime({
      runtimeName: "editor-1",
      getStore: () => ({}),
      getActions: () => ({
        close,
        isClosed: () => false,
      }),
      removeActions,
      removeStore,
    });

    expect(close).toHaveBeenCalledTimes(1);
    expect(removeActions).toHaveBeenCalledWith("editor-1");
    expect(removeStore).toHaveBeenCalledWith("editor-1");
  });

  it("tears down time-travel companions with the main runtime", () => {
    const close = jest.fn();
    const ttClose = jest.fn();
    const removeActions = jest.fn();
    const removeStore = jest.fn();
    teardownNamedEditorRuntime({
      runtimeName: "editor-1",
      getStore: (name) => (name === "editor-1" ? {} : undefined),
      getActions: () => ({
        close,
        timeTravelActions: {
          name: "tt-1",
          close: ttClose,
        },
      }),
      removeActions,
      removeStore,
    });

    expect(close).toHaveBeenCalledTimes(1);
    expect(ttClose).toHaveBeenCalledTimes(1);
    expect(removeActions.mock.calls).toEqual([["tt-1"], ["editor-1"]]);
    expect(removeStore.mock.calls).toEqual([["tt-1"], ["editor-1"]]);
  });
});
