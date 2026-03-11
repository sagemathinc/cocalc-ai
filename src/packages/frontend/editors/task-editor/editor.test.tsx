import { render } from "@testing-library/react";
import { fromJS } from "immutable";
import { TaskEditor } from "./editor";

const mockUseEditorRedux = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  useEditorRedux: (...args) => mockUseEditorRedux(...args),
}));

jest.mock("@cocalc/frontend/antd-bootstrap", () => ({
  Col: ({ children }) => <div>{children}</div>,
  Row: ({ children }) => <div>{children}</div>,
}));

jest.mock("@cocalc/frontend/components", () => ({
  Loading: () => <div>loading</div>,
}));

jest.mock("@cocalc/frontend/components/icon", () => ({
  Icon: () => <span>icon</span>,
}));

jest.mock("./desc-visible", () => ({
  DescVisible: () => <div>desc-visible</div>,
}));

jest.mock("./find", () => ({
  Find: () => <div>find</div>,
}));

jest.mock("./hashtag-bar", () => ({
  HashtagBar: () => <div>hashtags</div>,
}));

jest.mock("./headings", () => ({
  Headings: () => <div>headings</div>,
}));

jest.mock("./list", () => ({
  __esModule: true,
  default: () => <div>task-list</div>,
}));

describe("TaskEditor key handler lifecycle", () => {
  beforeEach(() => {
    mockUseEditorRedux.mockReturnValue((key: string) => {
      if (key === "tasks") {
        return fromJS({
          "task-1": {
            task_id: "task-1",
            desc: "task",
          },
        });
      }
      return undefined;
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("re-enables the global key handler when the task tab becomes visible again", () => {
    const actions = {
      enable_key_handler: jest.fn(),
      disable_key_handler: jest.fn(),
      setFrameData: jest.fn(),
    } as any;
    const desc = fromJS({
      "data-visible": ["task-1"],
      "data-local_task_state": {},
      "data-local_view_state": {
        sort: {
          column: "Custom",
          dir: "asc",
        },
      },
      "data-hashtags": [],
      "data-counts": { done: 0, deleted: 0 },
    });

    const { rerender, unmount } = render(
      <TaskEditor
        actions={actions}
        project_id="project-1"
        path="tasks.tasks"
        desc={desc}
        tab_is_visible={false}
      />,
    );

    expect(actions.enable_key_handler).not.toHaveBeenCalled();
    expect(actions.disable_key_handler).toHaveBeenCalledTimes(1);

    rerender(
      <TaskEditor
        actions={actions}
        project_id="project-1"
        path="tasks.tasks"
        desc={desc}
        tab_is_visible={true}
      />,
    );

    expect(actions.enable_key_handler).toHaveBeenCalledTimes(1);
    expect(actions.disable_key_handler).toHaveBeenCalledTimes(1);

    unmount();
    expect(actions.disable_key_handler).toHaveBeenCalledTimes(2);
  });

  it("keeps the global key handler disabled while the filter box is focused", () => {
    const actions = {
      enable_key_handler: jest.fn(),
      disable_key_handler: jest.fn(),
      setFrameData: jest.fn(),
    } as any;
    const desc = fromJS({
      "data-visible": ["task-1"],
      "data-local_task_state": {},
      "data-local_view_state": {
        sort: {
          column: "Custom",
          dir: "asc",
        },
      },
      "data-hashtags": [],
      "data-counts": { done: 0, deleted: 0 },
      "data-focus_find_box": false,
    }) as any;

    const { rerender } = render(
      <TaskEditor
        actions={actions}
        project_id="project-1"
        path="tasks.tasks"
        desc={desc}
      />,
    );

    expect(actions.enable_key_handler).toHaveBeenCalledTimes(1);

    rerender(
      <TaskEditor
        actions={actions}
        project_id="project-1"
        path="tasks.tasks"
        desc={desc
          .set("data-focus_find_box", true)
          .set("data-visible", fromJS(["task-1"]))}
      />,
    );

    expect(actions.enable_key_handler).toHaveBeenCalledTimes(1);
    expect(actions.disable_key_handler).toHaveBeenCalledTimes(2);
  });
});
