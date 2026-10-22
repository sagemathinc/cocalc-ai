import { projectPersistTemplates } from "./persist-volume-template";

const IN_HOME = "/mnt/cocalc/project-[project_id]/.local/share/cocalc/persist";

describe("projectPersistTemplates", () => {
  it("moves the databases from the home to a volume next to it", () => {
    expect(projectPersistTemplates({ COCALC_SYNC_PROJECTS: IN_HOME })).toEqual({
      template: "/mnt/cocalc/project-[project_id]-persist",
      legacy: {
        home: "/mnt/cocalc/project-[project_id]",
        relative: ".local/share/cocalc/persist",
      },
    });
  });

  it("ignores extra slashes", () => {
    expect(
      projectPersistTemplates({
        COCALC_SYNC_PROJECTS:
          "/mnt/cocalc/project-[project_id]//.local/share/cocalc/persist/",
      }).legacy?.relative,
    ).toBe(".local/share/cocalc/persist");
  });

  it("can keep the databases in the home", () => {
    expect(
      projectPersistTemplates({
        COCALC_SYNC_PROJECTS: IN_HOME,
        COCALC_PERSIST_PROJECT_VOLUME: "0",
      }),
    ).toEqual({ template: IN_HOME });
  });

  it("leaves other locations alone", () => {
    for (const template of [
      "",
      "/data/sync/projects",
      "/mnt/cocalc/project-[project_id]",
      "/mnt/cocalc/project-[project_id]-persist",
      "/mnt/cocalc/project-[project_id]/../elsewhere",
      "/mnt/cocalc/x-[project_id]/.local/share/cocalc/persist",
    ]) {
      expect(
        projectPersistTemplates({ COCALC_SYNC_PROJECTS: template }),
      ).toEqual({ template });
    }
    expect(projectPersistTemplates({})).toEqual({ template: "" });
  });
});
