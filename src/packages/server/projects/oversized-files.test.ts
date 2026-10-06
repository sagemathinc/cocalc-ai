/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let getOversizedFilesMock: jest.Mock;

jest.mock("@cocalc/server/conat/file-server-client", () => ({
  getProjectFileServerClient: jest.fn(async () => ({
    getOversizedFiles: (...args: any[]) => getOversizedFilesMock(...args),
  })),
}));

import {
  assertBackupOversizedFilesAllowed,
  assertOversizedFilesAllowed,
  OversizedFilesError,
} from "./oversized-files";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const REPORT = {
  max_file_bytes: 10_000_000_000,
  count: 3,
  files: [{ path: "sparse.img", size: 1_000_000_000_000 }],
};

describe("assertOversizedFilesAllowed", () => {
  beforeEach(() => {
    getOversizedFilesMock = jest.fn(async () => REPORT);
  });

  it("refuses and names the files when they were not confirmed", async () => {
    const err = await assertOversizedFilesAllowed({
      project_id: PROJECT_ID,
      paths: ["data"],
      action: "move this project",
    }).catch((err) => err);
    expect(err).toBeInstanceOf(OversizedFilesError);
    expect(err.report).toEqual(REPORT);
    expect(err.message).toContain("Unable to move this project");
    expect(err.message).toContain("sparse.img and 2 more");
    expect(getOversizedFilesMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      paths: ["data"],
    });
  });

  it("does not scan when the user confirmed", async () => {
    await assertOversizedFilesAllowed({
      project_id: PROJECT_ID,
      action: "move this project",
      allow_oversized_skip: true,
    });
    expect(getOversizedFilesMock).not.toHaveBeenCalled();
  });

  it("allows projects with nothing to skip", async () => {
    getOversizedFilesMock = jest.fn(async () => ({ ...REPORT, count: 0 }));
    await assertOversizedFilesAllowed({
      project_id: PROJECT_ID,
      action: "archive this project",
    });
  });

  it("allows hosts whose backups skip nothing", async () => {
    getOversizedFilesMock = jest.fn(async () => null);
    await assertOversizedFilesAllowed({
      project_id: PROJECT_ID,
      action: "archive this project",
    });
    getOversizedFilesMock = jest.fn(async () => {
      throw new Error(
        "calling remote function 'getOversizedFiles': unknown service method 'getOversizedFiles'",
      );
    });
    await assertOversizedFilesAllowed({
      project_id: PROJECT_ID,
      action: "archive this project",
    });
  });

  it("does not treat a failed scan as nothing to skip", async () => {
    getOversizedFilesMock = jest.fn(async () => {
      throw new Error("scan timed out");
    });
    await expect(
      assertOversizedFilesAllowed({
        project_id: PROJECT_ID,
        action: "archive this project",
      }),
    ).rejects.toThrow("scan timed out");
  });
});

describe("assertBackupOversizedFilesAllowed", () => {
  it("refuses a backup that skipped files unless confirmed", () => {
    expect(() =>
      assertBackupOversizedFilesAllowed({
        backup_result: { oversized_files: REPORT },
        action: "move this project",
      }),
    ).toThrow(OversizedFilesError);
    assertBackupOversizedFilesAllowed({
      backup_result: { oversized_files: REPORT },
      action: "move this project",
      allow_oversized_skip: true,
    });
    assertBackupOversizedFilesAllowed({
      backup_result: { id: "backup" },
      action: "move this project",
    });
  });
});
