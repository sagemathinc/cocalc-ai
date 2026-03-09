import { closeDatabase } from "@cocalc/lite/hub/sqlite/database";
import { getProject, upsertProject } from "./projects";

describe("project sqlite runtime ports", () => {
  const prevFilename = process.env.COCALC_LITE_SQLITE_FILENAME;
  const project_id = "1fc5e846-547c-4c78-baa3-d0528685eea0";

  beforeEach(() => {
    process.env.COCALC_LITE_SQLITE_FILENAME = ":memory:";
    closeDatabase();
  });

  afterEach(() => {
    closeDatabase();
    if (prevFilename == null) {
      delete process.env.COCALC_LITE_SQLITE_FILENAME;
    } else {
      process.env.COCALC_LITE_SQLITE_FILENAME = prevFilename;
    }
  });

  it("allows explicit clearing of stale ssh/http ports", () => {
    upsertProject({
      project_id,
      state: "running",
      http_port: 12345,
      ssh_port: 23456,
    });
    expect(getProject(project_id)?.http_port).toBe(12345);
    expect(getProject(project_id)?.ssh_port).toBe(23456);

    upsertProject({
      project_id,
      state: "opened",
      http_port: null,
      ssh_port: null,
    });
    expect(getProject(project_id)?.http_port).toBeNull();
    expect(getProject(project_id)?.ssh_port).toBeNull();
  });
});
