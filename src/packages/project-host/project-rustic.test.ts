/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { executeCode } from "@cocalc/backend/execute-code";
import { withBtrfsMutationContext } from "@cocalc/file-server/btrfs/operation-cache";

import {
  BACKUP_CEILING_MS,
  ProjectRusticUnsupportedError,
  __test__,
  projectChangedSince,
  projectRusticBackup,
  projectRusticRestore,
} from "./project-rustic";

jest.mock("@cocalc/backend/execute-code", () => ({
  executeCode: jest.fn(),
}));

// The privileged wrapper is installed (it isn't where tests run).
jest.mock("node:fs", () => {
  const actual = jest.requireActual("node:fs");
  return {
    ...actual,
    existsSync: (path: string) =>
      path === "/usr/local/sbin/cocalc-runtime-storage" ||
      actual.existsSync(path),
  };
});

const mockedExecuteCode = jest.mocked(executeCode);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// executeCode's async interface for one backup run: started, streamed,
// cancelled, awaited.
function fakeAsyncBackup() {
  let streamCB: ((event: any) => void) | undefined;
  let cancelled = false;
  let onStarted!: () => void;
  const started = new Promise<void>((resolve) => (onStarted = resolve));
  let finish!: (output: any) => void;
  const finished = new Promise<any>((resolve) => (finish = resolve));
  const done = (output: any) =>
    finish({
      type: "async",
      job_id: "job-1",
      stdout: "",
      stderr: "",
      ...output,
    });
  mockedExecuteCode.mockImplementation(async (req: any) => {
    if (req.async_call) {
      streamCB = req.streamCB;
      onStarted();
      return { type: "async", job_id: "job-1", status: "running" } as any;
    }
    if (req.async_cancel) {
      cancelled = true;
      done({ status: "killed", exit_code: 1 });
      return { type: "async", job_id: "job-1", status: "killed" } as any;
    }
    if (req.async_get) return await finished;
    throw new Error("unexpected executeCode call");
  });
  return {
    started,
    emit: (line: string) => streamCB?.({ type: "stderr", data: `${line}\n` }),
    complete: (stdout: string) =>
      done({ status: "completed", exit_code: 0, stdout }),
    finish: (output: any) => done(output),
    cancelled: () => cancelled,
  };
}

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
    const job = fakeAsyncBackup();
    const backup = withBtrfsMutationContext({ priority: "scheduled" }, () =>
      projectRusticBackup({
        src: "/mnt/cocalc/project-1/.snapshots/temp",
        repoProfile: "/mnt/cocalc/data/secrets/rustic/project-1.toml",
        host: "project-1",
        timeoutMs: 30_000,
      }),
    );
    await job.started;
    job.complete(
      '{"time":"2026-03-31T12:34:56.000Z","id":"backup-id","summary":{}}',
    );
    expect((await backup).id).toBe("backup-id");
    expect(mockedExecuteCode).toHaveBeenCalledWith(
      expect.objectContaining({
        async_call: true,
        args: expect.arrayContaining(["project-rustic-backup-maintenance"]),
        // the budget no longer kills it: only the ceiling does
        timeout: BACKUP_CEILING_MS / 1000,
      }),
    );
  });

  describe("a background backup past its budget", () => {
    afterEach(() => __test__.resetWatchdogLimits());

    const scheduledBackup = () =>
      withBtrfsMutationContext({ priority: "scheduled" }, () =>
        projectRusticBackup({
          src: "/mnt/cocalc/project-1/.snapshots/temp",
          repoProfile: "/mnt/cocalc/data/secrets/rustic/project-1.toml",
          host: "project-1",
          timeoutMs: 40,
        }),
      );

    it("runs on while rustic reports progress", async () => {
      __test__.setWatchdogLimits({ stallMs: 60, intervalMs: 5 });
      const job = fakeAsyncBackup();
      const backup = scheduledBackup();
      await job.started;
      // 300 ms: several budgets and stall windows, always advancing
      for (let mib = 1; mib <= 30; mib++) {
        job.emit(`[INFO] backing up: ${mib} MiB`);
        await sleep(10);
      }
      job.complete('{"time":"2026-03-31T12:34:56.000Z","id":"backup-id"}');
      expect((await backup).id).toBe("backup-id");
      expect(job.cancelled()).toBe(false);
    });

    it("is stopped once progress stalls, saying where it was", async () => {
      __test__.setWatchdogLimits({ stallMs: 60, intervalMs: 5 });
      const job = fakeAsyncBackup();
      const backup = scheduledBackup();
      await job.started;
      job.emit("[INFO] backing up: 7 MiB");
      // the same value again is not progress
      const repeat = setInterval(() => job.emit("[INFO] backing up: 7 MiB"), 5);
      try {
        await expect(backup).rejects.toThrow(
          /no progress for .* last progress: backing up: 7 MiB/,
        );
      } finally {
        clearInterval(repeat);
      }
      expect(job.cancelled()).toBe(true);
    });

    it("is not stopped for a quiet start within its budget", async () => {
      __test__.setWatchdogLimits({ stallMs: 10, intervalMs: 5 });
      const job = fakeAsyncBackup();
      const backup = withBtrfsMutationContext({ priority: "scheduled" }, () =>
        projectRusticBackup({
          src: "/mnt/cocalc/project-1/.snapshots/temp",
          repoProfile: "/mnt/cocalc/data/secrets/rustic/project-1.toml",
          host: "project-1",
          timeoutMs: 200,
        }),
      );
      await job.started;
      await sleep(100); // no progress lines yet: reading the index
      job.complete('{"time":"2026-03-31T12:34:56.000Z","id":"backup-id"}');
      expect((await backup).id).toBe("backup-id");
      expect(job.cancelled()).toBe(false);
    });

    it("gives a run quiet at its budget's end the whole stall window", async () => {
      __test__.setWatchdogLimits({ stallMs: 80, intervalMs: 5 });
      const job = fakeAsyncBackup();
      const startedAt = Date.now();
      const backup = scheduledBackup(); // budget 40 ms
      await job.started;
      // no progress at all, as during a long index load
      await expect(backup).rejects.toThrow(/no progress for/);
      expect(job.cancelled()).toBe(true);
      // not at the budget: after the budget and then the stall window
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40 + 80);
    });

    it("reports the ceiling when the run is killed there", async () => {
      const job = fakeAsyncBackup();
      const backup = scheduledBackup();
      await job.started;
      job.finish({ status: "killed", exit_code: 1, stderr: "" });
      await expect(backup).rejects.toThrow(/stopped at the 12 h ceiling/);
      expect(job.cancelled()).toBe(false);
    });
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

  describe("change scan", () => {
    it("asks for paths changed since a time, in nanoseconds", async () => {
      mockedExecuteCode.mockResolvedValue({
        type: "blocking",
        stdout:
          '{"since_ns":1793298000000000000,"paths":[".cache/cocalc/project/log"],"truncated":false,"foreign_filesystem":false}\n',
        stderr: "",
        exit_code: 0,
      } as any);
      await expect(
        projectChangedSince({
          src: "/mnt/cocalc/project-1",
          sinceMs: 1_793_298_000_000,
        }),
      ).resolves.toEqual({
        paths: [".cache/cocalc/project/log"],
        truncated: false,
        foreign_filesystem: false,
      });
      expect(mockedExecuteCode.mock.calls[0][0].args).toEqual([
        "-n",
        "/usr/local/sbin/cocalc-runtime-storage",
        "project-changed-since",
        "/mnt/cocalc/project-1",
        "--since-ns",
        "1793298000000000000",
      ]);
    });

    it("is unavailable, not an error, where the wrapper predates it", async () => {
      mockedExecuteCode.mockResolvedValue({
        type: "blocking",
        stdout: "",
        stderr:
          "SECURITY_DENY code=unsupported-command detail=project-changed-since",
        exit_code: 2,
      } as any);
      await expect(
        projectChangedSince({ src: "/mnt/cocalc/project-1", sinceMs: 1 }),
      ).resolves.toBeNull();
    });

    it("rejects a malformed report and a bad time", async () => {
      mockedExecuteCode.mockResolvedValue({
        type: "blocking",
        stdout: '{"paths":[1],"truncated":false}',
        stderr: "",
        exit_code: 0,
      } as any);
      await expect(
        projectChangedSince({ src: "/mnt/cocalc/project-1", sinceMs: 1 }),
      ).rejects.toThrow("invalid change scan report");
      await expect(
        projectChangedSince({ src: "/mnt/cocalc/project-1", sinceMs: -1 }),
      ).rejects.toThrow("invalid change scan time");
    });
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
