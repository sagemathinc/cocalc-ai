import { render } from "@testing-library/react";
import { act } from "react";
import { fromJS } from "immutable";

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
      get: (key?: string) => (key === "account_id" ? "acct-1" : undefined),
    });
  });

  it("marks the current value saved before running Shift+Enter", () => {
    const setElement = jest.fn();
    const runCodeElement = jest.fn();
    const selectNextCodeCell = jest.fn();
    const selectPreviousCodeCell = jest.fn();
    useFrameContext.mockReturnValue({
      id: "frame-1",
      project_id: "project-1",
      path: "example.board",
      desc: fromJS({}),
      actions: {
        setElement,
        runCodeElement,
        selectNextCodeCell,
        selectPreviousCodeCell,
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
    expect(selectNextCodeCell).toHaveBeenCalledWith("frame-1", "cell1");
  });

  it("moves to adjacent code cells with arrow keys at the boundaries", () => {
    const setElement = jest.fn();
    const selectNextCodeCell = jest.fn();
    const selectPreviousCodeCell = jest.fn();
    const set_frame_tree = jest.fn();
    useFrameContext.mockReturnValue({
      id: "frame-1",
      project_id: "project-1",
      path: "example.board",
      desc: fromJS({}),
      actions: {
        setElement,
        runCodeElement: jest.fn(),
        selectNextCodeCell,
        selectPreviousCodeCell,
        set_frame_tree,
        getElement: jest.fn().mockReturnValue({ id: "prev", str: "a\nbc" }),
      },
    });
    selectNextCodeCell.mockReturnValue("next");
    selectPreviousCodeCell.mockReturnValue("prev");

    render(
      <Input
        element={{ id: "cell1", str: "2+3", data: {}, type: "code" } as any}
        canvasScale={1}
        getValueRef={{ current: () => "2+3" } as any}
      />,
    );

    const props = codeMirrorEditor.mock.calls[0]?.[0] as any;

    const preventDown = jest.fn();
    props.onKeyDown(
      {
        getCursor: () => ({ line: 0, ch: 3 }),
        firstLine: () => 0,
        lastLine: () => 0,
        getLine: () => "2+3",
      },
      {
        key: "ArrowDown",
        preventDefault: preventDown,
      },
    );

    const preventUp = jest.fn();
    props.onKeyDown(
      {
        getCursor: () => ({ line: 0, ch: 0 }),
        firstLine: () => 0,
        lastLine: () => 0,
        getLine: () => "2+3",
      },
      {
        key: "ArrowUp",
        preventDefault: preventUp,
      },
    );

    expect(preventDown).toHaveBeenCalled();
    expect(selectNextCodeCell).toHaveBeenCalledWith("frame-1", "cell1");
    expect(set_frame_tree).toHaveBeenCalledWith({
      id: "frame-1",
      pendingCodeCursor: { id: "next", x: 0, y: 0 },
    });
    expect(preventUp).toHaveBeenCalled();
    expect(selectPreviousCodeCell).toHaveBeenCalledWith("frame-1", "cell1");
    expect(set_frame_tree).toHaveBeenCalledWith({
      id: "frame-1",
      pendingCodeCursor: { id: "prev", x: 2, y: 1 },
    });
  });

  it("applies a selected completion to the local editor value immediately", () => {
    const setElement = jest.fn();
    const focus = jest.fn();
    const set_cursor = jest.fn();
    useFrameContext.mockReturnValue({
      id: "frame-1",
      project_id: "project-1",
      path: "example.board",
      desc: fromJS({}),
      actions: {
        setElement,
        runCodeElement: jest.fn(),
        selectNextCodeCell: jest.fn(),
        selectPreviousCodeCell: jest.fn(),
        set_frame_tree: jest.fn(),
        store: {
          getIn: jest.fn().mockReturnValue("i"),
        },
      },
    });

    render(
      <Input
        element={{ id: "cell1", str: "i", data: {}, type: "code" } as any}
        canvasScale={1}
        getValueRef={{ current: () => "i" } as any}
      />,
    );

    const props = codeMirrorEditor.mock.calls[0]?.[0] as any;
    act(() => {
      props.registerEditor({ focus, set_cursor });
    });
    act(() => {
      props.actions.select_complete(
        "cell1",
        "input",
        fromJS({
          code: "i",
          base: "i",
          cursor_start: 0,
          cursor_end: 1,
        }),
      );
    });
    act(() => {
      props.actions.focus_complete();
    });

    expect(setElement).toHaveBeenCalledWith({
      obj: { id: "cell1", str: "input" },
      commit: undefined,
    });
    expect(noteSaved).toHaveBeenCalledWith("input");
    expect(focus).toHaveBeenCalled();
    expect(set_cursor).toHaveBeenCalledWith({ x: 5, y: 0 });
    const latestProps = codeMirrorEditor.mock.calls.at(-1)?.[0] as any;
    expect(latestProps.value).toBe("input");
  });

  it("restores a pending destination cursor when a focused code cell mounts", () => {
    const set_cursor = jest.fn();
    const set_frame_tree = jest.fn();
    useFrameContext.mockReturnValue({
      id: "frame-1",
      project_id: "project-1",
      path: "example.board",
      desc: fromJS({
        pendingCodeCursor: { id: "cell1", x: 3, y: 2 },
      }),
      actions: {
        setElement: jest.fn(),
        runCodeElement: jest.fn(),
        selectNextCodeCell: jest.fn(),
        selectPreviousCodeCell: jest.fn(),
        set_frame_tree,
        getElement: jest.fn(),
        store: {
          getIn: jest.fn().mockReturnValue(""),
        },
      },
    });

    render(
      <Input
        element={{ id: "cell1", str: "", data: {}, type: "code" } as any}
        canvasScale={1}
        isFocused={true}
        getValueRef={{ current: () => "" } as any}
      />,
    );

    const props = codeMirrorEditor.mock.calls[0]?.[0] as any;
    act(() => {
      props.registerEditor({ focus: jest.fn(), set_cursor });
    });

    expect(set_cursor).toHaveBeenCalledWith({ x: 3, y: 2 });
    expect(set_frame_tree).toHaveBeenCalledWith({
      id: "frame-1",
      pendingCodeCursor: undefined,
    });
  });
});
