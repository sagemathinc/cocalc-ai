import { render } from "@testing-library/react";

const useFrameContext = jest.fn();
const getStore = jest.fn();
const codeMirrorEditor = jest.fn((_props?: any) => null);
const noteSaved = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: (...args) => getStore(...args),
  },
}));

jest.mock("@cocalc/frontend/jupyter/codemirror-editor", () => ({
  CodeMirrorEditor: (props) => codeMirrorEditor(props),
}));

jest.mock("@cocalc/sync/editor/generic/simple-input-merge", () => ({
  SimpleInputMerge: jest.fn().mockImplementation(() => ({
    reset: jest.fn(),
    handleRemote: jest.fn(),
    noteSaved: (...args) => noteSaved(...args),
  })),
}));

jest.mock("../../../hooks", () => ({
  useFrameContext: (...args) => useFrameContext(...args),
}));

import Input from "../input";

describe("whiteboard code input", () => {
  beforeEach(() => {
    useFrameContext.mockReset();
    getStore.mockReset();
    codeMirrorEditor.mockReset();
    noteSaved.mockReset();
    getStore.mockReturnValue({
      get: () => undefined,
    });
  });

  it("marks the current value saved before running Shift+Enter", () => {
    const setElement = jest.fn();
    const runCodeElement = jest.fn();
    useFrameContext.mockReturnValue({
      project_id: "project-1",
      path: "example.board",
      actions: {
        setElement,
        runCodeElement,
      },
    });

    render(
      <Input
        element={{ id: "cell1", str: "", data: {}, type: "code" } as any}
        canvasScale={1}
        getValueRef={{ current: () => "" } as any}
      />,
    );

    const props = codeMirrorEditor.mock.calls[0]?.[0] as any;
    expect(props).toBeDefined();
    const preventDefault = jest.fn();
    props.onKeyDown(
      {
        getValue: () => "2+3",
      },
      {
        key: "Enter",
        shiftKey: true,
        altKey: false,
        metaKey: false,
        ctrlKey: false,
        preventDefault,
      },
    );

    expect(preventDefault).toHaveBeenCalled();
    expect(setElement).toHaveBeenCalledWith({
      obj: { id: "cell1", str: "2+3" },
      commit: false,
    });
    expect(noteSaved).toHaveBeenCalledWith("2+3");
    expect(runCodeElement).toHaveBeenCalledWith({ id: "cell1", str: "2+3" });
  });
});
