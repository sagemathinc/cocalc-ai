import { fireEvent, render } from "@testing-library/react";
import { fromJS } from "immutable";
import TaskList from "./list";

jest.mock("@cocalc/frontend/components/stateful-virtuoso", () => ({
  __esModule: true,
  default: ({
    totalCount,
    itemContent,
  }: {
    totalCount: number;
    itemContent: (index: number) => React.ReactNode;
  }) => (
    <div data-testid="task-list-virtuoso">
      {Array.from({ length: totalCount }, (_, index) => (
        <div key={index}>{itemContent(index)}</div>
      ))}
    </div>
  ),
}));

jest.mock("./task", () => ({
  __esModule: true,
  default: () => <div data-testid="task-card">task</div>,
}));

describe("TaskList", () => {
  it("does not re-enable the global key handler when clicking list whitespace", () => {
    const actions = {
      enable_key_handler: jest.fn(),
    } as any;

    const { container } = render(
      <TaskList
        actions={actions}
        tasks={
          fromJS({
            "task-1": {
              task_id: "task-1",
              desc: "task",
            },
          }) as any
        }
        visible={fromJS(["task-1"])}
        font_size={14}
      />,
    );

    fireEvent.click(container.querySelector(".smc-vfill")!);
    expect(actions.enable_key_handler).not.toHaveBeenCalled();
  });
});
