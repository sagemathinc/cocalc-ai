/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { executeCode } from "@cocalc/backend/execute-code";

import {
  ProjectRusticUnsupportedError,
  projectRusticBackup,
  projectRusticRestore,
} from "./project-rustic";

jest.mock("@cocalc/backend/execute-code", () => ({
  executeCode: jest.fn(),
}));

const mockedExecuteCode = jest.mocked(executeCode);

describe("project rustic wrapper", () => {
  beforeEach(() => {
    mockedExecuteCode.mockReset();
  });

  it("backs up through the privileged runtime storage wrapper", async () => {
    mockedExecuteCode.mockResolvedValue({
      type: "blocking",
      stdout:
        '{"time":"2026-03-31T12:34:56.000Z","id":"backup-id","summary":{"files_new":1}}',
      stderr: "",
      exit_code: 0,
    } as any);

    const result = await projectRusticBackup({
      src: "/mnt/cocalc/project-1/.snapshots/temp",
      repoProfile: "/mnt/cocalc/data/secrets/rustic/project-1.toml",
      host: "project-1",
      timeoutMs: 90_000,
      tags: ["xattr", "rootfs"],
    });

    expect(result.id).toBe("backup-id");
    expect(result.time.toISOString()).toBe("2026-03-31T12:34:56.000Z");
    expect(result.summary).toEqual({ files_new: 1 });
    expect(mockedExecuteCode).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "sudo",
        args: [
          "-n",
          "/usr/local/sbin/cocalc-runtime-storage",
          "project-rustic-backup",
          "/mnt/cocalc/project-1/.snapshots/temp",
          "/mnt/cocalc/data/secrets/rustic/project-1.toml",
          "project-1",
          "--tag",
          "xattr",
          "--tag",
          "rootfs",
        ],
        timeout: 90,
      }),
    );
  });

  it("restores through the privileged runtime storage wrapper", async () => {
    mockedExecuteCode.mockResolvedValue({
      type: "blocking",
      stdout: "",
      stderr: "",
      exit_code: 0,
    } as any);

    await projectRusticRestore({
      repoProfile: "/mnt/cocalc/data/secrets/rustic/project-1.toml",
      snapshot: "backup-id:.local/share/cocalc/rootfs",
      dest: "/mnt/cocalc/project-1/.restore-staging/project-1",
      timeoutMs: 30_000,
    });

    expect(mockedExecuteCode).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "sudo",
        args: [
          "-n",
          "/usr/local/sbin/cocalc-runtime-storage",
          "project-rustic-restore",
          "/mnt/cocalc/data/secrets/rustic/project-1.toml",
          "backup-id:.local/share/cocalc/rootfs",
          "/mnt/cocalc/project-1/.restore-staging/project-1",
        ],
        timeout: 30,
      }),
    );
  });

  it("surfaces old-wrapper incompatibility distinctly", async () => {
    mockedExecuteCode.mockResolvedValue({
      type: "blocking",
      stdout: "",
      stderr:
        "SECURITY_DENY code=unsupported-command detail=project-rustic-backup",
      exit_code: 2,
    } as any);

    await expect(
      projectRusticBackup({
        src: "/mnt/cocalc/project-1/.snapshots/temp",
        repoProfile: "/mnt/cocalc/data/secrets/rustic/project-1.toml",
        host: "project-1",
        timeoutMs: 30_000,
      }),
    ).rejects.toBeInstanceOf(ProjectRusticUnsupportedError);
  });
});
