import { defaultOpenProjectTarget } from "./open-project-default";

describe("defaultOpenProjectTarget", () => {
  it("keeps explicit target unchanged", () => {
    expect(
      defaultOpenProjectTarget({
        target: "files/tmp/",
        activeProjectTab: "files",
      }),
    ).toBe("files/tmp/");
  });

  it("treats empty target as unset and defaults to home/", () => {
    expect(
      defaultOpenProjectTarget({
        target: "",
        activeProjectTab: "files",
      }),
    ).toBe("home/");
  });

  it("defaults to home/ when files tab", () => {
    expect(
      defaultOpenProjectTarget({
        target: undefined,
        activeProjectTab: "files",
      }),
    ).toBe("home/");
  });

  it("defaults to home/ when files tab even if files are open", () => {
    expect(
      defaultOpenProjectTarget({
        target: undefined,
        activeProjectTab: "files",
      }),
    ).toBe("home/");
  });

  it("does not default when active tab is an editor", () => {
    expect(
      defaultOpenProjectTarget({
        target: undefined,
        activeProjectTab: "editor-/root/a.txt",
      }),
    ).toBeUndefined();
  });

  it("does not default when active tab is not files", () => {
    expect(
      defaultOpenProjectTarget({
        target: undefined,
        activeProjectTab: "settings",
      }),
    ).toBeUndefined();
  });

  it("defaults to home/ when active tab is unset", () => {
    expect(
      defaultOpenProjectTarget({
        target: undefined,
        activeProjectTab: undefined,
      }),
    ).toBe("home/");
  });
});
