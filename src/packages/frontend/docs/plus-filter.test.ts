import {
  getDocsAction,
  getDocsEntry,
  listDocsChapters,
  listDocsEntries,
  searchDocsEntries,
  type DocsAccess,
} from "@cocalc/docs";

const plusAccess: DocsAccess = { product: "plus" };

describe("CoCalc Plus docs filter", () => {
  it("limits navigation to one-local-project docs", () => {
    const ids = new Set(listDocsEntries(plusAccess).map((entry) => entry.id));
    const categories = new Set(
      listDocsChapters(plusAccess).map((chapter) => chapter.category),
    );

    expect(ids).toEqual(
      new Set([
        "projects.open-terminal",
        "terminal.use-terminal",
        "files.project-files",
        "files.explorer",
        "files.markdown",
        "files.slides",
        "files.whiteboard",
        "projects.tasks",
        "jupyter.create-notebook",
        "jupyter.use-jupyter",
        "troubleshooting.jupyter-kernel-terminated",
        "jupyter.custom-kernels",
        "python.use-python",
        "latex.build-papers",
        "editors.r-markdown",
        "troubleshooting.memory",
        "files.timetravel",
        "files.git",
      ]),
    );
    expect(categories).toEqual(
      new Set([
        "Projects",
        "Terminal",
        "Files",
        "Jupyter",
        "Python",
        "LaTeX",
        "R",
        "Troubleshooting",
      ]),
    );
  });

  it("filters direct links, search, and actions for non-Plus features", () => {
    expect(getDocsEntry("projects/open-terminal", plusAccess)?.id).toBe(
      "projects.open-terminal",
    );
    expect(getDocsEntry("projects/collaborators", plusAccess)).toBeUndefined();
    expect(getDocsEntry("hosts/project-hosts", plusAccess)).toBeUndefined();
    expect(getDocsEntry("admin/users", plusAccess)).toBeUndefined();
    expect(getDocsEntry("documentation/browser", plusAccess)).toBeUndefined();

    expect(
      searchDocsEntries("collaborators", 10, plusAccess).map(
        (entry) => entry.id,
      ),
    ).not.toContain("projects.collaborators");
    expect(
      searchDocsEntries("project hosts", 10, plusAccess).map(
        (entry) => entry.id,
      ),
    ).not.toContain("hosts.project-hosts");

    expect(getDocsAction("project.terminal.open", plusAccess)?.id).toBe(
      "project.terminal.open",
    );
    expect(getDocsAction("settings.people.collaborators", plusAccess)).toBe(
      undefined,
    );
    expect(getDocsAction("hosts.open", plusAccess)).toBeUndefined();
    expect(getDocsAction("projects.create.open", plusAccess)).toBeUndefined();
    expect(getDocsAction("docs.browser.open", plusAccess)).toBeUndefined();
  });
});
