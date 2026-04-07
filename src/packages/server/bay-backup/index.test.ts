export {};

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let execFileMock: jest.Mock;
let getPoolMock: jest.Mock;
let getServerSettingsMock: jest.Mock;
let getSingleBayInfoMock: jest.Mock;

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

jest.mock("@cocalc/server/project-backup/r2", () => ({
  __esModule: true,
  createBucket: jest.fn(),
  listBuckets: jest.fn(async () => []),
  uploadObjectFromBuffer: jest.fn(),
  uploadObjectFromFile: jest.fn(),
}));

describe("bay-backup runner", () => {
  let backupRoot: string;
  let oldEnv: NodeJS.ProcessEnv;

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
    await rm(backupRoot, { recursive: true, force: true });
  });

  it("runs a retained local pg_dumpall backup and persists state", async () => {
    const { getBayBackupStatus, runBayBackup } = await import("./index");

    const result = await runBayBackup();
    expect(result.format).toBe("pg_dumpall");
    expect(result.storage_backend).toBe("local");
    expect(result.artifact_count).toBe(3);
    expect(result.artifacts.map((artifact) => artifact.name)).toEqual([
      "cluster.sql.gz",
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
      "cluster.sql.gz",
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
          writeFileSync(join(targetDir, "0000000100000000000000E8"), "segment");
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
    });
    expect(result.recovery_ready).toBe(true);
    expect(result.source_storage_backend).toBe("local");
    expect(result.data_dir).toBe(join(restoreTargetDir, "data"));
    expect(result.sync_dir).toBe(join(restoreTargetDir, "sync"));
    expect(result.secrets_dir).toBe(join(restoreTargetDir, "secrets"));
    expect(
      readFileSync(join(restoreTargetDir, "data", "restore.signal"), "utf8"),
    ).toBe("");
    expect(
      readFileSync(
        join(restoreTargetDir, "data", "postgresql.auto.conf"),
        "utf8",
      ),
    ).toContain("restore_command");
    expect(
      readFileSync(join(restoreTargetDir, "restore-wal.sh"), "utf8"),
    ).toContain(walArchiveDir);
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
      recovery_ready: true,
      sync_dir: join(restoreTargetDir, "sync"),
      secrets_dir: join(restoreTargetDir, "secrets"),
      wal_segment_count: 1,
    });
  });
});
