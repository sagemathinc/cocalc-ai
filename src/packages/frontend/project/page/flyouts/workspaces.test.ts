import {
  applyWorkspaceBulkSelection,
  getWorkspaceStarredItems,
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

describe("getWorkspaceStarredItems", () => {
  const record = {
    workspace_id: "w1",
    project_id: "project-1",
    root_path: "/home/user/project",
    title: "Project",
    theme: { title: "Project" },
    created_at: 0,
    updated_at: 0,
  } as any;

  it("filters starred paths to the workspace root and labels them relatively", () => {
    expect(
      getWorkspaceStarredItems(record, [
        "/home/user/other.txt",
        "/home/user/project/zeta.txt",
        "/home/user/project/notebooks/",
        "/home/user/project/alpha.md",
      ]),
    ).toEqual([
      {
        path: "/home/user/project/alpha.md",
        label: "alpha.md",
        isDirectory: false,
      },
      {
        path: "/home/user/project/notebooks/",
        label: "notebooks",
        isDirectory: true,
      },
      {
        path: "/home/user/project/zeta.txt",
        label: "zeta.txt",
        isDirectory: false,
      },
    ]);
  });

  it("includes a starred workspace root directory", () => {
    expect(getWorkspaceStarredItems(record, ["/home/user/project/"])).toEqual([
      {
        path: "/home/user/project/",
        label: ".",
        isDirectory: true,
      },
    ]);
  });
});
