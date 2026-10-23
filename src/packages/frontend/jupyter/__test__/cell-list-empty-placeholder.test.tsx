/** @jest-environment jsdom */

// An empty notebook is read-only until its initial source settled (a
// customer report); meanwhile the cell list must still show the placeholder,
// whose loading state tells the user the notebook is not loaded yet.

import { render, screen } from "@testing-library/react";
import { List } from "immutable";

let settled = false;

jest.mock("@cocalc/frontend/app-framework", () => {
  const actual = jest.requireActual("@cocalc/frontend/app-framework");
  return {
    ...actual,
    useRedux: ([name, key]: string[]) =>
      name === "jupyter-test" && key === "initial_source_settled"
        ? settled
        : undefined,
  };
});

jest.mock("../empty-notebook-placeholder", () => ({
  EmptyNotebookPlaceholder: () => <div>empty-notebook-placeholder</div>,
}));

import { CellList, showEmptyNotebookPlaceholder } from "../cell-list";

describe("the empty notebook placeholder", () => {
  it("is shown while an empty notebook is read-only until it settles", () => {
    settled = false;
    render(
      <CellList
        {...({
          actions: { name: "jupyter-test" },
          cell_list: List(),
          read_only: true,
          name: "jupyter-test",
        } as any)}
      />,
    );
    expect(screen.getByText("empty-notebook-placeholder")).toBeTruthy();
  });

  it("follows read-only once settled, and always shows while editable", () => {
    const base = { cellCount: 0, hasActions: true };
    expect(
      showEmptyNotebookPlaceholder({
        ...base,
        readOnly: true,
        initialSourceSettled: false,
      }),
    ).toBe(true);
    expect(
      showEmptyNotebookPlaceholder({
        ...base,
        readOnly: true,
        initialSourceSettled: true,
      }),
    ).toBe(false);
    expect(
      showEmptyNotebookPlaceholder({
        ...base,
        readOnly: false,
        initialSourceSettled: true,
      }),
    ).toBe(true);
    expect(
      showEmptyNotebookPlaceholder({
        ...base,
        cellCount: 1,
        readOnly: false,
        initialSourceSettled: false,
      }),
    ).toBe(false);
  });
});
