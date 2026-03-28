import {
  buildProjectFilesTarget,
  buildProjectScopedTarget,
  parseProjectTarget,
} from "./project-routing";

function decodeDirectoryPath(path: string): string {
  if (!path) {
    return "/";
  }
  return path.startsWith("/") ? path : `/${path}`;
}

describe("project-routing", () => {
  it("builds canonical file and scoped targets", () => {
    const encodeRelativePath = (path: string) =>
      path === "/" ? "" : path.replace(/^\/+/, "");

    expect(buildProjectFilesTarget("/", true, { encodeRelativePath })).toBe(
      "files/",
    );
    expect(
      buildProjectFilesTarget("/work/notes.md", false, { encodeRelativePath }),
    ).toBe("files/work/notes.md");
    expect(
      buildProjectScopedTarget("new", "/work", { encodeRelativePath }),
    ).toBe("new/work");
    expect(
      buildProjectScopedTarget("search", "/", { encodeRelativePath }),
    ).toBe("search/");
  });

  it("parses file and directory targets", () => {
    expect(parseProjectTarget("files/", { decodeDirectoryPath })).toEqual({
      kind: "directory",
      path: "/",
    });
    expect(
      parseProjectTarget("files/work/notes.md", { decodeDirectoryPath }),
    ).toEqual({
      kind: "file",
      path: "/work/notes.md",
      parentPath: "/work",
    });
    expect(
      parseProjectTarget("files/work/folder/", { decodeDirectoryPath }),
    ).toEqual({
      kind: "directory",
      path: "/work/folder",
    });
  });

  it("parses new and search targets, including legacy scoped-path forms", () => {
    expect(parseProjectTarget("new/work", { decodeDirectoryPath })).toEqual({
      kind: "new",
      path: "/work",
    });
    expect(
      parseProjectTarget("search/files/work/notes", { decodeDirectoryPath }),
    ).toEqual({
      kind: "search",
      path: "/work/notes",
    });
  });

  it("parses fixed tabs and apps", () => {
    expect(parseProjectTarget("project-home", { decodeDirectoryPath })).toEqual(
      {
        kind: "tab",
        tab: "project-home",
      },
    );
    expect(parseProjectTarget("settings", { decodeDirectoryPath })).toEqual({
      kind: "tab",
      tab: "settings",
    });
    expect(
      parseProjectTarget("apps/jupyter/lab", { decodeDirectoryPath }),
    ).toEqual({
      kind: "app",
      path: "jupyter/lab",
    });
  });
});
