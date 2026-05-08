import { Map as ImmutableMap } from "immutable";

import { getRecoverableActiveEditorPath } from "./active-editor-recovery";

describe("active editor recovery", () => {
  it("selects the visible active editor when it is stuck on a loading component", () => {
    expect(
      getRecoverableActiveEditorPath({
        isActive: true,
        activeTopTab: "project-1",
        projectId: "project-1",
        activeProjectTab: "editor-main.term",
        openFiles: ImmutableMap({
          "main.term": ImmutableMap({ component: {} }),
        }),
      }),
    ).toBe("main.term");
  });

  it("does not recover inactive projects, fixed tabs, missing tabs, or hydrated editors", () => {
    const openFiles = ImmutableMap({
      "main.term": ImmutableMap({
        component: {
          Editor: () => null,
          redux_name: "editor-main",
        },
      }),
    });

    expect(
      getRecoverableActiveEditorPath({
        isActive: false,
        activeTopTab: "project-1",
        projectId: "project-1",
        activeProjectTab: "editor-main.term",
        openFiles,
      }),
    ).toBeUndefined();
    expect(
      getRecoverableActiveEditorPath({
        isActive: true,
        activeTopTab: "account",
        projectId: "project-1",
        activeProjectTab: "editor-main.term",
        openFiles,
      }),
    ).toBeUndefined();
    expect(
      getRecoverableActiveEditorPath({
        isActive: true,
        activeTopTab: "project-1",
        projectId: "project-1",
        activeProjectTab: "files",
        openFiles,
      }),
    ).toBeUndefined();
    expect(
      getRecoverableActiveEditorPath({
        isActive: true,
        activeTopTab: "project-1",
        projectId: "project-1",
        activeProjectTab: "editor-missing.term",
        openFiles,
      }),
    ).toBeUndefined();
    expect(
      getRecoverableActiveEditorPath({
        isActive: true,
        activeTopTab: "project-1",
        projectId: "project-1",
        activeProjectTab: "editor-main.term",
        openFiles,
      }),
    ).toBeUndefined();
  });
});
