/** @jest-environment jsdom */

// The raw JSON editor is read-only until the notebook's initial source
// settled (a customer report).  JSONEditor keeps the first on_change it
// gets, so on_change must always reach setIpynbFromRawEditor, whose own check
// uses the live state: a callback that captured "not editable" at mount
// would drop every edit after settling.

import { render } from "@testing-library/react";
import { Map } from "immutable";

let state: Record<string, any> = {};
let jsonEditorProps: any;

jest.mock("@cocalc/frontend/app-framework", () => {
  const actual = jest.requireActual("@cocalc/frontend/app-framework");
  return {
    ...actual,
    useRedux: ([, key]: string[]) => state[key],
  };
});

jest.mock("@cocalc/frontend/course", () => ({
  useStudentProjectFunctionality: () => ({}),
}));

jest.mock("../json-editor", () => ({
  JSONEditor: (props: any) => {
    jsonEditorProps = props;
    return null;
  },
}));

import { RawEditor } from "../raw-editor";

function renderEditor() {
  const actions: any = {
    set_raw_ipynb: jest.fn(),
    setIpynbFromRawEditor: jest.fn(),
    undo: jest.fn(),
    redo: jest.fn(),
  };
  const view = render(
    <RawEditor
      name="jupyter-test"
      actions={actions}
      font_size={14}
      cm_options={Map({})}
      project_id="p"
    />,
  );
  return { actions, view };
}

describe("RawEditor before and after the initial source settles", () => {
  it("is read-only before settling, editable after, and always delegates edits", () => {
    state = { raw_ipynb: Map({ cells: [] }), initial_source_settled: false };
    const { actions, view } = renderEditor();
    expect(jsonEditorProps.cm_options.get("readOnly")).toBe(true);
    const firstOnChange = jsonEditorProps.on_change;

    state = { ...state, initial_source_settled: true };
    view.rerender(
      <RawEditor
        name="jupyter-test"
        actions={actions}
        font_size={14}
        cm_options={Map({})}
        project_id="p"
      />,
    );
    expect(jsonEditorProps.cm_options.get("readOnly")).toBeUndefined();

    // The callback JSONEditor kept from the first render still delivers.
    firstOnChange({ cells: [] });
    expect(actions.setIpynbFromRawEditor).toHaveBeenCalledTimes(1);
  });
});
