/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react";
import MultiMarkdownInput from "../multimode";

let latestEditableProps: any = null;
let latestMarkdownProps: any = null;
let editableControlApi: any = {};
let markdownSelectionApi: any = null;

const mockGetLocalStorage = jest.fn();
const mockSetLocalStorage = jest.fn();

jest.mock("antd", () => ({
  Popover: ({ children }: any) => <>{children}</>,
  Radio: {
    Group: ({ options, onChange, value }: any) => (
      <div data-testid="mode-switch">
        {options.map((option: any) => (
          <button
            key={option.value}
            aria-pressed={value === option.value}
            onClick={() => onChange({ target: { value: option.value } })}
            type="button"
          >
            {typeof option.label === "string" ? option.label : option.value}
          </button>
        ))}
      </div>
    ),
  },
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => <span data-testid="icon" />,
}));

jest.mock("@cocalc/frontend/editors/slate/editable-markdown", () => ({
  EditableMarkdown: (props: any) => {
    latestEditableProps = props;
    if (props.controlRef != null) {
      props.controlRef.current = {
        ...(props.controlRef.current ?? {}),
        ...editableControlApi,
      };
    }
    return <div data-testid="editable-markdown" />;
  },
}));

jest.mock("../component", () => ({
  MarkdownInput: (props: any) => {
    latestMarkdownProps = props;
    if (props.selectionRef != null) {
      props.selectionRef.current =
        markdownSelectionApi ?? {
          setSelection: jest.fn(),
          getSelection: jest.fn(() => null),
        };
    }
    return <div data-testid="markdown-input" />;
  },
}));

jest.mock("@cocalc/frontend/frame-editors/frame-tree/frame-context", () => ({
  useFrameContext: () => ({
    isFocused: true,
    isVisible: true,
    project_id: "project-1",
    path: "path-1",
  }),
}));

jest.mock("@cocalc/frontend/feature", () => ({
  IS_MOBILE: false,
}));

jest.mock("@cocalc/frontend/misc", () => ({
  get_local_storage: (...args: any[]) => mockGetLocalStorage(...args),
  set_local_storage: (...args: any[]) => mockSetLocalStorage(...args),
}));

describe("MultiMarkdownInput wrapper contract", () => {
  beforeEach(() => {
    latestEditableProps = null;
    latestMarkdownProps = null;
    editableControlApi = {};
    markdownSelectionApi = null;
    mockGetLocalStorage.mockReset();
    mockSetLocalStorage.mockReset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it("reports initial mode and updates onModeChange when the mode switch is used", () => {
    const onModeChange = jest.fn();

    render(<MultiMarkdownInput value="" onChange={() => {}} onModeChange={onModeChange} />);

    expect(onModeChange).toHaveBeenNthCalledWith(1, "editor");
    expect(screen.queryByTestId("editable-markdown")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "markdown" }));

    expect(mockSetLocalStorage).toHaveBeenCalledWith(
      "markdown-editor-mode",
      "markdown",
    );
    expect(onModeChange).toHaveBeenNthCalledWith(2, "markdown");
    expect(screen.queryByTestId("markdown-input")).not.toBeNull();
  });

  it("does not re-emit onModeChange when the active mode is selected again", () => {
    const onModeChange = jest.fn();

    render(<MultiMarkdownInput value="" onChange={() => {}} onModeChange={onModeChange} />);

    expect(onModeChange).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "editor" }));

    expect(onModeChange).toHaveBeenCalledTimes(1);
  });

  it("switches from markdown to rich text and reapplies the markdown cursor position", () => {
    const onChange = jest.fn();
    const setSelectionFromMarkdownPosition = jest.fn(() => true);
    editableControlApi = { setSelectionFromMarkdownPosition };

    render(
      <MultiMarkdownInput
        value=""
        onChange={onChange}
        defaultMode="markdown"
      />,
    );

    expect(screen.queryByTestId("markdown-input")).not.toBeNull();

    act(() => {
      latestMarkdownProps.onAltEnter("updated markdown", { line: 2, ch: 4 });
    });

    expect(onChange).toHaveBeenCalledWith("updated markdown");
    expect(screen.queryByTestId("editable-markdown")).not.toBeNull();

    act(() => {
      jest.runOnlyPendingTimers();
    });

    expect(setSelectionFromMarkdownPosition).toHaveBeenCalledWith({
      line: 2,
      ch: 4,
    });
  });

  it("switches from rich text to markdown and restores the mapped cursor position", () => {
    const onChange = jest.fn();
    const setSelection = jest.fn();
    markdownSelectionApi = {
      setSelection,
      getSelection: jest.fn(() => null),
    };
    editableControlApi = {
      getMarkdownPositionForSelection: jest.fn(() => ({ line: 5, ch: 1 })),
    };

    render(<MultiMarkdownInput value="" onChange={onChange} defaultMode="editor" />);

    expect(screen.queryByTestId("editable-markdown")).not.toBeNull();

    act(() => {
      latestEditableProps.actions.altEnter("plain markdown");
    });

    expect(onChange).toHaveBeenCalledWith("plain markdown");
    expect(screen.queryByTestId("markdown-input")).not.toBeNull();

    act(() => {
      jest.runOnlyPendingTimers();
    });

    expect(setSelection).toHaveBeenCalledWith([
      {
        anchor: { line: 5, ch: 1 },
        head: { line: 5, ch: 1 },
      },
    ]);
  });

  it("suppresses external blur callbacks while the mode switch is being clicked", () => {
    const onBlur = jest.fn();

    render(<MultiMarkdownInput value="" onChange={() => {}} onBlur={onBlur} />);

    expect(screen.queryByTestId("editable-markdown")).not.toBeNull();

    fireEvent.mouseDown(screen.getByRole("button", { name: "markdown" }));

    act(() => {
      latestEditableProps.onBlur();
    });
    expect(onBlur).not.toHaveBeenCalled();
  });

  it("stops suppressing blur once mode-switch interaction has ended", () => {
    const onBlur = jest.fn();

    render(<MultiMarkdownInput value="" onChange={() => {}} onBlur={onBlur} />);

    const markdownButton = screen.getByRole("button", { name: "markdown" });
    fireEvent.mouseDown(markdownButton);
    fireEvent.mouseUp(markdownButton);

    act(() => {
      latestEditableProps.onBlur();
    });
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it("forwards declarative focus to whichever backend is active", () => {
    const { rerender } = render(
      <MultiMarkdownInput
        value=""
        onChange={() => {}}
        defaultMode="markdown"
        isFocused={true}
      />,
    );

    expect(latestMarkdownProps.isFocused).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "editor" }));

    expect(latestEditableProps.isFocused).toBe(true);

    rerender(
      <MultiMarkdownInput
        value=""
        onChange={() => {}}
        defaultMode="markdown"
        isFocused={false}
      />,
    );

    expect(latestEditableProps.isFocused).toBe(false);
  });

  it("preserves undo and redo delegation across both modes", () => {
    const onUndo = jest.fn();
    const onRedo = jest.fn();

    render(
      <MultiMarkdownInput
        value=""
        onChange={() => {}}
        defaultMode="editor"
        onUndo={onUndo}
        onRedo={onRedo}
      />,
    );

    expect(latestEditableProps.actions.undo).toBe(onUndo);
    expect(latestEditableProps.actions.redo).toBe(onRedo);

    fireEvent.click(screen.getByRole("button", { name: "markdown" }));

    expect(latestMarkdownProps.onUndo).toBe(onUndo);
    expect(latestMarkdownProps.onRedo).toBe(onRedo);
  });

  it("allows explicit local undo ownership even when callbacks are provided", () => {
    const onUndo = jest.fn();
    const onRedo = jest.fn();

    render(
      <MultiMarkdownInput
        value=""
        onChange={() => {}}
        defaultMode="editor"
        onUndo={onUndo}
        onRedo={onRedo}
        undoMode="local"
        redoMode="local"
      />,
    );

    expect(latestEditableProps.actions.undo).toBeUndefined();
    expect(latestEditableProps.actions.redo).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "markdown" }));

    expect(latestMarkdownProps.onUndo).toBe(onUndo);
    expect(latestMarkdownProps.onRedo).toBe(onRedo);
    expect(latestMarkdownProps.undoMode).toBe("local");
    expect(latestMarkdownProps.redoMode).toBe("local");
  });
});
