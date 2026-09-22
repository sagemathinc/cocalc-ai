/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fromJS, Map } from "immutable";
import { render, waitFor } from "@testing-library/react";

const getJupyterActions = jest.fn();
const useRedux = jest.fn();
let cellOutputProps: any;

// CellOutput is mocked below; its MIME renderer registration is outside this test.
jest.mock(
  "@cocalc/frontend/jupyter/output-messages/mime-types/init-frontend",
  () => ({}),
);

jest.mock("@cocalc/frontend/app-framework", () => ({
  useIsMountedRef: () => ({ current: true }),
  useRedux: (...args: any[]) => useRedux(...args),
}));

jest.mock("@cocalc/frontend/jupyter/cell-output", () => ({
  CellOutput: (props: any) => {
    cellOutputProps = props;
    return <div data-testid="cell-output" />;
  },
}));

jest.mock("../../hooks", () => ({
  useFrameContext: () => ({ project_id: "project-1", path: "/test.board" }),
}));

jest.mock("../scroll-wheel", () => () => undefined);

jest.mock("./actions", () => ({
  getJupyterActions: (...args: any[]) => getJupyterActions(...args),
}));

jest.mock("./static", () => ({
  moreOutput: { get: jest.fn(), set: jest.fn() },
}));

import Output from "./output";

describe("whiteboard code output", () => {
  beforeEach(() => {
    cellOutputProps = undefined;
    getJupyterActions.mockReset();
    useRedux.mockReset();
  });

  it("renders transient Jupyter output from the active run overlay", async () => {
    const overlay = fromJS({
      state: "busy",
      output: {
        0: { output_type: "stream", name: "stdout", text: "first\n" },
      },
    });
    const actions = { name: "jupyter-test" };
    getJupyterActions.mockResolvedValue(actions);
    useRedux.mockImplementation(([, key]) => {
      if (key === "runCellOverlays") {
        return Map({ cell1: overlay });
      }
      return Map();
    });

    render(
      <Output
        element={{ id: "cell1", data: { runState: "busy" } }}
        onClick={jest.fn()}
      />,
    );

    await waitFor(() => expect(cellOutputProps).toBeDefined());
    expect(cellOutputProps.runOverlay).toBe(overlay);
    expect(cellOutputProps.cell.get("state")).toBe("busy");
    expect(cellOutputProps.runOverlay.getIn(["output", "0", "text"])).toBe(
      "first\n",
    );
  });
});
