export {};

import { readFileSync, writeFileSync } from "node:fs";
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
    process.env.PGHOST = "/tmp/cocalc-test-pg";
    process.env.PGUSER = "smc";
    process.env.PGDATABASE = "smc";
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
        if (cmd !== "pg_dumpall") {
          cb(new Error(`unexpected command '${cmd}'`));
          return;
        }
        const fileFlag = args.indexOf("--file");
        const path = args[fileFlag + 1];
        writeFileSync(path, "SELECT 1;\n");
        cb(null, { stdout: "", stderr: "" });
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
    expect(result.artifact_count).toBe(1);
    expect(result.artifacts[0].name).toBe("cluster.sql.gz");
    expect(readFileSync(result.artifacts[0].local_path!, "utf8")).toBeDefined();

    const manifest = JSON.parse(
      await readFile(result.local_manifest_path, "utf8"),
    );
    expect(manifest.format).toBe("pg_dumpall");
    expect(manifest.latest_storage_backend).toBe("local");
    expect(manifest.artifacts[0].name).toBe("cluster.sql.gz");

    const status = await getBayBackupStatus();
    expect(status.postgres.preferred_strategy).toBe("pg_dumpall");
    expect(status.bay_backup.latest_backup_set_id).toBe(result.backup_set_id);
    expect(status.bay_backup.latest_storage_backend).toBe("local");
    expect(status.bay_backup.restore_state).toBe("ready-local-only");
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
        cb(new Error(`unexpected command '${cmd}'`));
      },
    );

    const { runBayBackup } = await import("./index");

    const result = await runBayBackup();
    expect(result.format).toBe("pg_dumpall");
    expect(execFileMock.mock.calls[0][0]).toBe("pg_basebackup");
    expect(execFileMock.mock.calls[1][0]).toBe("pg_dumpall");
  });
});
