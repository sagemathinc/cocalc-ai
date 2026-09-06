/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { executeCode } from "@cocalc/backend/execute-code";
import exec from "@cocalc/backend/sandbox/exec";
import { RusticJobCleanupError } from "@cocalc/file-server/btrfs/rustic-job-errors";
import { withBtrfsMutationContext } from "@cocalc/file-server/btrfs/operation-cache";

import {
  ProjectRusticUnsupportedError,
  projectRusticBackup,
  projectRusticRestore,
  runManagedRustic,
} from "./project-rustic";

jest.mock("@cocalc/backend/execute-code", () => ({
  executeCode: jest.fn(),
}));
jest.mock("@cocalc/backend/sandbox/exec", () => ({
  ...jest.requireActual("@cocalc/backend/sandbox/exec"),
  __esModule: true,
  default: jest.fn(),
}));

const mockedExecuteCode = jest.mocked(executeCode);
const mockedExec = jest.mocked(exec);

describe("project rustic wrapper", () => {
  beforeEach(() => {
    mockedExecuteCode.mockReset();
    mockedExec.mockReset();
    delete process.env.COCALC_MANAGED_RUSTIC_SUPERVISION;
  });
  afterEach(() => {
    delete process.env.COCALC_MANAGED_RUSTIC_SUPERVISION;
  });

  const supervisedBackup = () =>
    projectRusticBackup({
      src: "/mnt/cocalc/staging/home",
      repoProfile: "/mnt/cocalc/data/secrets/rustic/project-1.toml",
      host: "project-1",
      timeoutMs: 30_000,
    });
  const output = (text: string, code = 0, truncated = false) => ({
    stdout: Buffer.from(text),
    stderr: Buffer.alloc(0),
    code,
    truncated,
  });

  it("waits for the root-owned barrier before returning successful output", async () => {
    process.env.COCALC_MANAGED_RUSTIC_SUPERVISION = "1";
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockedExec.mockResolvedValueOnce(
      output('{"id":"test","time":"2026-09-05T00:00:00Z"}'),
    );
    mockedExec.mockImplementationOnce(async () => {
      await barrier;
      return output("");
    });
    let completed = false;
    const pending = supervisedBackup().then(() => {
      completed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockedExec).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        prefixArgs: expect.arrayContaining(["project-rustic-backup-wait"]),
      }),
    );
    expect(completed).toBe(false);
    release();
    await pending;
    expect(mockedExecuteCode).not.toHaveBeenCalled();
  });

  it("retains staging when the root-owned barrier cannot prove cleanup", async () => {
    process.env.COCALC_MANAGED_RUSTIC_SUPERVISION = "1";
    mockedExec.mockResolvedValueOnce(output('{"id":"test"}', 0));
    mockedExec.mockResolvedValueOnce(output("", 1));
    await expect(supervisedBackup()).rejects.toBeInstanceOf(
      RusticJobCleanupError,
    );
  });

  it.each([
    output('{"id":"test"}', 1),
    output('{"id":"test"}', 0, true),
    { ...output('{"id":"test"}'), code: null },
  ])(
    "rejects incomplete execution evidence and still runs the barrier",
    async (result) => {
      process.env.COCALC_MANAGED_RUSTIC_SUPERVISION = "1";
      mockedExec.mockResolvedValueOnce(result);
      mockedExec.mockResolvedValueOnce(output(""));
      await expect(supervisedBackup()).rejects.toThrow();
      expect(mockedExec).toHaveBeenCalledTimes(2);
      expect(mockedExecuteCode).not.toHaveBeenCalled();
    },
  );

  it("does not bypass supervision after a spawn or unsupported-wrapper error", async () => {
    process.env.COCALC_MANAGED_RUSTIC_SUPERVISION = "1";
    mockedExec.mockRejectedValueOnce(new Error("unsupported-command"));
    mockedExec.mockResolvedValueOnce(output(""));
    await expect(supervisedBackup()).rejects.toThrow("unsupported-command");
    expect(mockedExecuteCode).not.toHaveBeenCalled();
  });

  it("rejects invalid supervision configuration rather than disabling it", async () => {
    process.env.COCALC_MANAGED_RUSTIC_SUPERVISION = "true";
    await expect(supervisedBackup()).rejects.toThrow("must be 0 or 1");
    expect(mockedExecuteCode).not.toHaveBeenCalled();
    expect(mockedExec).not.toHaveBeenCalled();
  });

  it.each(["rootfs-rustic-backup", "rootfs-rustic-restore"] as const)(
    "supervises %s with its own barrier and no direct-sudo fallback",
    async (command) => {
      process.env.COCALC_MANAGED_RUSTIC_SUPERVISION = "1";
      mockedExec.mockResolvedValueOnce(output("result"));
      mockedExec.mockResolvedValueOnce(output(""));
      const args = ["source", "profile", "destination"];
      await expect(
        runManagedRustic({ command, args, timeoutMs: 30_000 }),
      ).resolves.toMatchObject({ stdout: "result", stderr: "" });
      expect(mockedExec).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          prefixArgs: [
            "-n",
            "/usr/local/sbin/cocalc-runtime-storage",
            `${command}-supervised`,
            ...args,
          ],
        }),
      );
      expect(mockedExec).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          prefixArgs: [
            "-n",
            "/usr/local/sbin/cocalc-runtime-storage",
            `${command}-wait`,
            ...args,
          ],
        }),
      );
      expect(mockedExecuteCode).not.toHaveBeenCalled();
    },
  );

  it("uses seconds only at the legacy RootFS execution boundary", async () => {
    mockedExecuteCode.mockResolvedValue({
      type: "blocking",
      stdout: "",
      stderr: "",
      exit_code: 0,
    } as any);
    await runManagedRustic({
      command: "rootfs-rustic-restore",
      args: [],
      timeoutMs: 30 * 60 * 1000,
    });
    expect(mockedExecuteCode).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 1800 }),
    );
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
