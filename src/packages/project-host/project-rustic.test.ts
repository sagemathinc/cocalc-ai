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
  PartialProjectBackupError,
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

  const projectId = "00000000-0000-4000-8000-000000000001";
  const produced = (partial = false) => ({
    id: "b".repeat(64),
    time: "2026-09-05T00:00:00.000Z",
    cocalc_backup_evidence: {
      schema_version: 1,
      source: {
        subvolume_uuid: projectId,
        snapshot_uuid: "00000000-0000-4000-8000-000000000002",
        generation: "2",
        captured_at: "2026-09-05T00:00:00.000Z",
      },
      policy_version: 1,
      policy_sha256: "a".repeat(64),
      binary_sha256: "c".repeat(64),
      exclude_larger_than_bytes: "100",
      excluded_files: partial ? "1" : "0",
      outcome: partial ? "partial_policy_exclusions" : "complete",
      report_path: `/var/lib/cocalc-rustic-reports/${projectId}.ndjson`,
      report: {
        bytes: 1000,
        sha256: "d".repeat(64),
        header_sha256: "e".repeat(64),
      },
      read_limits: {
        max_bytes: 2000,
        max_record_bytes: 2000,
        max_entries: 100,
        max_path_depth: 10,
      },
    },
  });
  const evidenceBackup = (accept: (evidence: any) => Promise<void>) =>
    projectRusticBackup({
      src: "/mnt/cocalc/staging/home",
      repoProfile: "/mnt/cocalc/data/secrets/rustic/project-1.toml",
      host: "project-1",
      timeoutMs: 30000,
      evidence: { project_id: projectId, accept },
    });

  it("does not silently discard protected evidence without its consumer", async () => {
    process.env.COCALC_MANAGED_RUSTIC_SUPERVISION = "1";
    mockedExec.mockResolvedValueOnce(output(JSON.stringify(produced())));
    mockedExec.mockResolvedValueOnce(output(""));
    await expect(supervisedBackup()).rejects.toThrow(
      "consumer is not configured",
    );
  });

  it("requires evidence when the evidence consumer is enabled", async () => {
    process.env.COCALC_MANAGED_RUSTIC_SUPERVISION = "1";
    mockedExec.mockResolvedValueOnce(
      output(
        JSON.stringify({ id: "b".repeat(64), time: "2026-09-05T00:00:00Z" }),
      ),
    );
    mockedExec.mockResolvedValueOnce(output(""));
    const accept = jest.fn();
    await expect(evidenceBackup(accept)).rejects.toThrow("Invalid protected");
    expect(accept).not.toHaveBeenCalled();
  });

  it("waits for evidence acceptance before returning backup success", async () => {
    process.env.COCALC_MANAGED_RUSTIC_SUPERVISION = "1";
    mockedExec.mockResolvedValueOnce(output(JSON.stringify(produced())));
    mockedExec.mockResolvedValueOnce(output(""));
    let release!: () => void;
    let completed = false;
    const accept = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pending = evidenceBackup(accept).then(() => {
      completed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(accept).toHaveBeenCalledTimes(1);
    expect(completed).toBe(false);
    release();
    await pending;
    expect(completed).toBe(true);
  });

  it("does not publish success when durable evidence acceptance fails", async () => {
    process.env.COCALC_MANAGED_RUSTIC_SUPERVISION = "1";
    mockedExec.mockResolvedValueOnce(output(JSON.stringify(produced())));
    mockedExec.mockResolvedValueOnce(output(""));
    await expect(
      evidenceBackup(async () => {
        throw new Error("record failed");
      }),
    ).rejects.toThrow("record failed");
  });

  it("records partial evidence but refuses legacy complete-backup return", async () => {
    process.env.COCALC_MANAGED_RUSTIC_SUPERVISION = "1";
    mockedExec.mockResolvedValueOnce(output(JSON.stringify(produced(true))));
    mockedExec.mockResolvedValueOnce(output(""));
    const accept = jest.fn(async () => {});
    await expect(evidenceBackup(accept)).rejects.toBeInstanceOf(
      PartialProjectBackupError,
    );
    expect(accept).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "partial_policy_exclusions" }),
    );
  });

  it("refuses evidence-required backup before starting an unsupervised helper", async () => {
    await expect(evidenceBackup(jest.fn())).rejects.toThrow(
      "requires supervised",
    );
    expect(mockedExec).not.toHaveBeenCalled();
    expect(mockedExecuteCode).not.toHaveBeenCalled();
  });

  it("permits a dormant evidence consumer with an old helper and gate disabled", async () => {
    mockedExecuteCode.mockResolvedValue({
      type: "blocking",
      exit_code: 0,
      stdout: JSON.stringify({ id: "legacy", time: "2026-09-05T00:00:00Z" }),
      stderr: "",
    } as any);
    const accept = jest.fn();
    await expect(
      projectRusticBackup({
        src: "/mnt/cocalc/staging/home",
        repoProfile: "/profile",
        host: "project-1",
        timeoutMs: 30000,
        evidence: { project_id: projectId, required: false, accept },
      }),
    ).resolves.toMatchObject({ id: "legacy" });
    expect(accept).not.toHaveBeenCalled();
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
