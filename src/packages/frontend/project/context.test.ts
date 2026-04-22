import {
  resolveHiddenActiveTabForSelection,
  selectionForOutOfScopeFileExplorerPath,
  shouldResyncWorkspaceSelectionFromActivePath,
} from "./context";

describe("resolveHiddenActiveTabForSelection", () => {
  it("shows the file explorer when no open tab remains in the selected scope", () => {
    expect(
      resolveHiddenActiveTabForSelection({
        activeProjectTab: "editor-/repo/workspace/file.ts",
        orderedPaths: ["/repo/workspace/file.ts"],
        matchesPath: (path) => !path.startsWith("/repo/workspace/"),
      }),
    ).toEqual({ kind: "show-files" });
  });

  it("activates the first visible open tab in the selected scope", () => {
    expect(
      resolveHiddenActiveTabForSelection({
        activeProjectTab: "editor-/repo/workspace/file.ts",
        orderedPaths: ["/repo/workspace/file.ts", "/repo/unscoped/notes.md"],
        matchesPath: (path) => path.startsWith("/repo/unscoped/"),
      }),
    ).toEqual({
      kind: "activate-path",
      path: "/repo/unscoped/notes.md",
    });
  });

  it("keeps the current editor when it is still visible", () => {
    expect(
      resolveHiddenActiveTabForSelection({
        activeProjectTab: "editor-/repo/unscoped/notes.md",
        orderedPaths: ["/repo/unscoped/notes.md"],
        matchesPath: (path) => path.startsWith("/repo/unscoped/"),
      }),
    ).toEqual({ kind: "noop" });
  });

  it("ignores non-editor tabs", () => {
    expect(
      resolveHiddenActiveTabForSelection({
        activeProjectTab: "files",
        orderedPaths: ["/repo/unscoped/notes.md"],
        matchesPath: () => true,
      }),
    ).toEqual({ kind: "noop" });
  });
});

describe("selectionForOutOfScopeFileExplorerPath", () => {
  const records = [
    {
      workspace_id: "home",
      project_id: "project-1",
      root_path: "/home/user",
      title: "Home",
      theme: { title: "Home" },
      created_at: 0,
      updated_at: 0,
    },
    {
      workspace_id: "repo",
      project_id: "project-1",
      root_path: "/home/user/repo",
      title: "Repo",
      theme: { title: "Repo" },
      created_at: 0,
      updated_at: 0,
    },
  ] as any;

  it("switches from a nested workspace to the containing workspace", () => {
    expect(
      selectionForOutOfScopeFileExplorerPath({
        currentPath: "/home/user/.snapshots",
        currentRootPath: "/home/user/repo",
        currentSelection: { kind: "workspace", workspace_id: "repo" },
        records,
        selectionChanged: false,
      }),
    ).toEqual({ kind: "workspace", workspace_id: "home" });
  });

  it("does not undo an explicit workspace selection change", () => {
    expect(
      selectionForOutOfScopeFileExplorerPath({
        currentPath: "/home/user/.snapshots",
        currentRootPath: "/home/user/repo",
        currentSelection: { kind: "workspace", workspace_id: "repo" },
        records,
        selectionChanged: true,
      }),
    ).toBeNull();
  });
});

describe("shouldResyncWorkspaceSelectionFromActivePath", () => {
  it("does not descope back to the old active file while workspace restore is pending", () => {
    expect(
      shouldResyncWorkspaceSelectionFromActivePath({
        workspaceRestorePending: true,
        activePath: "/repo/unscoped/notes.md",
        activePathIsOpen: true,
        selectionChanged: false,
        previousActivePathClosed: false,
      }),
    ).toBe(false);
  });

  it("allows resync once restore is no longer pending", () => {
    expect(
      shouldResyncWorkspaceSelectionFromActivePath({
        workspaceRestorePending: false,
        activePath: "/repo/unscoped/notes.md",
        activePathIsOpen: true,
        selectionChanged: false,
        previousActivePathClosed: false,
      }),
    ).toBe(true);
  });
});
