import { closeDatabase } from "@cocalc/lite/hub/sqlite/database";
import {
  getProject,
  listRuntimeArtifactReferences,
  upsertProject,
} from "./projects";

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

  it("stores and aggregates running project bundle/tools references", () => {
    upsertProject({
      project_id,
      state: "running",
      project_bundle_version: "bundle-v2",
      tools_version: "tools-v7",
    });
    upsertProject({
      project_id: "72d1e771-99c0-47b2-b8b0-a29d882646a8",
      state: "running",
      project_bundle_version: "bundle-v2",
      tools_version: "tools-v6",
    });
    upsertProject({
      project_id: "502bcc4e-f2b4-4450-8646-75d1c2655c01",
      state: "opened",
      project_bundle_version: "bundle-v1",
      tools_version: "tools-v5",
    });

    expect(getProject(project_id)?.project_bundle_version).toBe("bundle-v2");
    expect(getProject(project_id)?.tools_version).toBe("tools-v7");
    expect(listRuntimeArtifactReferences()).toEqual({
      project_bundle: [{ version: "bundle-v2", project_count: 2 }],
      tools: [
        { version: "tools-v7", project_count: 1 },
        { version: "tools-v6", project_count: 1 },
      ],
    });
  });
});
