/** @jest-environment jsdom */

import { act, render } from "@testing-library/react";
import { MarkdownInput } from "../component";

type HandlerMap = Record<string, Array<(...args: any[]) => void>>;

let latestEditor: any = null;

function createMockEditor() {
  const handlers: HandlerMap = {};
  let currentValue = "";
  let currentCursor = { line: 0, ch: 0 };
  let currentSelections = [
    {
      anchor: { line: 0, ch: 0 },
      head: { line: 0, ch: 0 },
    },
  ];
  const wrapper = document.createElement("div");
  wrapper.remove = jest.fn();
  const inputField = {
    blur: jest.fn(() => {
      editor.__trigger("blur", editor);
    }),
    focus: jest.fn((_opts?: any) => {
      editor.__trigger("focus", editor);
    }),
  };

  const editor = {
    options: {},
    __trigger(event: string, ...args: any[]) {
      for (const handler of handlers[event] ?? []) {
        handler(...args);
      }
    },
    __setValue(value: string) {
      currentValue = value;
    },
    addKeyMap: jest.fn(),
    defaultTextHeight: jest.fn(() => 20),
    execCommand: jest.fn(),
    firstLine: jest.fn(() => 0),
    focus: jest.fn(() => {
      editor.getInputField().focus({ preventScroll: true });
    }),
    getAllMarks: jest.fn(() => []),
    getCursor: jest.fn(() => currentCursor),
    getDoc: jest.fn(() => ({
      lineCount: () => Math.max(1, currentValue.split("\n").length),
      listSelections: () => currentSelections,
    })),
    getGutterElement: jest.fn(() => document.createElement("div")),
    getInputField: jest.fn(() => inputField),
    getLine: jest.fn((line: number) => currentValue.split("\n")[line] ?? ""),
    getScrollInfo: jest.fn(() => ({ top: 0 })),
    getValue: jest.fn(() => currentValue),
    getWrapperElement: jest.fn(() => wrapper),
    lastLine: jest.fn(() => Math.max(0, currentValue.split("\n").length - 1)),
    listSelections: jest.fn(() => currentSelections),
    markText: jest.fn(),
    off: jest.fn((event: string, handler: (...args: any[]) => void) => {
      handlers[event] = (handlers[event] ?? []).filter((h) => h !== handler);
    }),
    on: jest.fn((event: string, handler: (...args: any[]) => void) => {
      handlers[event] = [...(handlers[event] ?? []), handler];
    }),
    refresh: jest.fn(),
    replaceRange: jest.fn(),
    setCursor: jest.fn((cursor: { line: number; ch: number }) => {
      currentCursor = cursor;
    }),
    setOption: jest.fn((key: string, value: any) => {
      editor.options[key] = value;
    }),
    setSelections: jest.fn((selections: any) => {
      currentSelections = selections;
    }),
    setSize: jest.fn(),
    setValue: jest.fn((value: string) => {
      currentValue = value;
    }),
  };

  latestEditor = editor;
  return editor;
}

jest.mock("codemirror", () => ({
  __esModule: true,
  commands: {
    goLineDown: jest.fn(),
    goLineUp: jest.fn(),
  },
  fromTextArea: jest.fn(() => createMockEditor()),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: () => ({
      get_name: () => undefined,
    }),
  },
  useRedux: () => ({
    get: (_key: string, fallback: any) => fallback,
  }),
  useTypedRedux: () => 14,
}));

jest.mock("@cocalc/frontend/components", () => ({
  A: ({ children }: any) => <>{children}</>,
}));

jest.mock("@cocalc/frontend/feature", () => ({
  IS_MOBILE: false,
}));

jest.mock("@cocalc/frontend/file-upload", () => ({
  BlobUpload: ({ children }: any) => <>{children}</>,
  Dropzone: function Dropzone() {
    return null;
  },
}));

jest.mock("@cocalc/frontend/jupyter/cursors", () => ({
  Cursors: () => null,
}));

jest.mock("@cocalc/frontend/project/settings/has-internet-access-hook", () => ({
  useProjectHasInternetAccess: () => true,
}));

jest.mock("@cocalc/frontend/frame-editors/frame-tree/frame-context", () => ({
  useFrameContext: () => ({
    actions: {
      set_error: jest.fn(),
    },
    isVisible: true,
  }),
}));

jest.mock("@cocalc/frontend/alerts", () => ({
  alert_message: jest.fn(),
}));

jest.mock("@cocalc/frontend/codemirror/init", () => ({}));

jest.mock("../complete", () => ({
  Complete: () => null,
}));

jest.mock("../mentionable-users", () => ({
  useMentionableUsers: () => () => [],
}));

jest.mock("../mentions", () => ({
  submit_mentions: jest.fn(),
}));

jest.mock("@cocalc/frontend/misc/fragment-id", () => ({
  __esModule: true,
  default: {
    encode: (value: any) => value,
  },
  FragmentId: class FragmentId {},
}));

jest.mock("@cocalc/sync/editor/generic/simple-input-merge", () => ({
  SimpleInputMerge: class SimpleInputMerge {
    constructor(_value: string) {}
    noteSaved(_value: string) {}
    reset(_value: string) {}
    handleRemote({
      remote,
      getLocal,
      applyMerged,
    }: {
      remote: string;
      getLocal: () => string;
      applyMerged: (value: string) => void;
    }) {
      if (remote !== getLocal()) {
        applyMerged(remote);
      }
    }
  },
}));

describe("MarkdownInput CodeMirror wrapper contract", () => {
  beforeEach(() => {
    latestEditor = null;
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it("focuses and blurs the underlying input when isFocused changes", () => {
    const { rerender } = render(
      <MarkdownInput
        value=""
        onChange={() => {}}
        saveDebounceMs={0}
        isFocused={false}
      />,
    );

    const inputField = latestEditor.getInputField();
    expect(inputField.focus).not.toHaveBeenCalled();
    expect(inputField.blur).not.toHaveBeenCalled();

    rerender(
      <MarkdownInput
        value=""
        onChange={() => {}}
        saveDebounceMs={0}
        isFocused={true}
      />,
    );
    expect(inputField.focus).toHaveBeenCalledWith({ preventScroll: true });

    rerender(
      <MarkdownInput
        value=""
        onChange={() => {}}
        saveDebounceMs={0}
        isFocused={false}
      />,
    );
    expect(inputField.blur).toHaveBeenCalled();
  });

  it("exposes selection and cursor control via selectionRef and registerEditor", () => {
    const selectionRef = { current: null as any };
    const registerEditor = jest.fn();

    render(
      <MarkdownInput
        value="abc"
        onChange={() => {}}
        saveDebounceMs={0}
        selectionRef={selectionRef}
        registerEditor={registerEditor}
      />,
    );

    expect(selectionRef.current).toBeTruthy();
    expect(registerEditor).toHaveBeenCalledTimes(1);

    const editorApi = registerEditor.mock.calls[0][0];
    selectionRef.current.setSelection([
      {
        anchor: { line: 1, ch: 2 },
        head: { line: 1, ch: 2 },
      },
    ]);
    expect(latestEditor.setSelections).toHaveBeenCalledWith([
      {
        anchor: { line: 1, ch: 2 },
        head: { line: 1, ch: 2 },
      },
    ]);

    latestEditor.setCursor.mockClear();
    editorApi.set_cursor({ x: 4, y: 3 });
    expect(latestEditor.setCursor).toHaveBeenCalledWith({ line: 3, ch: 4 });

    latestEditor.getCursor.mockReturnValue({ line: 7, ch: 9 });
    expect(editorApi.get_cursor()).toEqual({ x: 9, y: 7 });
  });

  it("flushes the local value before delegating undo and redo", () => {
    const callOrder: string[] = [];
    const onChange = jest.fn((value: string) => {
      callOrder.push(`change:${value}`);
    });
    const onUndo = jest.fn(() => {
      callOrder.push("undo");
    });
    const onRedo = jest.fn(() => {
      callOrder.push("redo");
    });

    render(
      <MarkdownInput
        value="start"
        onChange={onChange}
        saveDebounceMs={0}
        onUndo={onUndo}
        onRedo={onRedo}
      />,
    );

    act(() => {
      latestEditor.__setValue("after-undo");
      latestEditor.undo();
    });

    act(() => {
      latestEditor.__setValue("after-redo");
      latestEditor.redo();
    });

    expect(callOrder).toEqual([
      "change:after-undo",
      "undo",
      "change:after-redo",
      "redo",
    ]);
  });

  it("keeps undo and redo local when explicit local ownership is requested", () => {
    render(
      <MarkdownInput
        value="start"
        onChange={() => {}}
        saveDebounceMs={0}
        onUndo={() => {}}
        onRedo={() => {}}
        undoMode="local"
        redoMode="local"
      />,
    );

    expect(latestEditor.undo).toBeUndefined();
    expect(latestEditor.redo).toBeUndefined();
  });

  it("reclamps the markdown wrapper height when an auto-grow editor is resized smaller", () => {
    const value = "a\n\nb\n\nc\n\nd";
    const { rerender } = render(
      <MarkdownInput
        value={value}
        onChange={() => {}}
        saveDebounceMs={0}
        autoGrow
        height="220px"
      />,
    );

    const wrapper = latestEditor.getWrapperElement();
    expect(wrapper.style.height).toBe("174px");
    expect(wrapper.style.maxHeight).toBe("174px");
    expect(latestEditor.setSize).toHaveBeenLastCalledWith(null, 174);

    rerender(
      <MarkdownInput
        value={value}
        onChange={() => {}}
        saveDebounceMs={0}
        autoGrow
        height="120px"
      />,
    );

    expect(wrapper.style.height).toBe("74px");
    expect(wrapper.style.maxHeight).toBe("74px");
    expect(latestEditor.setSize).toHaveBeenLastCalledWith(null, 74);
  });

  it("clears the mode switch float so the markdown body keeps full width", () => {
    const { container } = render(
      <MarkdownInput
        value="hello"
        onChange={() => {}}
        saveDebounceMs={0}
        height="220px"
      />,
    );

    const body = container.firstElementChild as HTMLElement;
    expect(body.style.width).toBe("100%");
    expect(body.style.clear).toBe("right");
  });
});
