import {
  getDocsAction,
  getDocsEntry,
  listDocsChapters,
  listDocsEntries,
  searchDocsEntries,
  type DocsAccess,
} from "@cocalc/docs";
import { getPublicDocsAccess } from "@cocalc/frontend/public/config";

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
        "terminal.graphical-applications",
        "files.project-files",
        "files.explorer",
        "files.markdown",
        "files.slides",
        "files.whiteboard",
        "projects.tasks",
        "jupyter.create-notebook",
        "jupyter.use-jupyter",
        // the Studio view is a frontend layout choice, so it applies to the
        // single local project the same as anywhere else
        "jupyter.studio-view",
        "troubleshooting.jupyter-kernel-terminated",
        "jupyter.custom-kernels",
        "python.use-python",
        "latex.build-papers",
        "editors.r-markdown",
        "troubleshooting.memory",
        "files.timetravel",
        "files.git",
        // Quick Navigation is a frontend feature that works in the single
        // local project as well
        "docs.quick-navigation",
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
        "Docs",
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

describe("feature-gated docs", () => {
  it("only exposes Managed Compute VM docs when the feature is enabled", () => {
    expect(getDocsEntry("projects/virtual-machines")).toBeUndefined();
    expect(
      searchDocsEntries("managed compute virtual machines", 10).map(
        (entry) => entry.id,
      ),
    ).not.toContain("projects.virtual-machines");

    const access: DocsAccess = { features: ["compute-vms"] };
    expect(getDocsEntry("projects/virtual-machines", access)?.id).toBe(
      "projects.virtual-machines",
    );
    expect(
      searchDocsEntries("managed compute virtual machines", 10, access).map(
        (entry) => entry.id,
      ),
    ).toContain("projects.virtual-machines");
  });

  it("derives VM documentation access from public site configuration", () => {
    expect(
      getDocsEntry(
        "projects/virtual-machines",
        getPublicDocsAccess({ compute_vm_enabled: false }),
      ),
    ).toBeUndefined();
    expect(
      getDocsEntry(
        "projects/virtual-machines",
        getPublicDocsAccess({ compute_vm_enabled: true }),
      )?.id,
    ).toBe("projects.virtual-machines");
  });
});
