/** @jest-environment jsdom */

import { fromJS, List } from "immutable";
import { render, screen } from "@testing-library/react";
import { HistoryViewer } from "./history-viewer";
import { ReadonlyNotebook } from "./readonly-notebook";

let capturedCellListProps: any;

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: jest.fn(() => undefined),
  redux: {
    getEditorActions: jest.fn(() => ({
      jupyter_actions: {
        processRenderedMarkdown: jest.fn(),
      },
    })),
  },
}));

jest.mock("@cocalc/frontend/components", () => ({
  ErrorDisplay: () => null,
}));

jest.mock("./cell-list", () => ({
  CellList: (props) => {
    capturedCellListProps = props;
    return <div data-testid="history-cell-list" />;
  },
}));

jest.mock("./cm_options", () => ({
  cm_options: jest.fn(() => ({ lineNumbers: true })),
}));

jest.mock("./main", () => ({
  ERROR_STYLE: {},
}));

describe("Jupyter HistoryViewer", () => {
  beforeEach(() => {
    capturedCellListProps = undefined;
  });

  it("waits for the generic history document to load", () => {
    render(
      <HistoryViewer
        project_id="project-1"
        path="analysis.ipynb"
        doc={undefined}
      />,
    );
    expect(capturedCellListProps).toBeUndefined();
  });

  it("renders updated observed cells without retaining deleted cells or acquiring actions", () => {
    let cells = List([
      fromJS({
        type: "cell",
        id: "a",
        pos: 0,
        cell_type: "code",
        input: "old",
      }),
    ]);
    const doc = { get: () => cells };
    const props = { project_id: "project-1", path: "analysis.ipynb", doc };
    const view = render(<ReadonlyNotebook {...props} />);
    expect(capturedCellListProps.cells.getIn(["a", "input"])).toBe("old");
    cells = List([
      fromJS({
        type: "cell",
        id: "b",
        pos: 2,
        cell_type: "code",
        input: "unsaved edit",
      }),
      fromJS({
        type: "cell",
        id: "c",
        pos: 1,
        cell_type: "markdown",
        input: "heading",
      }),
    ]);
    view.rerender(<ReadonlyNotebook {...props} />);
    expect(capturedCellListProps.cell_list.toJS()).toEqual(["c", "b"]);
    expect(capturedCellListProps.cells.has("a")).toBe(false);
    expect(capturedCellListProps.cells.getIn(["b", "input"])).toBe(
      "unsaved edit",
    );
    expect(capturedCellListProps.actions).toBeUndefined();
    expect(capturedCellListProps.trust).toBe(false);
    expect(capturedCellListProps.read_only).toBe(true);
    view.unmount();
    expect(cells.size).toBe(2);
  });

  it("does not pass live notebook actions into the readonly history cell list", () => {
    const scrollPosition = { current: 320 };
    const doc = {
      get: (query) => {
        if (query?.type === "cell") {
          return List([
            fromJS({
              type: "cell",
              id: "cell-1",
              pos: 0,
              cell_type: "markdown",
              input: "hello",
            }),
          ]);
        }
        return undefined;
      },
    };

    render(
      <HistoryViewer
        project_id="project-1"
        path="/home/user/test.ipynb"
        doc={doc as any}
        font_size={14}
        scrollPosition={scrollPosition}
      />,
    );

    expect(screen.getByTestId("history-cell-list")).toBeInTheDocument();
    expect(capturedCellListProps).toBeDefined();
    expect(capturedCellListProps.read_only).toBe(true);
    expect(capturedCellListProps.actions).toBeUndefined();
    expect(capturedCellListProps.cell_list.toJS()).toEqual(["cell-1"]);
    expect(capturedCellListProps.scrollPosition).toBe(scrollPosition);
  });
});
