import { act, render } from "@testing-library/react";
import DescriptionEditor from "./desc-editor";

let latestMarkdownEditorProps: any;

jest.mock("antd", () => ({
  Button: ({ children, onClick }: any) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

jest.mock("@cocalc/frontend/components/icon", () => ({
  Icon: () => <span>icon</span>,
}));

jest.mock("@cocalc/frontend/components/color-picker", () => ({
  __esModule: true,
  default: () => <div>color-picker</div>,
}));

jest.mock("./default-adapters", () => ({
  createTasksHostServices: (actions: any) => ({
    enableKeyHandler: () => actions.enable_key_handler(),
    disableKeyHandler: () => actions.disable_key_handler(),
    save: () => actions.save(),
    undo: () => actions.undo(),
    redo: () => actions.redo(),
  }),
  defaultTasksMarkdownSurface: {
    MarkdownEditor: (props: any) => {
      latestMarkdownEditorProps = props;
      return <div>markdown-editor</div>;
    },
  },
}));

describe("DescriptionEditor", () => {
  beforeEach(() => {
    latestMarkdownEditorProps = undefined;
  });

  it("saves and exits edit mode on blur", () => {
    const actions = {
      set_desc: jest.fn(),
      stop_editing_desc: jest.fn(),
      enable_key_handler: jest.fn(),
      disable_key_handler: jest.fn(),
      save: jest.fn(),
      undo: jest.fn(),
      redo: jest.fn(),
      set_color: jest.fn(),
    } as any;

    render(
      <DescriptionEditor
        actions={actions}
        task_id="task-1"
        desc="before"
        font_size={14}
      />,
    );

    act(() => {
      latestMarkdownEditorProps.onBlur("after");
    });

    expect(actions.set_desc).toHaveBeenCalledWith("task-1", "after", true);
    expect(actions.stop_editing_desc).toHaveBeenCalledWith("task-1");
    expect(actions.enable_key_handler).toHaveBeenCalledTimes(1);
  });
});
