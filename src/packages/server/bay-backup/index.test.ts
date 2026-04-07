export {};

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let execFileMock: jest.Mock;
let getPoolMock: jest.Mock;
let getServerSettingsMock: jest.Mock;
let getSingleBayInfoMock: jest.Mock;
let ensureRusticInitializedMock: jest.Mock;
let whichMock: jest.Mock;
let listObjectsMock: jest.Mock;
let issueSignedObjectDownloadMock: jest.Mock;
let oldFetch: typeof global.fetch | undefined;

jest.mock("node:child_process", () => {
  const actual = jest.requireActual("node:child_process");
  return {
    ...actual,
    execFile: (...args: any[]) => execFileMock(...args),
  };
});

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  getLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: (...args: any[]) => getPoolMock(...args),
}));

jest.mock("@cocalc/database/settings/server-settings", () => ({
  __esModule: true,
  getServerSettings: (...args: any[]) => getServerSettingsMock(...args),
}));

jest.mock("@cocalc/server/bay-directory", () => ({
  __esModule: true,
  getSingleBayInfo: (...args: any[]) => getSingleBayInfoMock(...args),
}));

jest.mock("@cocalc/backend/sandbox/install", () => ({
  __esModule: true,
  rustic: "rustic-bin",
}));

jest.mock("@cocalc/backend/sandbox/rustic", () => ({
  __esModule: true,
  ensureInitialized: (...args: any[]) => ensureRusticInitializedMock(...args),
}));

jest.mock("@cocalc/backend/which", () => ({
  __esModule: true,
  which: (...args: any[]) => whichMock(...args),
}));

jest.mock("@cocalc/server/project-backup/r2", () => ({
  __esModule: true,
  createBucket: jest.fn(),
  listBuckets: jest.fn(async () => []),
  listObjects: (...args: any[]) => listObjectsMock(...args),
  issueSignedObjectDownload: (...args: any[]) =>
    issueSignedObjectDownloadMock(...args),
  uploadObjectFromBuffer: jest.fn(),
  uploadObjectFromFile: jest.fn(),
}));

describe("bay-backup runner", () => {
  let backupRoot: string;
  let oldEnv: NodeJS.ProcessEnv;
  let rusticSnapshots: Array<{
    id: string;
    host: string;
    tags: string[];
    files: Record<string, Buffer>;
  }>;

  beforeEach(async () => {
    jest.resetModules();
    oldEnv = { ...process.env };
    backupRoot = await mkdtemp(join(tmpdir(), "cocalc-bay-backup-"));
    process.env.COCALC_BACKUP_ROOT = backupRoot;
    process.env.COCALC_DATA_DIR = join(backupRoot, "app-data");
    process.env.PGHOST = "/tmp/cocalc-test-pg";
    process.env.PGUSER = "smc";
    process.env.PGDATABASE = "smc";
    mkdirSync(join(process.env.COCALC_DATA_DIR, "sync", "accounts", "test"), {
      recursive: true,
    });
    writeFileSync(
      join(
        process.env.COCALC_DATA_DIR,
        "sync",
        "accounts",
        "test",
        "seen-state.db",
      ),
      "sqlite",
    );
    writeFileSync(
      join(
        process.env.COCALC_DATA_DIR,
        "sync",
        "accounts",
        "test",
        "seen-state.db-wal",
      ),
      "wal",
    );
    mkdirSync(join(process.env.COCALC_DATA_DIR, "secrets", "launchpad-sshd"), {
      recursive: true,
    });
    writeFileSync(
      join(process.env.COCALC_DATA_DIR, "secrets", "conat-password"),
      "secret\n",
    );
    writeFileSync(
      join(
        process.env.COCALC_DATA_DIR,
        "secrets",
        "launchpad-sshd",
        "sshd.pid",
      ),
      "123\n",
    );
    rusticSnapshots = [];
    ensureRusticInitializedMock = jest.fn(async () => undefined);
    whichMock = jest.fn(async (binary: string) => `/usr/bin/${binary}`);
    listObjectsMock = jest.fn(async () => []);
    issueSignedObjectDownloadMock = jest.fn(({ key }: { key: string }) => ({
      url: `https://example.invalid/${key}`,
      headers: {},
    }));
    oldFetch = global.fetch;
    global.fetch = jest.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.endsWith("/bay-backups/bay-0/wal/0000000100000000000000E8")) {
        return new Response("segment", { status: 200 });
      }
      return new Response("not found", {
        status: 404,
        statusText: "Not Found",
      });
    }) as typeof global.fetch;
    execFileMock = jest.fn(
      (
        cmd: string,
        args: string[],
        opts: Record<string, unknown>,
        cb: (
          err: Error | null,
          result?: { stdout: string; stderr: string },
        ) => void,
      ) => {
        if (cmd === "pg_dumpall") {
          const fileFlag = args.indexOf("--file");
          const path = args[fileFlag + 1];
          writeFileSync(path, "SELECT 1;\n");
          cb(null, { stdout: "", stderr: "" });
          return;
        }
        if (cmd === "sqlite3") {
          const sourcePath = args[0];
          const backupArg = args.find((arg) => arg.startsWith(".backup "));
          const match = backupArg?.match(/^\.backup '(.+)'$/);
          const destinationPath = match?.[1];
          if (!destinationPath) {
            cb(new Error("missing sqlite backup destination"));
            return;
          }
          writeFileSync(destinationPath, readFileSync(sourcePath));
          cb(null, { stdout: "", stderr: "" });
          return;
        }
        if (cmd === "tar") {
          if (args[0] === "-C") {
            const archivePath = args[3];
            writeFileSync(archivePath, "tarball");
            cb(null, { stdout: "", stderr: "" });
            return;
          }
          if (args[0] === "-xzf") {
            const archivePath = args[1];
            const targetDir = args[3];
            mkdirSync(targetDir, { recursive: true });
            if (archivePath.endsWith("sync.tar.gz")) {
              mkdirSync(join(targetDir, "sync", "accounts", "test"), {
                recursive: true,
              });
              writeFileSync(
                join(targetDir, "sync", "accounts", "test", "seen-state.db"),
                "sqlite",
              );
              cb(null, { stdout: "", stderr: "" });
              return;
            }
            if (archivePath.endsWith("secrets.tar.gz")) {
              mkdirSync(join(targetDir, "secrets"), { recursive: true });
              writeFileSync(
                join(targetDir, "secrets", "conat-password"),
                "secret\n",
              );
              cb(null, { stdout: "", stderr: "" });
              return;
            }
          }
          cb(new Error(`unexpected tar args '${args.join(" ")}'`));
          return;
        }
        if (cmd === "rustic-bin") {
          const subcommand =
            args.find((arg) =>
              ["backup", "snapshots", "restore"].includes(arg),
            ) ?? "";
          if (subcommand === "backup") {
            const host = args[args.indexOf("--host") + 1];
            const tags = args
              .flatMap((arg, i) =>
                args[i - 1] === "--tag" ? [arg] : ([] as string[]),
              )
              .filter(Boolean);
            const files: Record<string, Buffer> = {};
            for (const name of [
              "base.tar.gz",
              "pg_wal.tar.gz",
              "cluster.sql.gz",
              "sync.tar.gz",
              "secrets.tar.gz",
              "manifest.json",
            ] as const) {
              try {
                files[name] = readFileSync(join(`${opts.cwd ?? ""}`, name));
              } catch {
                // ignore missing files
              }
            }
            rusticSnapshots.push({
              id: `snap-${rusticSnapshots.length + 1}`,
              host,
              tags,
              files,
            });
            cb(null, { stdout: "", stderr: "" });
            return;
          }
          if (subcommand === "snapshots") {
            const host = args[args.indexOf("--filter-host") + 1];
            const snapshots = rusticSnapshots
              .filter((snapshot) => snapshot.host === host)
              .map((snapshot) => ({
                id: snapshot.id,
                time: "2026-04-07T15:37:57.440Z",
                hostname: snapshot.host,
                tags: snapshot.tags,
                paths: ["."],
              }));
            cb(null, {
              stdout: JSON.stringify([
                {
                  group_key: { hostname: host, label: "", paths: ["."] },
                  snapshots,
                },
              ]),
              stderr: "",
            });
            return;
          }
          if (subcommand === "restore") {
            const snapshotSpec = args[args.indexOf("restore") + 1];
            const destinationDir = args[args.indexOf("restore") + 2];
            const [snapshotId, relativePath] = snapshotSpec.split(":");
            const snapshot = rusticSnapshots.find(
              (entry) => entry.id === snapshotId,
            );
            if (!snapshot) {
              cb(new Error(`unknown snapshot '${snapshotId}'`));
              return;
            }
            mkdirSync(destinationDir, { recursive: true });
            if (relativePath) {
              const file = snapshot.files[relativePath];
              if (!file) {
                cb(
                  new Error(
                    `snapshot '${snapshotId}' is missing '${relativePath}'`,
                  ),
                );
                return;
              }
              writeFileSync(join(destinationDir, relativePath), file);
              cb(null, { stdout: "", stderr: "" });
              return;
            }
            cb(new Error("full rustic restore is not mocked in this test"));
            return;
          }
          cb(new Error(`unexpected rustic args '${args.join(" ")}'`));
          return;
        }
        cb(new Error(`unexpected command '${cmd}'`));
      },
    );
    getPoolMock = jest.fn(() => ({
      query: jest.fn(async () => ({
        rows: [
          {
            current_user: "smc",
            role_superuser: false,
            role_replication: false,
            data_directory: "/tmp/pgdata",
            config_file: "/tmp/pgdata/postgresql.conf",
            archive_mode: "off",
            archive_command: null,
            archive_timeout: null,
            wal_level: "minimal",
            max_wal_senders: "0",
          },
        ],
      })),
    }));
    getServerSettingsMock = jest.fn(async () => ({}));
    getSingleBayInfoMock = jest.fn(() => ({
      bay_id: "bay-0",
      label: "bay-0",
      region: null,
      deployment_mode: "single-bay",
      role: "combined",
      is_default: true,
    }));
  });

  afterEach(async () => {
    process.env = oldEnv;
    global.fetch = oldFetch as typeof global.fetch;
    await rm(backupRoot, { recursive: true, force: true });
  });

  it("runs a retained local pg_dumpall backup and persists state", async () => {
    const { getBayBackupStatus, runBayBackup } = await import("./index");

    const result = await runBayBackup();
    expect(result.format).toBe("pg_dumpall");
    expect(result.storage_backend).toBe("local");
    expect(result.artifact_count).toBe(5);
    expect(result.artifacts.map((artifact) => artifact.name)).toEqual([
      "RESTORE-OFFLINE.txt",
      "cluster.sql.gz",
      "restore-offline.sh",
      "secrets.tar.gz",
      "sync.tar.gz",
    ]);
    expect(readFileSync(result.artifacts[0].local_path!, "utf8")).toBeDefined();

    const manifest = JSON.parse(
      await readFile(result.local_manifest_path, "utf8"),
    );
    expect(manifest.format).toBe("pg_dumpall");
    expect(manifest.latest_storage_backend).toBe("local");
    expect(manifest.artifacts.map((artifact) => artifact.name)).toEqual([
      "RESTORE-OFFLINE.txt",
      "cluster.sql.gz",
      "restore-offline.sh",
      "secrets.tar.gz",
      "sync.tar.gz",
    ]);

    const status = await getBayBackupStatus();
    expect(status.postgres.preferred_strategy).toBe("pg_dumpall");
    expect(status.bay_backup.latest_backup_set_id).toBe(result.backup_set_id);
    expect(status.bay_backup.latest_storage_backend).toBe("local");
    expect(status.bay_backup.restore_state).toBe("ready-local-only");
    expect(status.restore_readiness.latest_backup_restore_test_status).toBe(
      "not-run",
    );
    expect(status.restore_readiness.gold_star).toBe(false);
  });

  it("backs up snapshots to rustic and restores from rustic when local archives are absent", async () => {
    getServerSettingsMock = jest.fn(async () => ({
      r2_account_id: "acct-1",
      r2_access_key_id: "key-1",
      r2_secret_access_key: "secret-1",
      r2_bucket_prefix: "lite4-dev",
    }));

    const { runBayBackup, runBayRestore } = await import("./index");

    const backup = await runBayBackup();
    expect(backup.storage_backend).toBe("rustic");
    expect(backup.remote_snapshot_id).toBe("snap-1");
    expect(backup.rustic_repo_selector).toBe("r2:bay-backups:wnam");

    await rm(backup.local_manifest_path, { force: true });
    await rm(
      join(
        backupRoot,
        "bay-backups",
        "bay-0",
        "archives",
        backup.backup_set_id,
      ),
      { recursive: true, force: true },
    );

    const restoreTargetDir = join(backupRoot, "rustic-restore-target");
    const restored = await runBayRestore({
      backup_set_id: backup.backup_set_id,
      target_dir: restoreTargetDir,
      dry_run: false,
    });
    expect(restored.source_storage_backend).toBe("rustic");
    expect(restored.source_snapshot_id).toBe("snap-1");
    expect(restored.rustic_repo_selector).toBe("r2:bay-backups:wnam");
    expect(readFileSync(join(restoreTargetDir, "cluster.sql"), "utf8")).toBe(
      "SELECT 1;\n",
    );
    expect(
      readFileSync(
        join(restoreTargetDir, "sync", "accounts", "test", "seen-state.db"),
        "utf8",
      ),
    ).toBe("sqlite");
    expect(
      readFileSync(join(restoreTargetDir, "secrets", "conat-password"), "utf8"),
    ).toBe("secret\n");
  });

  it("falls back from pg_basebackup to pg_dumpall when replication is blocked", async () => {
    getPoolMock = jest.fn(() => ({
      query: jest.fn(async () => ({
        rows: [
          {
            current_user: "smc",
            role_superuser: true,
            role_replication: false,
            data_directory: "/tmp/pgdata",
            config_file: "/tmp/pgdata/postgresql.conf",
            archive_mode: "off",
            archive_command: null,
            archive_timeout: null,
            wal_level: "replica",
            max_wal_senders: "10",
          },
        ],
      })),
    }));
    execFileMock = jest.fn(
      (
        cmd: string,
        args: string[],
        _opts: Record<string, unknown>,
        cb: (
          err: Error | null,
          result?: { stdout: string; stderr: string },
        ) => void,
      ) => {
        if (cmd === "pg_basebackup") {
          cb(
            new Error(
              "pg_basebackup: error: no pg_hba.conf entry for replication connection",
            ),
          );
          return;
        }
        if (cmd === "pg_dumpall") {
          const fileFlag = args.indexOf("--file");
          const path = args[fileFlag + 1];
          writeFileSync(path, "SELECT 1;\n");
          cb(null, { stdout: "", stderr: "" });
          return;
        }
        if (cmd === "sqlite3") {
          const sourcePath = args[0];
          const backupArg = args.find((arg) => arg.startsWith(".backup "));
          const match = backupArg?.match(/^\.backup '(.+)'$/);
          const destinationPath = match?.[1];
          if (!destinationPath) {
            cb(new Error("missing sqlite backup destination"));
            return;
          }
          writeFileSync(destinationPath, readFileSync(sourcePath));
          cb(null, { stdout: "", stderr: "" });
          return;
        }
        if (cmd === "tar") {
          const archivePath = args[3];
          writeFileSync(archivePath, "tarball");
          cb(null, { stdout: "", stderr: "" });
          return;
        }
        cb(new Error(`unexpected command '${cmd}'`));
      },
    );

    const { runBayBackup } = await import("./index");

    const result = await runBayBackup();
    expect(result.format).toBe("pg_dumpall");
    expect(execFileMock.mock.calls[0][0]).toBe("pg_basebackup");
    expect(execFileMock.mock.calls[1][0]).toBe("pg_dumpall");
  });

  it("stages a fenced pg_basebackup restore workspace", async () => {
    const backupSetId = "restore-backup-1";
    const bayRoot = join(backupRoot, "bay-backups", "bay-0");
    const archivesDir = join(bayRoot, "archives", backupSetId);
    const manifestsDir = join(bayRoot, "manifests");
    const walArchiveDir = join(bayRoot, "wal", "archive");
    const restoreTargetDir = join(backupRoot, "restore-target");
    mkdirSync(archivesDir, { recursive: true });
    mkdirSync(manifestsDir, { recursive: true });
    mkdirSync(walArchiveDir, { recursive: true });
    writeFileSync(join(archivesDir, "base.tar.gz"), "base");
    writeFileSync(join(archivesDir, "pg_wal.tar.gz"), "wal");
    writeFileSync(join(archivesDir, "sync.tar.gz"), "sync");
    writeFileSync(join(archivesDir, "secrets.tar.gz"), "secrets");
    writeFileSync(join(walArchiveDir, "0000000100000000000000E8"), "segment");
    writeFileSync(
      join(manifestsDir, `${backupSetId}.json`),
      JSON.stringify(
        {
          bay_id: "bay-0",
          bay_label: "bay-0",
          backup_set_id: backupSetId,
          created_at: "2026-04-07T15:37:47.519Z",
          finished_at: "2026-04-07T15:37:57.440Z",
          format: "pg_basebackup",
          current_storage_backend: "r2",
          latest_storage_backend: "r2",
          bucket_name: "lite4-dev-wnam",
          bucket_region: "wnam",
          bucket_endpoint: "https://example.invalid",
          object_prefix: `bay-backups/bay-0/${backupSetId}`,
          remote_manifest_key: `bay-backups/bay-0/${backupSetId}/manifest.json`,
          postgres: {},
          artifacts: [
            {
              name: "base.tar.gz",
              local_path: join(archivesDir, "base.tar.gz"),
              object_key: null,
              bytes: 4,
              sha256: "base",
              content_type: "application/gzip",
            },
            {
              name: "pg_wal.tar.gz",
              local_path: join(archivesDir, "pg_wal.tar.gz"),
              object_key: null,
              bytes: 3,
              sha256: "wal",
              content_type: "application/gzip",
            },
            {
              name: "sync.tar.gz",
              local_path: join(archivesDir, "sync.tar.gz"),
              object_key: null,
              bytes: 4,
              sha256: "sync",
              content_type: "application/gzip",
            },
            {
              name: "secrets.tar.gz",
              local_path: join(archivesDir, "secrets.tar.gz"),
              object_key: null,
              bytes: 7,
              sha256: "secrets",
              content_type: "application/gzip",
            },
          ],
        },
        null,
        2,
      ),
    );
    execFileMock = jest.fn(
      (
        cmd: string,
        args: string[],
        _opts: Record<string, unknown>,
        cb: (
          err: Error | null,
          result?: { stdout: string; stderr: string },
        ) => void,
      ) => {
        if (cmd !== "tar") {
          cb(new Error(`unexpected command '${cmd}'`));
          return;
        }
        const archivePath = args[1];
        const targetDir = args[3];
        mkdirSync(targetDir, { recursive: true });
        if (archivePath.endsWith("base.tar.gz")) {
          mkdirSync(join(targetDir, "pg_wal"), { recursive: true });
          writeFileSync(join(targetDir, "PG_VERSION"), "17\n");
        } else if (archivePath.endsWith("pg_wal.tar.gz")) {
          writeFileSync(
            join(targetDir, "0000000100000000000000E8"),
            "stale-segment",
          );
        } else if (archivePath.endsWith("sync.tar.gz")) {
          mkdirSync(join(targetDir, "sync", "accounts", "test"), {
            recursive: true,
          });
          writeFileSync(
            join(targetDir, "sync", "accounts", "test", "seen-state.db"),
            "sqlite",
          );
        } else if (archivePath.endsWith("secrets.tar.gz")) {
          mkdirSync(join(targetDir, "secrets"), { recursive: true });
          writeFileSync(join(targetDir, "secrets", "conat-password"), "secret");
        } else {
          cb(new Error(`unexpected archive '${archivePath}'`));
          return;
        }
        cb(null, { stdout: "", stderr: "" });
      },
    );

    const { runBayRestore } = await import("./index");

    const result = await runBayRestore({
      backup_set_id: backupSetId,
      target_dir: restoreTargetDir,
      dry_run: false,
      target_time: "2026-04-07T08:00:00-07:00",
    });
    expect(result.recovery_ready).toBe(true);
    expect(result.source_storage_backend).toBe("local");
    expect(result.target_time).toBe("2026-04-07T15:00:00.000Z");
    expect(result.data_dir).toBe(join(restoreTargetDir, "data"));
    expect(result.sync_dir).toBe(join(restoreTargetDir, "sync"));
    expect(result.secrets_dir).toBe(join(restoreTargetDir, "secrets"));
    expect(
      readFileSync(join(restoreTargetDir, "data", "standby.signal"), "utf8"),
    ).toBe("");
    expect(
      readFileSync(
        join(restoreTargetDir, "data", "postgresql.auto.conf"),
        "utf8",
      ),
    ).toContain("restore_command");
    expect(
      readFileSync(
        join(restoreTargetDir, "data", "postgresql.auto.conf"),
        "utf8",
      ),
    ).toContain("recovery_target_time = '2026-04-07 15:00:00.000+00'");
    expect(
      readFileSync(join(restoreTargetDir, "restore-wal.sh"), "utf8"),
    ).toContain(walArchiveDir);
    expect(
      readFileSync(
        join(restoreTargetDir, "data", "pg_wal", "0000000100000000000000E8"),
        "utf8",
      ),
    ).toBe("segment");
    expect(
      readFileSync(
        join(restoreTargetDir, "sync", "accounts", "test", "seen-state.db"),
        "utf8",
      ),
    ).toBe("sqlite");
    expect(
      readFileSync(join(restoreTargetDir, "secrets", "conat-password"), "utf8"),
    ).toBe("secret");
    expect(
      JSON.parse(
        readFileSync(join(restoreTargetDir, "restore-manifest.json"), "utf8"),
      ),
    ).toMatchObject({
      backup_set_id: backupSetId,
      target_time: "2026-04-07T15:00:00.000Z",
      recovery_ready: true,
      sync_dir: join(restoreTargetDir, "sync"),
      secrets_dir: join(restoreTargetDir, "secrets"),
      wal_segment_count: 1,
    });
  });

  it("rejects an invalid restore target time", async () => {
    const { runBayRestore } = await import("./index");

    await expect(
      runBayRestore({
        backup_set_id: "backup-1",
        dry_run: true,
        target_time: "yesterday",
      }),
    ).rejects.toThrow(
      "target_time must be an RFC3339 timestamp with an explicit timezone",
    );
  });

  it("rejects target_time for pg_dumpall restores", async () => {
    const backupSetId = "restore-dump-1";
    const bayRoot = join(backupRoot, "bay-backups", "bay-0");
    const manifestsDir = join(bayRoot, "manifests");
    mkdirSync(manifestsDir, { recursive: true });
    writeFileSync(
      join(manifestsDir, `${backupSetId}.json`),
      JSON.stringify(
        {
          bay_id: "bay-0",
          bay_label: "bay-0",
          backup_set_id: backupSetId,
          created_at: "2026-04-07T15:37:47.519Z",
          finished_at: "2026-04-07T15:37:57.440Z",
          format: "pg_dumpall",
          current_storage_backend: "local",
          latest_storage_backend: "local",
          bucket_name: null,
          bucket_region: null,
          bucket_endpoint: null,
          object_prefix: null,
          remote_manifest_key: null,
          remote_snapshot_id: null,
          remote_snapshot_host: null,
          rustic_repo_selector: null,
          postgres: {},
          artifacts: [
            {
              name: "cluster.sql.gz",
              local_path: join(
                bayRoot,
                "archives",
                backupSetId,
                "cluster.sql.gz",
              ),
              object_key: null,
              bytes: 8,
              sha256: "dump",
              content_type: "application/gzip",
            },
          ],
        },
        null,
        2,
      ),
    );

    const { runBayRestore } = await import("./index");

    await expect(
      runBayRestore({
        backup_set_id: backupSetId,
        dry_run: true,
        target_time: "2026-04-07T08:00:00-07:00",
      }),
    ).rejects.toThrow(
      "target_time is only supported for pg_basebackup backups with archived WAL",
    );
  });

  it("restore-tests a pg_basebackup snapshot and records a gold star", async () => {
    const backupSetId = "restore-test-backup-1";
    const bayRoot = join(backupRoot, "bay-backups", "bay-0");
    const archivesDir = join(bayRoot, "archives", backupSetId);
    const manifestsDir = join(bayRoot, "manifests");
    const walArchiveDir = join(bayRoot, "wal", "archive");
    const stateFile = join(bayRoot, "state.json");
    mkdirSync(archivesDir, { recursive: true });
    mkdirSync(manifestsDir, { recursive: true });
    mkdirSync(walArchiveDir, { recursive: true });
    writeFileSync(join(archivesDir, "base.tar.gz"), "base");
    writeFileSync(join(archivesDir, "pg_wal.tar.gz"), "wal");
    writeFileSync(join(archivesDir, "sync.tar.gz"), "sync");
    writeFileSync(join(archivesDir, "secrets.tar.gz"), "secrets");
    writeFileSync(join(walArchiveDir, "0000000100000000000000E8"), "segment");
    writeFileSync(
      stateFile,
      JSON.stringify(
        {
          bay_id: "bay-0",
          current_storage_backend: "rustic",
          r2_configured: false,
          bucket_name: null,
          bucket_region: null,
          bucket_endpoint: null,
          object_prefix_root: null,
          rustic_repo_selector: "r2:bay-backups:wnam",
          latest_backup_set_id: backupSetId,
          latest_format: "pg_basebackup",
          latest_storage_backend: "rustic",
          latest_local_manifest_path: join(manifestsDir, `${backupSetId}.json`),
          latest_remote_manifest_key: null,
          latest_object_prefix: null,
          latest_remote_snapshot_id: "snap-1",
          latest_remote_snapshot_host: "bay-0",
          latest_artifact_count: 4,
          latest_artifact_bytes: 18,
          last_archived_wal_segment: "0000000100000000000000E8",
          last_uploaded_wal_segment: null,
          last_started_at: null,
          last_finished_at: null,
          last_successful_backup_at: "2026-04-07T15:37:57.440Z",
          last_successful_remote_backup_at: "2026-04-07T15:37:57.440Z",
          last_successful_wal_archive_at: "2026-04-07T15:37:57.740Z",
          last_error_at: null,
          last_error: null,
          restore_state: "ready",
          last_restore_test_backup_set_id: null,
          last_restore_test_status: null,
          last_restore_tested_at: null,
          last_restore_test_target_dir: null,
          last_restore_test_recovery_ready: null,
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(manifestsDir, `${backupSetId}.json`),
      JSON.stringify(
        {
          bay_id: "bay-0",
          bay_label: "bay-0",
          backup_set_id: backupSetId,
          created_at: "2026-04-07T15:37:47.519Z",
          finished_at: "2026-04-07T15:37:57.440Z",
          format: "pg_basebackup",
          current_storage_backend: "rustic",
          latest_storage_backend: "rustic",
          bucket_name: "lite4-dev-wnam",
          bucket_region: "wnam",
          bucket_endpoint: "https://example.invalid",
          object_prefix: null,
          remote_manifest_key: null,
          remote_snapshot_id: "snap-1",
          remote_snapshot_host: "bay-0",
          rustic_repo_selector: "r2:bay-backups:wnam",
          postgres: {},
          artifacts: [
            {
              name: "base.tar.gz",
              local_path: join(archivesDir, "base.tar.gz"),
              object_key: null,
              bytes: 4,
              sha256: "base",
              content_type: "application/gzip",
            },
            {
              name: "pg_wal.tar.gz",
              local_path: join(archivesDir, "pg_wal.tar.gz"),
              object_key: null,
              bytes: 3,
              sha256: "wal",
              content_type: "application/gzip",
            },
            {
              name: "sync.tar.gz",
              local_path: join(archivesDir, "sync.tar.gz"),
              object_key: null,
              bytes: 4,
              sha256: "sync",
              content_type: "application/gzip",
            },
            {
              name: "secrets.tar.gz",
              local_path: join(archivesDir, "secrets.tar.gz"),
              object_key: null,
              bytes: 7,
              sha256: "secrets",
              content_type: "application/gzip",
            },
          ],
        },
        null,
        2,
      ),
    );
    execFileMock = jest.fn(
      (
        cmd: string,
        args: string[],
        _opts: Record<string, unknown>,
        cb: (
          err: Error | null,
          result?: { stdout: string; stderr: string },
        ) => void,
      ) => {
        if (cmd === "tar") {
          const archivePath = args[1];
          const targetDir = args[3];
          mkdirSync(targetDir, { recursive: true });
          if (archivePath.endsWith("base.tar.gz")) {
            mkdirSync(join(targetDir, "pg_wal"), { recursive: true });
            writeFileSync(join(targetDir, "PG_VERSION"), "17\n");
          } else if (archivePath.endsWith("pg_wal.tar.gz")) {
            writeFileSync(
              join(targetDir, "0000000100000000000000E8"),
              "segment",
            );
          } else if (archivePath.endsWith("sync.tar.gz")) {
            mkdirSync(join(targetDir, "sync", "accounts", "test"), {
              recursive: true,
            });
            writeFileSync(
              join(targetDir, "sync", "accounts", "test", "seen-state.db"),
              "sqlite",
            );
          } else if (archivePath.endsWith("secrets.tar.gz")) {
            mkdirSync(join(targetDir, "secrets"), { recursive: true });
            writeFileSync(
              join(targetDir, "secrets", "conat-password"),
              "secret",
            );
          } else {
            cb(new Error(`unexpected archive '${archivePath}'`));
            return;
          }
          cb(null, { stdout: "", stderr: "" });
          return;
        }
        if (cmd === "/usr/bin/pg_ctl") {
          cb(null, { stdout: "", stderr: "" });
          return;
        }
        if (cmd === "/usr/bin/psql") {
          const sql = args[args.length - 1];
          if (sql === "SELECT current_database()") {
            cb(null, { stdout: "smc\n", stderr: "" });
            return;
          }
          if (sql === "SELECT to_regclass('public.accounts')::text") {
            cb(null, { stdout: "accounts\n", stderr: "" });
            return;
          }
          if (sql === "SELECT to_regclass('public.projects')::text") {
            cb(null, { stdout: "projects\n", stderr: "" });
            return;
          }
          if (sql === "SELECT to_regclass('public.server_settings')::text") {
            cb(null, { stdout: "server_settings\n", stderr: "" });
            return;
          }
          cb(new Error(`unexpected SQL '${sql}'`));
          return;
        }
        cb(new Error(`unexpected command '${cmd}'`));
      },
    );

    const { getBayBackupStatus, runBayRestoreTest } = await import("./index");

    const result = await runBayRestoreTest({
      backup_set_id: backupSetId,
    });
    expect(result.recovery_ready).toBe(true);
    expect(result.kept_on_disk).toBe(false);
    expect(result.verified_queries).toEqual([
      "current_database=smc",
      "accounts_table=accounts",
      "projects_table=projects",
      "server_settings_table=server_settings",
    ]);

    const status = await getBayBackupStatus();
    expect(status.restore_readiness.latest_backup_restore_test_status).toBe(
      "passed",
    );
    expect(status.restore_readiness.gold_star).toBe(true);
    expect(status.restore_readiness.last_restore_test_backup_set_id).toBe(
      backupSetId,
    );
    expect(status.restore_readiness.last_restore_test_target_dir).toBe(null);
  });

  it("restore-tests remotely from rustic plus R2 WAL when remote-only is requested", async () => {
    const backupSetId = "restore-test-remote-1";
    const bayRoot = join(backupRoot, "bay-backups", "bay-0");
    const manifestsDir = join(bayRoot, "manifests");
    const stateFile = join(bayRoot, "state.json");
    getServerSettingsMock = jest.fn(async () => ({
      r2_account_id: "acct-1",
      r2_access_key_id: "key-1",
      r2_secret_access_key: "secret-1",
      r2_bucket_prefix: "lite4-dev",
    }));
    mkdirSync(manifestsDir, { recursive: true });
    writeFileSync(
      stateFile,
      JSON.stringify(
        {
          bay_id: "bay-0",
          current_storage_backend: "rustic",
          r2_configured: true,
          bucket_name: "lite4-dev-wnam",
          bucket_region: "wnam",
          bucket_endpoint: "https://example.invalid",
          object_prefix_root: "bay-backups/bay-0",
          rustic_repo_selector: "r2:bay-backups:wnam",
          latest_backup_set_id: backupSetId,
          latest_format: "pg_basebackup",
          latest_storage_backend: "rustic",
          latest_local_manifest_path: null,
          latest_remote_manifest_key: null,
          latest_object_prefix: null,
          latest_remote_snapshot_id: "snap-remote-1",
          latest_remote_snapshot_host: "bay-0",
          latest_artifact_count: 4,
          latest_artifact_bytes: 18,
          last_archived_wal_segment: null,
          last_uploaded_wal_segment: "0000000100000000000000E8",
          last_started_at: null,
          last_finished_at: null,
          last_successful_backup_at: "2026-04-07T15:37:57.440Z",
          last_successful_remote_backup_at: "2026-04-07T15:37:57.440Z",
          last_successful_wal_archive_at: "2026-04-07T15:37:57.740Z",
          last_error_at: null,
          last_error: null,
          restore_state: "ready",
          last_restore_test_backup_set_id: null,
          last_restore_test_status: null,
          last_restore_tested_at: null,
          last_restore_test_target_dir: null,
          last_restore_test_recovery_ready: null,
        },
        null,
        2,
      ),
    );

    const manifest = {
      bay_id: "bay-0",
      bay_label: "bay-0",
      backup_set_id: backupSetId,
      created_at: "2026-04-07T15:37:47.519Z",
      finished_at: "2026-04-07T15:37:57.440Z",
      format: "pg_basebackup",
      current_storage_backend: "rustic",
      latest_storage_backend: "rustic",
      bucket_name: "lite4-dev-wnam",
      bucket_region: "wnam",
      bucket_endpoint: "https://example.invalid",
      object_prefix: null,
      remote_manifest_key: null,
      remote_snapshot_id: "snap-remote-1",
      remote_snapshot_host: "bay-0",
      rustic_repo_selector: "r2:bay-backups:wnam",
      postgres: {},
      artifacts: [
        {
          name: "base.tar.gz",
          local_path: null,
          object_key: null,
          bytes: 4,
          sha256: "base",
          content_type: "application/gzip",
        },
        {
          name: "pg_wal.tar.gz",
          local_path: null,
          object_key: null,
          bytes: 3,
          sha256: "wal",
          content_type: "application/gzip",
        },
        {
          name: "sync.tar.gz",
          local_path: null,
          object_key: null,
          bytes: 4,
          sha256: "sync",
          content_type: "application/gzip",
        },
        {
          name: "secrets.tar.gz",
          local_path: null,
          object_key: null,
          bytes: 7,
          sha256: "secrets",
          content_type: "application/gzip",
        },
      ],
    };
    rusticSnapshots.push({
      id: "snap-remote-1",
      host: "bay-0",
      tags: [
        `backup-set-id=${backupSetId}`,
        "backup-format=pg_basebackup",
        "bay-id=bay-0",
      ],
      files: {
        "manifest.json": Buffer.from(JSON.stringify(manifest)),
        "base.tar.gz": Buffer.from("base"),
        "pg_wal.tar.gz": Buffer.from("wal"),
        "sync.tar.gz": Buffer.from("sync"),
        "secrets.tar.gz": Buffer.from("secrets"),
      },
    });
    listObjectsMock = jest.fn(async ({ prefix }: { prefix?: string }) => {
      if (prefix !== "bay-backups/bay-0/wal/") {
        throw new Error(`unexpected WAL prefix '${prefix}'`);
      }
      return ["bay-backups/bay-0/wal/0000000100000000000000E8"];
    });
    execFileMock = jest.fn(
      (
        cmd: string,
        args: string[],
        _opts: Record<string, unknown>,
        cb: (
          err: Error | null,
          result?: { stdout: string; stderr: string },
        ) => void,
      ) => {
        if (cmd === "rustic-bin") {
          const subcommand =
            args.find((arg) => ["snapshots", "restore"].includes(arg)) ?? "";
          if (subcommand === "snapshots") {
            cb(null, {
              stdout: JSON.stringify([
                {
                  group_key: { hostname: "bay-0", label: "", paths: ["."] },
                  snapshots: [
                    {
                      id: "snap-remote-1",
                      time: "2026-04-07T15:37:57.440Z",
                      hostname: "bay-0",
                      tags: [
                        `backup-set-id=${backupSetId}`,
                        "backup-format=pg_basebackup",
                        "bay-id=bay-0",
                      ],
                      paths: ["."],
                    },
                  ],
                },
              ]),
              stderr: "",
            });
            return;
          }
          const snapshotSpec = args[args.indexOf("restore") + 1];
          const destinationDir = args[args.indexOf("restore") + 2];
          const [snapshotId, relativePath] = snapshotSpec.split(":");
          const snapshot = rusticSnapshots.find(
            (entry) => entry.id === snapshotId,
          );
          if (!snapshot || !relativePath) {
            cb(new Error(`unexpected rustic restore '${snapshotSpec}'`));
            return;
          }
          mkdirSync(destinationDir, { recursive: true });
          writeFileSync(
            join(destinationDir, relativePath),
            snapshot.files[relativePath],
          );
          cb(null, { stdout: "", stderr: "" });
          return;
        }
        if (cmd === "tar") {
          const archivePath = args[1];
          const targetDir = args[3];
          mkdirSync(targetDir, { recursive: true });
          if (archivePath.endsWith("base.tar.gz")) {
            mkdirSync(join(targetDir, "pg_wal"), { recursive: true });
            writeFileSync(join(targetDir, "PG_VERSION"), "17\n");
          } else if (archivePath.endsWith("pg_wal.tar.gz")) {
            writeFileSync(
              join(targetDir, "0000000100000000000000E8"),
              "segment-from-base",
            );
          } else if (archivePath.endsWith("sync.tar.gz")) {
            mkdirSync(join(targetDir, "sync", "accounts", "test"), {
              recursive: true,
            });
            writeFileSync(
              join(targetDir, "sync", "accounts", "test", "seen-state.db"),
              "sqlite",
            );
          } else if (archivePath.endsWith("secrets.tar.gz")) {
            mkdirSync(join(targetDir, "secrets"), { recursive: true });
            writeFileSync(
              join(targetDir, "secrets", "conat-password"),
              "secret",
            );
          } else {
            cb(new Error(`unexpected archive '${archivePath}'`));
            return;
          }
          cb(null, { stdout: "", stderr: "" });
          return;
        }
        if (cmd === "/usr/bin/pg_ctl") {
          cb(null, { stdout: "", stderr: "" });
          return;
        }
        if (cmd === "/usr/bin/psql") {
          const sql = args[args.length - 1];
          if (sql === "SELECT current_database()") {
            cb(null, { stdout: "smc\n", stderr: "" });
            return;
          }
          if (sql === "SELECT to_regclass('public.accounts')::text") {
            cb(null, { stdout: "accounts\n", stderr: "" });
            return;
          }
          if (sql === "SELECT to_regclass('public.projects')::text") {
            cb(null, { stdout: "projects\n", stderr: "" });
            return;
          }
          if (sql === "SELECT to_regclass('public.server_settings')::text") {
            cb(null, { stdout: "server_settings\n", stderr: "" });
            return;
          }
          cb(new Error(`unexpected SQL '${sql}'`));
          return;
        }
        cb(new Error(`unexpected command '${cmd}'`));
      },
    );

    const { runBayRestoreTest } = await import("./index");

    const result = await runBayRestoreTest({
      backup_set_id: backupSetId,
      remote_only: true,
      keep: true,
    });
    expect(result.source_storage_backend).toBe("rustic");
    expect(result.wal_storage_backend).toBe("r2");
    expect(result.remote_only).toBe(true);
    expect(result.kept_on_disk).toBe(true);
    expect(result.wal_archive_dir).toBe(null);
    expect(
      readFileSync(join(result.target_dir, "restore-wal.js"), "utf8"),
    ).toContain("bay-backups/bay-0/wal");
    expect(
      readFileSync(join(result.target_dir, "restore-wal.js"), "utf8"),
    ).toContain("https://acct-1.r2.cloudflarestorage.com");
    expect(listObjectsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prefix: "bay-backups/bay-0/wal/",
      }),
    );
  });
});
