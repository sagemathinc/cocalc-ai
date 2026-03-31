/** @jest-environment jsdom */

import { act, render } from "@testing-library/react";
import { MarkdownInput } from "../component";

type HandlerMap = Record<string, Array<(...args: any[]) => void>>;

let latestEditor: any = null;

async function waitForEditor() {
  await act(async () => {
    for (let i = 0; i < 5 && latestEditor == null; i++) {
      await Promise.resolve();
    }
  });
  expect(latestEditor).toBeTruthy();
}

async function renderMarkdownInput(element: Parameters<typeof render>[0]) {
  const renderResult = render(element);
  await waitForEditor();
  return renderResult;
}

function createMockEditor(node?: HTMLTextAreaElement | null) {
  const handlers: HandlerMap = {};
  let currentValue = "";
  let renderedHeightOverride: number | null = null;
  let currentCursor = { line: 0, ch: 0 };
  let currentSelections = [
    {
      anchor: { line: 0, ch: 0 },
      head: { line: 0, ch: 0 },
    },
  ];
  const wrapper = document.createElement("div");
  wrapper.className = "CodeMirror";
  wrapper.remove = jest.fn();
  const scroller = document.createElement("div");
  scroller.className = "CodeMirror-scroll";
  const sizer = document.createElement("div");
  sizer.className = "CodeMirror-sizer";
  sizer.getBoundingClientRect = () =>
    ({
      top: 0,
      bottom:
        renderedHeightOverride ??
        Math.max(20, currentValue.split("\n").length * 20),
      left: 0,
      right: 300,
      width: 300,
      height:
        renderedHeightOverride ??
        Math.max(20, currentValue.split("\n").length * 20),
      x: 0,
      y: 0,
      toJSON: () => undefined,
    }) as DOMRect;
  scroller.appendChild(sizer);
  wrapper.appendChild(scroller);
  if (node?.parentNode != null) {
    node.parentNode.insertBefore(wrapper, node);
  }
  let currentScrollInfo = {
    left: 0,
    top: 0,
    height: 0,
    width: 0,
    clientHeight: 0,
    clientWidth: 0,
  };
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
    __setRenderedHeight(height: number | null) {
      renderedHeightOverride = height;
    },
    __setScrollInfo(info: Partial<typeof currentScrollInfo>) {
      currentScrollInfo = { ...currentScrollInfo, ...info };
      if (info.top != null) {
        scroller.scrollTop = info.top;
      }
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
      getCursor: () => currentCursor,
      lineCount: () => Math.max(1, currentValue.split("\n").length),
      listSelections: () => currentSelections,
    })),
    getGutterElement: jest.fn(() => document.createElement("div")),
    getInputField: jest.fn(() => inputField),
    getLine: jest.fn((line: number) => currentValue.split("\n")[line] ?? ""),
    getScrollerElement: jest.fn(() => scroller),
    getScrollInfo: jest.fn(() => currentScrollInfo),
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
    scrollIntoView: jest.fn(),
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
  fromTextArea: jest.fn((node: HTMLTextAreaElement) => createMockEditor(node)),
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

  it("focuses and blurs the underlying input when isFocused changes", async () => {
    const { rerender } = await renderMarkdownInput(
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

  it("exposes selection and cursor control via selectionRef and registerEditor", async () => {
    const selectionRef = { current: null as any };
    const registerEditor = jest.fn();

    await renderMarkdownInput(
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

  it("flushes the local value before delegating undo and redo", async () => {
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

    await renderMarkdownInput(
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

  it("does not flush stale local text back upstream when props clear the editor", async () => {
    const onChange = jest.fn();
    const { rerender } = await renderMarkdownInput(
      <MarkdownInput value="hello" onChange={onChange} saveDebounceMs={100} />,
    );

    act(() => {
      latestEditor.__setValue("hello");
      latestEditor.__trigger("change");
    });
    expect(onChange).not.toHaveBeenCalled();

    rerender(
      <MarkdownInput value="" onChange={onChange} saveDebounceMs={100} />,
    );

    expect(onChange).not.toHaveBeenCalledWith("hello");
    expect(latestEditor.setValue).toHaveBeenCalledWith("");
    expect(latestEditor.getValue()).toBe("");
  });

  it("keeps undo and redo local when explicit local ownership is requested", async () => {
    await renderMarkdownInput(
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

  it("reclamps the markdown wrapper height when an auto-grow editor is resized smaller", async () => {
    const value = "a\n\nb\n\nc\n\nd";
    const { rerender } = await renderMarkdownInput(
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

  it("clears the mode switch float on the editor box so markdown keeps full width", () => {
    const { container } = render(
      <MarkdownInput
        value="hello"
        onChange={() => {}}
        saveDebounceMs={0}
        height="220px"
      />,
    );

    const editorHost = container.querySelector("textarea")
      ?.parentElement as HTMLElement;
    expect(editorHost.style.width).toBe("100%");
    expect(editorHost.style.clear).toBe("right");
  });

  it("does not reserve internal help chrome when the editor is using an external toolbar", () => {
    const { container } = render(
      <MarkdownInput
        value="hello"
        onChange={() => {}}
        saveDebounceMs={0}
        height="220px"
        hideHelp
        chromeLayout="external"
      />,
    );

    const body = container.firstElementChild as HTMLElement;
    expect(body.children).toHaveLength(1);
  });

  it("allows blob uploads without a project or path", () => {
    expect(() =>
      render(
        <MarkdownInput
          value="hello"
          onChange={() => {}}
          saveDebounceMs={0}
          enableUpload={true}
        />,
      ),
    ).not.toThrow();
  });

  it("clamps auto-grow to the allocated host height and clears stale host scroll", async () => {
    const { rerender } = await renderMarkdownInput(
      <MarkdownInput
        value={"1\n2\n3\n4\n5\n6\n7\n8\n9\n10"}
        onChange={() => {}}
        saveDebounceMs={0}
        autoGrow
        clampAutoGrowToHost
      />,
    );

    const wrapper = latestEditor.getWrapperElement() as HTMLElement;
    const host = wrapper.parentElement as HTMLElement;
    host.scrollTop = 78;
    host.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 108,
        left: 0,
        right: 300,
        width: 300,
        height: 108,
        x: 0,
        y: 0,
        toJSON: () => undefined,
      }) as DOMRect;

    rerender(
      <MarkdownInput
        value={"1\n2\n3\n4\n5\n6\n7\n8\n9\n10"}
        onChange={() => {}}
        saveDebounceMs={0}
        autoGrow
        clampAutoGrowToHost
        refresh={1}
      />,
    );

    expect(latestEditor.setSize).toHaveBeenLastCalledWith(null, 108);
    expect(wrapper.style.height).toBe("108px");
    expect(host.scrollTop).toBe(0);
  });

  it("honors an explicit auto-grow minimum height for taller edit surfaces", async () => {
    await renderMarkdownInput(
      <MarkdownInput
        value="short"
        onChange={() => {}}
        saveDebounceMs={0}
        autoGrow
        autoGrowMinHeight={120}
      />,
    );

    const wrapper = latestEditor.getWrapperElement() as HTMLElement;
    expect(latestEditor.setSize).toHaveBeenLastCalledWith(null, 120);
    expect(wrapper.style.height).toBe("120px");
    expect(wrapper.style.minHeight).toBe("120px");
  });

  it("delays auto-grow shrink decisions to avoid resize flicker", async () => {
    const { rerender } = await renderMarkdownInput(
      <MarkdownInput
        value={"1\n2\n3\n4\n5\n6"}
        onChange={() => {}}
        saveDebounceMs={0}
        autoGrow
      />,
    );

    expect(latestEditor.setSize).toHaveBeenLastCalledWith(null, 132);

    act(() => {
      latestEditor.__setRenderedHeight(20);
    });

    rerender(
      <MarkdownInput
        value={"1\n2\n3\n4\n5\n6"}
        onChange={() => {}}
        saveDebounceMs={0}
        autoGrow
        refresh={1}
      />,
    );

    expect(latestEditor.setSize).toHaveBeenLastCalledWith(null, 132);

    act(() => {
      jest.advanceTimersByTime(120);
    });

    expect(latestEditor.setSize).toHaveBeenLastCalledWith(null, 38);
  });

  it("hides the auto-grow scrollbar until the editor is capped", async () => {
    const { rerender } = await renderMarkdownInput(
      <MarkdownInput
        value={"1\n2\n3"}
        onChange={() => {}}
        saveDebounceMs={0}
        autoGrow
      />,
    );

    const scroller = latestEditor.getScrollerElement() as HTMLElement;
    expect(scroller.style.overflowY).toBe("hidden");

    rerender(
      <MarkdownInput
        value={"1\n2\n3\n4\n5\n6\n7\n8\n9\n10"}
        onChange={() => {}}
        saveDebounceMs={0}
        autoGrow
        autoGrowMaxHeight={80}
        refresh={1}
      />,
    );

    expect(latestEditor.setSize).toHaveBeenLastCalledWith(null, 80);
    expect(scroller.style.overflowY).toBe("auto");
  });
});
