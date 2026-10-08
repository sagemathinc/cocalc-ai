/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { executeCode } from "@cocalc/backend/execute-code";
import { withBtrfsMutationContext } from "@cocalc/file-server/btrfs/operation-cache";

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
      parent: "snap-parent",
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
          "--parent",
          "snap-parent",
        ],
        timeout: 90,
      }),
    );
  });

  it("passes the file size limit and returns skipped files", async () => {
    const report = {
      max_file_bytes: 40_000_000_000,
      count: 3,
      files: [{ path: "data/huge.img", size: 1_000_000_000_000 }],
    };
    mockedExecuteCode.mockResolvedValue({
      type: "blocking",
      stdout: '{"time":"2026-03-31T12:34:56.000Z","id":"backup-id"}',
      stderr: `COCALC_BACKUP_OVERSIZED_FILES ${JSON.stringify(report)}\n[INFO] backup done\n`,
      exit_code: 0,
    } as any);

    const result = await projectRusticBackup({
      src: "/mnt/cocalc/project-1/.snapshots/temp",
      repoProfile: "/mnt/cocalc/data/secrets/rustic/project-1.toml",
      host: "project-1",
      timeoutMs: 90_000,
      maxFileBytes: 40_000_000_000,
    });

    expect(result.oversized_files).toEqual(report);
    expect(mockedExecuteCode.mock.calls[0][0].args).toEqual([
      "-n",
      "/usr/local/sbin/cocalc-runtime-storage",
      "project-rustic-backup",
      "/mnt/cocalc/project-1/.snapshots/temp",
      "/mnt/cocalc/data/secrets/rustic/project-1.toml",
      "project-1",
      "--max-file-bytes",
      "40000000000",
    ]);
  });

  it("reports no skipped files when the helper prints no report", async () => {
    mockedExecuteCode.mockResolvedValue({
      type: "blocking",
      stdout: '{"time":"2026-03-31T12:34:56.000Z","id":"backup-id"}',
      stderr: "[INFO] backup done\n",
      exit_code: 0,
    } as any);
    const result = await projectRusticBackup({
      src: "/mnt/cocalc/project-1/.snapshots/temp",
      repoProfile: "/mnt/cocalc/data/secrets/rustic/project-1.toml",
      host: "project-1",
      timeoutMs: 90_000,
      maxFileBytes: 40_000_000_000,
    });
    expect(result.oversized_files).toBeUndefined();
  });

  it("accepts sparse file sizes beyond 2^53", async () => {
    const stderr = `COCALC_BACKUP_OVERSIZED_FILES {"max_file_bytes":40000000000,"count":1,"files":[{"path":"huge","size":11258999068426240}]}\n`;
    mockedExecuteCode.mockResolvedValue({
      type: "blocking",
      stdout: '{"time":"2026-03-31T12:34:56.000Z","id":"backup-id"}',
      stderr,
      exit_code: 0,
    } as any);
    const result = await projectRusticBackup({
      src: "/mnt/cocalc/project-1/.snapshots/temp",
      repoProfile: "/mnt/cocalc/data/secrets/rustic/project-1.toml",
      host: "project-1",
      timeoutMs: 90_000,
      maxFileBytes: 40_000_000_000,
    });
    expect(result.oversized_files?.files[0].size).toBeGreaterThan(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("rejects a malformed skipped file report", async () => {
    mockedExecuteCode.mockResolvedValue({
      type: "blocking",
      stdout: '{"time":"2026-03-31T12:34:56.000Z","id":"backup-id"}',
      stderr: 'COCALC_BACKUP_OVERSIZED_FILES {"count":"lots"}\n',
      exit_code: 0,
    } as any);
    await expect(
      projectRusticBackup({
        src: "/mnt/cocalc/project-1/.snapshots/temp",
        repoProfile: "/mnt/cocalc/data/secrets/rustic/project-1.toml",
        host: "project-1",
        timeoutMs: 90_000,
      }),
    ).rejects.toThrow("malformed oversized file report");
  });

  it("retries without the limit on hosts whose wrapper predates it", async () => {
    mockedExecuteCode
      .mockResolvedValueOnce({
        type: "blocking",
        stdout: "",
        stderr:
          "SECURITY_DENY code=project-rustic-backup-bad-args detail=--max-file-bytes\n",
        exit_code: 2,
      } as any)
      .mockResolvedValueOnce({
        type: "blocking",
        stdout: '{"time":"2026-03-31T12:34:56.000Z","id":"backup-id"}',
        stderr: "",
        exit_code: 0,
      } as any);
    const result = await projectRusticBackup({
      src: "/mnt/cocalc/project-1/.snapshots/temp",
      repoProfile: "/mnt/cocalc/data/secrets/rustic/project-1.toml",
      host: "project-1",
      timeoutMs: 90_000,
      maxFileBytes: 40_000_000_000,
    });
    expect(result.id).toBe("backup-id");
    expect(mockedExecuteCode).toHaveBeenCalledTimes(2);
    expect(mockedExecuteCode.mock.calls[1][0].args).not.toContain(
      "--max-file-bytes",
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

  it("bypasses the local cache for a remote-only restore", async () => {
    mockedExecuteCode.mockResolvedValue({
      type: "blocking",
      stdout: "",
      stderr: "",
      exit_code: 0,
    } as any);

    await projectRusticRestore({
      repoProfile: "/mnt/cocalc/data/secrets/rustic/project-1.toml",
      snapshot: "backup-id:data/results",
      dest: "/mnt/cocalc/project-1/.restore-staging/project-1",
      timeoutMs: 30_000,
      remote_only: true,
    });

    expect(mockedExecuteCode).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [
          "-n",
          "/usr/local/sbin/cocalc-runtime-storage",
          "project-rustic-restore",
          "/mnt/cocalc/data/secrets/rustic/project-1.toml",
          "backup-id:data/results",
          "/mnt/cocalc/project-1/.restore-staging/project-1",
          "--no-cache",
        ],
      }),
    );
  });

  it("moves scheduled backups through the maintenance wrapper command", async () => {
    mockedExecuteCode.mockResolvedValue({
      type: "blocking",
      stdout:
        '{"time":"2026-03-31T12:34:56.000Z","id":"backup-id","summary":{}}',
      stderr: "",
      exit_code: 0,
    } as any);

    await withBtrfsMutationContext({ priority: "scheduled" }, async () => {
      await projectRusticBackup({
        src: "/mnt/cocalc/project-1/.snapshots/temp",
        repoProfile: "/mnt/cocalc/data/secrets/rustic/project-1.toml",
        host: "project-1",
        timeoutMs: 30_000,
      });
    });

    expect(mockedExecuteCode).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining(["project-rustic-backup-maintenance"]),
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

  it("treats old wrappers that reject --parent as unsupported", async () => {
    mockedExecuteCode.mockResolvedValue({
      type: "blocking",
      stdout: "",
      stderr:
        "SECURITY_DENY code=project-rustic-backup-bad-args detail=--parent",
      exit_code: 2,
    } as any);

    await expect(
      projectRusticBackup({
        src: "/mnt/cocalc/project-1/.snapshots/temp",
        repoProfile: "/mnt/cocalc/data/secrets/rustic/project-1.toml",
        host: "project-1",
        timeoutMs: 30_000,
        parent: "snap-parent",
      }),
    ).rejects.toBeInstanceOf(ProjectRusticUnsupportedError);
  });
});
