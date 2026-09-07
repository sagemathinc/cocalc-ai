/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fromJS, Map } from "immutable";
import { render, screen } from "@testing-library/react";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

let mockStudioCellProps: any;
let mockCellOutputProps: any;

jest.mock("@cocalc/frontend/app-framework", () => ({
  React: require("react"),
  CSS: {},
  useDelayedRender: () => true,
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }) => <span>{name}</span>,
  Tip: ({ children }) => <>{children}</>,
}));

jest.mock("@cocalc/frontend/feature", () => ({
  IS_TOUCH: false,
}));

jest.mock(
  "@cocalc/frontend/frame-editors/jupyter-editor/cell-notebook/hook",
  () => ({
    __esModule: true,
    default: () => ({ current: undefined }),
  }),
);

jest.mock("./cell-input", () => ({
  CellInput: () => null,
}));

jest.mock("./cell-output", () => ({
  CellOutput: (props) => {
    mockCellOutputProps = props;
    return <div data-testid="cell-output" />;
  },
}));

jest.mock("./insert-cell", () => ({
  InsertCell: () => null,
}));

jest.mock("./studio/studio-cell", () => ({
  StudioCell: (props) => {
    mockStudioCellProps = props;
    return <div data-testid="studio-cell" />;
  },
}));

jest.mock("./nbgrader/cell-metadata", () => ({
  NBGraderMetadata: () => null,
}));

jest.mock("./prompt/base", () => ({
  INPUT_PROMPT_COLOR: "#000",
}));

import { Cell } from "./cell";

describe("Cell in studio view mode", () => {
  beforeEach(() => {
    mockStudioCellProps = undefined;
    mockCellOutputProps = undefined;
  });

  const cell = fromJS({ id: "cell-1", cell_type: "code", input: "1+1" });

  it("forwards transient execution state (stdin, runOverlay, isDragging) to StudioCell", () => {
    const stdin = fromJS({ id: "cell-1", prompt: "value: " });
    const runOverlay = fromJS({ state: "busy", start: 100, end: null });
    render(
      <Cell
        cell={cell}
        cm_options={Map()}
        mode="escape"
        font_size={14}
        cellViewMode="studio"
        stdin={stdin}
        runOverlay={runOverlay}
        isDragging={true}
      />,
    );
    expect(screen.getByTestId("studio-cell")).toBeInTheDocument();
    expect(mockStudioCellProps.stdin).toBe(stdin);
    expect(mockStudioCellProps.runOverlay).toBe(runOverlay);
    expect(mockStudioCellProps.isDragging).toBe(true);
    expect(mockStudioCellProps.cell.get("state")).toBe("busy");
    expect(mockStudioCellProps.cell.get("start")).toBe(100);
    // and the regular cell renderer is not used
    expect(screen.queryByTestId("cell-output")).toBeNull();
  });

  it("uses the regular renderer when cellViewMode is not studio", () => {
    render(
      <Cell cell={cell} cm_options={Map()} mode="escape" font_size={14} />,
    );
    expect(screen.queryByTestId("studio-cell")).toBeNull();
    expect(screen.getByTestId("cell-output")).toBeInTheDocument();
    expect(mockCellOutputProps.stdin).toBeUndefined();
  });

  it("uses a live semantic selection surface without replacing the output", () => {
    const { container, rerender } = render(
      <Cell
        cell={cell}
        cm_options={Map()}
        mode="escape"
        font_size={14}
        is_selected
      />,
    );
    const output = screen.getByTestId("cell-output");
    expect(
      Array.from(container.querySelectorAll<HTMLElement>("div")).some(
        (element) => element.style.background === UI_COLORS.selected,
      ),
    ).toBe(true);
    rerender(
      <Cell cell={cell} cm_options={Map()} mode="escape" font_size={14} />,
    );
    expect(screen.getByTestId("cell-output")).toBe(output);
    expect(
      Array.from(container.querySelectorAll<HTMLElement>("div")).some(
        (element) => element.style.background === UI_COLORS.selected,
      ),
    ).toBe(false);
  });
});
