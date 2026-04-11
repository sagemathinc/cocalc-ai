import { resolveHiddenActiveTabForSelection } from "./context";

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
