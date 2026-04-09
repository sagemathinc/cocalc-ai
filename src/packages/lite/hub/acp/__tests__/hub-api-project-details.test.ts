import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

const ACCOUNT_ID = "00000000-1000-4000-8000-000000000001";
const PROJECT_ID = "00000000-1000-4000-8000-000000000002";

describe("lite hub project detail getters", () => {
  const prevSqlite = process.env.COCALC_LITE_SQLITE_FILENAME;
  const prevProjectId = process.env.COCALC_PROJECT_ID;
  const prevAccountId = process.env.COCALC_ACCOUNT_ID;

  beforeEach(() => {
    jest.resetModules();
    process.env.COCALC_PROJECT_ID = PROJECT_ID;
    process.env.COCALC_ACCOUNT_ID = ACCOUNT_ID;
  });

  afterEach(async () => {
    const { close } = await import("../../sqlite/user-query");
    close();
    if (prevSqlite == null) delete process.env.COCALC_LITE_SQLITE_FILENAME;
    else process.env.COCALC_LITE_SQLITE_FILENAME = prevSqlite;
    if (prevProjectId == null) delete process.env.COCALC_PROJECT_ID;
    else process.env.COCALC_PROJECT_ID = prevProjectId;
    if (prevAccountId == null) delete process.env.COCALC_ACCOUNT_ID;
    else process.env.COCALC_ACCOUNT_ID = prevAccountId;
  });

  it("serves project detail reads from the lite projects row", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lite-project-api-"));
    process.env.COCALC_LITE_SQLITE_FILENAME = path.join(tmp, "lite.sqlite3");

    const { init } = await import("../../sqlite/user-query");
    const { upsertRow } = await import("../../sqlite/database");
    init({ filename: process.env.COCALC_LITE_SQLITE_FILENAME, seed: false });

    upsertRow("accounts", JSON.stringify({ account_id: ACCOUNT_ID }), {
      account_id: ACCOUNT_ID,
      email_address: "user@cocalc.com",
    });
    upsertRow("projects", JSON.stringify({ project_id: PROJECT_ID }), {
      project_id: PROJECT_ID,
      title: "Lite Project",
      created: "2026-04-09T00:00:00.000Z",
      launcher: { quick_create: ["terminal"] },
      run_quota: { member_host: true },
      course: { project_id: PROJECT_ID, path: ".course" },
      region: "wnam",
      env: { FOO: "bar" },
      rootfs_image: "ghcr.io/cocalc/image:latest",
      rootfs_image_id: "sha256:123",
      settings: { mintime: 5 },
      snapshots: { disabled: false },
      backups: { disabled: true },
    });

    const { hubApi } = await import("../../api");

    await expect(
      hubApi.projects.getProjectLauncher({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({ quick_create: ["terminal"] });
    await expect(
      hubApi.projects.getProjectCreated({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toBe("2026-04-09T00:00:00.000Z");
    await expect(
      hubApi.projects.getProjectRunQuota({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({ member_host: true });
    await expect(
      hubApi.projects.getProjectCourseInfo({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({ project_id: PROJECT_ID, path: ".course" });
    await expect(
      hubApi.projects.getProjectRegion({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toBe("wnam");
    await expect(
      hubApi.projects.getProjectEnv({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({ FOO: "bar" });
    await expect(
      hubApi.projects.getProjectRootfs({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({
      image: "ghcr.io/cocalc/image:latest",
      image_id: "sha256:123",
    });
    await expect(
      hubApi.projects.getProjectSettings({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({ mintime: 5 });
    await expect(
      hubApi.projects.getProjectSnapshotSchedule({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({ disabled: false });
    await expect(
      hubApi.projects.getProjectBackupSchedule({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({ disabled: true });
    await expect(
      hubApi.projects.getProjectActiveOperation({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toBeNull();
  });
});
