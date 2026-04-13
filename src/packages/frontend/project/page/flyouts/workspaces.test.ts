import {
  applyWorkspaceBulkSelection,
  workspaceSelectionTagChoices,
} from "./workspaces";

describe("applyWorkspaceBulkSelection", () => {
  const workspaceIds = ["w1", "w2", "w3", "w4"];

  it("selects a contiguous range on shift-click", () => {
    expect(
      applyWorkspaceBulkSelection({
        workspaceIds,
        selectedIds: ["w2"],
        anchorId: "w2",
        clickedId: "w4",
        nextChecked: true,
        shiftKey: true,
      }),
    ).toEqual({
      selectedIds: ["w2", "w3", "w4"],
      anchorId: "w4",
    });
  });

  it("clears a contiguous range on shift-uncheck", () => {
    expect(
      applyWorkspaceBulkSelection({
        workspaceIds,
        selectedIds: ["w1", "w2", "w3", "w4"],
        anchorId: "w2",
        clickedId: "w4",
        nextChecked: false,
        shiftKey: true,
      }),
    ).toEqual({
      selectedIds: ["w1"],
      anchorId: "w4",
    });
  });

  it("falls back to single selection when no valid anchor exists", () => {
    expect(
      applyWorkspaceBulkSelection({
        workspaceIds,
        selectedIds: ["w1"],
        anchorId: null,
        clickedId: "w3",
        nextChecked: true,
        shiftKey: true,
      }),
    ).toEqual({
      selectedIds: ["w1", "w3"],
      anchorId: "w3",
    });
  });
});

describe("workspaceSelectionTagChoices", () => {
  it("only exposes the built-in top-level filters", () => {
    expect(workspaceSelectionTagChoices()).toEqual([
      {
        key: "all",
        label: "All tabs",
        selection: { kind: "all" },
      },
      {
        key: "unscoped",
        label: "Unscoped",
        selection: { kind: "unscoped" },
      },
    ]);
  });
});
