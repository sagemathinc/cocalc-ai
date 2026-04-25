/** @jest-environment jsdom */

import { fromJS, List } from "immutable";
import { render, screen } from "@testing-library/react";
import { HistoryViewer } from "./history-viewer";

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

  it("does not pass live notebook actions into the readonly history cell list", () => {
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
      />,
    );

    expect(screen.getByTestId("history-cell-list")).toBeInTheDocument();
    expect(capturedCellListProps).toBeDefined();
    expect(capturedCellListProps.read_only).toBe(true);
    expect(capturedCellListProps.actions).toBeUndefined();
    expect(capturedCellListProps.cell_list.toJS()).toEqual(["cell-1"]);
  });
});
