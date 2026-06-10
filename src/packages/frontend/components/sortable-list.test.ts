import { getSortableDragIndices } from "./sortable-list";

describe("getSortableDragIndices", () => {
  const items = ["one", "two", "three", "four"];

  it("returns old and new indices for a valid drop target", () => {
    expect(
      getSortableDragIndices({
        items,
        activeId: "two",
        overId: "three",
      }),
    ).toEqual([1, 2]);
  });

  it("does not guess a target when the drop target is missing", () => {
    expect(
      getSortableDragIndices({
        items,
        activeId: "two",
        overId: null,
      }),
    ).toBeUndefined();
  });

  it("ignores stale ids that are no longer in the list", () => {
    expect(
      getSortableDragIndices({
        items,
        activeId: "two",
        overId: "missing",
      }),
    ).toBeUndefined();
  });

  it("ignores drops over the active item", () => {
    expect(
      getSortableDragIndices({
        items,
        activeId: "two",
        overId: "two",
      }),
    ).toBeUndefined();
  });
});
