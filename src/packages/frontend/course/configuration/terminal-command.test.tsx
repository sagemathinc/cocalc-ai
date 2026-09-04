/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { fromJS, List } from "immutable";
import { OutputSummary, RenderOutput } from "./terminal-command";
import type { TerminalCommandOutput } from "../store";

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {},
  useActions: jest.fn(),
  useRedux: jest.fn(),
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: { name: string }) => <span>{name}</span>,
}));

jest.mock("@cocalc/frontend/course/common/help-popover", () => () => null);
jest.mock("@cocalc/frontend/i18n", () => ({ course: {}, labels: {} }));
jest.mock(
  "@cocalc/util/theme",
  () => ({
    COLORS: { ANTD_RED: "red" },
  }),
  { virtual: true },
);
jest.mock("../student-projects/actions", () => ({ MAX_PARALLEL_TASKS: 1 }));

describe("terminal command results", () => {
  it("announces complete success and failure counts", () => {
    const output = fromJS([
      { project_id: "1", status: "succeeded", exit_code: 0 },
      { project_id: "2", status: "failed", exit_code: 2 },
      { project_id: "3", status: "timed_out", exit_code: -1 },
    ]) as List<TerminalCommandOutput>;

    render(<OutputSummary output={output} expectedCount={4} running={true} />);

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Completed 3 of 4 projects");
    expect(status).toHaveTextContent("1 succeeded, 1 failed, 1 timed out.");
  });

  it("labels command and startup timeouts explicitly", () => {
    const { rerender } = render(
      <RenderOutput
        title="Student project"
        status="timed_out"
        phase="running"
      />,
    );
    expect(screen.getByText("Terminal command timed out.")).toBeVisible();

    rerender(
      <RenderOutput
        title="Student project"
        status="timed_out"
        phase="starting"
      />,
    );
    expect(
      screen.getByText("Timed out while starting the project."),
    ).toBeVisible();
  });
});
