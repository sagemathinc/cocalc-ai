/** @jest-environment jsdom */
import { render } from "@testing-library/react";
import { fromJS } from "immutable";
import { CellNotebook } from "./cell-notebook";
let cells: any;
let rendered: any;
jest.mock("@cocalc/frontend/app-framework", () => ({
  useEffect: require("react").useEffect,
  useRedux: () => cells,
}));
jest.mock("@cocalc/frontend/jupyter/main", () => ({
  JupyterEditor: (props) => {
    rendered = props;
    return null;
  },
}));
it("never renders Studio with loading or nbgrader metadata and retains frame selection", () => {
  const actions = {
    jupyter_actions: { name: "nb" },
    set_frame_type: jest.fn(),
  };
  const props = {
    id: "frame",
    actions,
    desc: fromJS({
      type: "jupyter_studio",
      "data-cur_id": "selected",
      "data-scrollTop": 100,
    }),
  } as any;
  cells = undefined;
  const { rerender } = render(<CellNotebook {...props} />);
  expect(rendered.cellViewMode).toBe("default");
  cells = fromJS({ a: { metadata: {} } });
  rerender(<CellNotebook {...props} />);
  expect(rendered.cellViewMode).toBe("studio");
  cells = fromJS({ a: { metadata: { nbgrader: {} } } });
  rerender(<CellNotebook {...props} />);
  expect(rendered.cellViewMode).toBe("default");
  expect(rendered.cur_id).toBe("selected");
  expect(rendered.scrollTop).toBe(100);
  expect(actions.set_frame_type).toHaveBeenCalledWith(
    "frame",
    "jupyter_cell_notebook",
  );
});
