import { defaultOpenProjectTarget } from "./open-project-default";

describe("defaultOpenProjectTarget", () => {
  it("keeps explicit target unchanged", () => {
    expect(
      defaultOpenProjectTarget({
        target: "files/tmp/",
        activeProjectTab: "files",
        hasOpenFiles: false,
      }),
    ).toBe("files/tmp/");
  });

  it("defaults to home/ when files tab and no open files", () => {
    expect(
      defaultOpenProjectTarget({
        target: undefined,
        activeProjectTab: "files",
        hasOpenFiles: false,
      }),
    ).toBe("home/");
  });

  it("does not default when there are open files", () => {
    expect(
      defaultOpenProjectTarget({
        target: undefined,
        activeProjectTab: "files",
        hasOpenFiles: true,
      }),
    ).toBeUndefined();
  });

  it("does not default when active tab is not files", () => {
    expect(
      defaultOpenProjectTarget({
        target: undefined,
        activeProjectTab: "settings",
        hasOpenFiles: false,
      }),
    ).toBeUndefined();
  });

  it("defaults to home/ when active tab is unset and no open files", () => {
    expect(
      defaultOpenProjectTarget({
        target: undefined,
        activeProjectTab: undefined,
        hasOpenFiles: false,
      }),
    ).toBe("home/");
  });
});
