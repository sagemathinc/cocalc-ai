/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  buildDisposableRestoreStartupScript,
  createTemporaryR2ReadCredentials,
  disposableRestoreInstanceName,
  isRetryableDisposablePitrWalFailure,
  runDisposableGcpRestoreWorker,
  type DisposableRestoreWorkerConfig,
  type DisposableRestoreWorkerResult,
} from "./disposable-gcp";
import { spawnSync } from "node:child_process";

const serviceAccount = JSON.stringify({
  project_id: "restore-project",
  client_email: "restore@example.com",
  private_key: "private-key",
});

function config(): DisposableRestoreWorkerConfig {
  return {
    run_id: "11111111-1111-4111-8111-111111111111",
    result_nonce: "nonce-1",
    bay_id: "bay-1",
    backup_set_id: "backup-1",
    snapshot_id: "snapshot-1",
    restore_mode: "pitr",
    target_time: "2026-07-19T12:00:00.000Z",
    pitr_run_id: "22222222-2222-4222-8222-222222222222",
    postgres_major: 17,
    postgres_user: "smc",
    postgres_database: "smc",
    r2_endpoint: "https://account.r2.cloudflarestorage.com",
    r2_bucket: "backup-bucket",
    r2_access_key_id: "temporary-access",
    r2_secret_access_key: "temporary-secret",
    r2_session_token: "temporary-session",
    rustic_repo_root: "rustic/bay-backups/wnam",
    rustic_repo_password: "repo-password",
    wal_object_prefix: "bay-backups/bay-1/wal",
    require_conat: true,
    minimum_free_bytes: 10_000,
  };
}

function pgBackRestConfig(): DisposableRestoreWorkerConfig {
  return {
    ...config(),
    repository_type: "pgbackrest",
    snapshot_id: "sqlite-snapshot-1",
    rustic_repo_root: "rustic/bay-sqlite/bay-1",
    pgbackrest_repo_path: "/pgbackrest/bay-1",
    pgbackrest_cipher_pass: "pgbackrest-password",
    pgbackrest_stanza: "cocalc-bay-1",
    pgbackrest_version: "2.59.0",
    pgbackrest_source_sha256:
      "faaf8faa14a6392279654ee216a493fcd07b0c513af4b55fe34faec062cb8875",
    wal_object_prefix: undefined,
  };
}

function decodedStartupBlocks(script: string): string[] {
  return Array.from(script.matchAll(/printf '%s' '([^']+)' \| base64 -d/g)).map(
    (match) => Buffer.from(match[1], "base64").toString("utf8"),
  );
}

function passedWorker(): DisposableRestoreWorkerResult {
  return {
    version: 1,
    status: "passed",
    run_id: config().run_id,
    stage: "complete",
    started_at: "2026-07-19T12:00:00Z",
    finished_at: "2026-07-19T12:01:00Z",
    duration_ms: 60_000,
    postgres: {
      restore_mode: "pitr",
      pitr_verified: true,
      pre_count: 1,
      post_count: 0,
      database: "smc",
      tables_verified: ["accounts", "projects", "server_settings"],
    },
    conat: {
      sync_tree_found: true,
      database_count: 3,
      database_bytes: 1234,
      quick_check_passed: 3,
      catalog_found: true,
      catalog_quick_check: "ok",
    },
  };
}

test("temporary R2 credentials are read-only and prefix scoped", async () => {
  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
    expect(init?.headers).toEqual({
      authorization: "Bearer api-token",
      "content-type": "application/json",
    });
    expect(JSON.parse(`${init?.body}`)).toEqual({
      bucket: "backup-bucket",
      parentAccessKeyId: "parent-access",
      permission: "object-read-only",
      ttlSeconds: 7200,
      prefixes: ["rustic/bay-backups/wnam/", "bay-backups/bay-1/wal/"],
    });
    return new Response(
      JSON.stringify({
        success: true,
        result: {
          accessKeyId: "temporary-access",
          secretAccessKey: "temporary-secret",
          sessionToken: "temporary-session",
        },
      }),
      { status: 200 },
    );
  });

  await expect(
    createTemporaryR2ReadCredentials({
      account_id: "account",
      api_token: "api-token",
      bucket: "backup-bucket",
      parent_access_key_id: "parent-access",
      prefixes: ["/rustic/bay-backups/wnam/", "bay-backups/bay-1/wal"],
      ttl_seconds: 7200,
      fetch_impl: fetchMock as typeof fetch,
    }),
  ).resolves.toMatchObject({
    access_key_id: "temporary-access",
    session_token: "temporary-session",
  });
});

test("startup script does not expose temporary credentials as plaintext", () => {
  const script = buildDisposableRestoreStartupScript(config());
  expect(Buffer.byteLength(script)).toBeLessThan(256 * 1024);
  expect(script).toContain("iptables -P INPUT DROP");
  expect(script).toContain("python3 /root/cocalc-restore-worker.py");
  expect(script).not.toContain("temporary-secret");
  expect(script).not.toContain("repo-password");
  const encodedBlocks = Array.from(
    script.matchAll(/printf '%s' '([^']+)' \| base64 -d/g),
  );
  expect(encodedBlocks).toHaveLength(2);
  const workerSource = Buffer.from(encodedBlocks[1][1], "base64").toString(
    "utf8",
  );
  const compiled = spawnSync(
    "python3",
    ["-c", "import sys; compile(sys.stdin.read(), '<worker>', 'exec')"],
    { input: workerSource, encoding: "utf8" },
  );
  expect(compiled.stderr).toBe("");
  expect(compiled.status).toBe(0);
});

test("startup script supports checkpoint-only snapshot recovery", () => {
  const snapshotConfig: DisposableRestoreWorkerConfig = {
    ...config(),
    restore_mode: "snapshot",
    target_time: undefined,
    pitr_run_id: undefined,
    wal_object_prefix: undefined,
  };
  const script = buildDisposableRestoreStartupScript(snapshotConfig);
  const encodedBlocks = Array.from(
    script.matchAll(/printf '%s' '([^']+)' \| base64 -d/g),
  );
  const workerSource = Buffer.from(encodedBlocks[1][1], "base64").toString(
    "utf8",
  );
  expect(workerSource).toContain(
    'STAGE = "postgres-" + CONFIG["restore_mode"]',
  );
  expect(workerSource).toContain('"recovery.signal", "standby.signal"');
  expect(workerSource).toContain('"-c", "fsync=off"');
  expect(workerSource).toContain('STAGE = "postgres-snapshot-recovery"');
  expect(workerSource).toContain('input_text="SELECT 1;\\n"');
  expect(workerSource).toContain('"--user", "999:999"');
  expect(workerSource).toContain("postgres_diagnostics(container)");
  expect(workerSource).toContain(
    "suppressed {suppressed} repeated readiness failures",
  );
  const compiled = spawnSync(
    "python3",
    ["-c", "import sys; compile(sys.stdin.read(), '<worker>', 'exec')"],
    { input: workerSource, encoding: "utf8" },
  );
  expect(compiled.stderr).toBe("");
  expect(compiled.status).toBe(0);
});

test("startup script supports pgBackRest PITR and independent SQLite restore", () => {
  const script = buildDisposableRestoreStartupScript(pgBackRestConfig());
  expect(script).not.toContain("pgbackrest-password");
  expect(script).not.toContain("temporary-secret");
  const [encodedConfig, workerSource] = decodedStartupBlocks(script);
  expect(JSON.parse(encodedConfig)).toMatchObject({
    repository_type: "pgbackrest",
    backup_set_id: "backup-1",
    snapshot_id: "sqlite-snapshot-1",
    target_time: "2026-07-19 12:00:00.000+00",
  });
  expect(workerSource).toContain('STAGE = "build-pgbackrest"');
  expect(workerSource).toContain('"--type=time"');
  expect(workerSource).toContain('"--target-action=promote"');
  expect(workerSource).toContain('if REPOSITORY_TYPE != "pgbackrest"');
  expect(workerSource).toContain(
    'for stale in ("recovery.signal", "standby.signal")',
  );
  expect(workerSource).toContain(
    "\"restore_command = '/usr/local/bin/cocalc-pgbackrest-archive-get %f %p'\\n\"",
  );
  expect(workerSource).toContain('"io-timeout=" + str(io_timeout)');
  expect(workerSource).toContain('"protocol-timeout=" + str(protocol_timeout)');
  expect(workerSource).toContain(
    'timeout --foreground --signal=TERM --kill-after=10s "$timeout_seconds"',
  );
  expect(workerSource).toContain(
    '"WAL replay stalled on segment " + segment +',
  );
  expect(workerSource).toContain("archive_get_state(container)");
  const wrapper = workerSource.match(
    /pgbackrest_archive_get_script\.write_text\(r'''([\s\S]*?)''', encoding="utf-8"\)/,
  )?.[1];
  expect(wrapper).toBeTruthy();
  const checkedWrapper = spawnSync("bash", ["-n"], {
    input: wrapper,
    encoding: "utf8",
  });
  expect(checkedWrapper.stderr).toBe("");
  expect(checkedWrapper.status).toBe(0);
  expect(workerSource).toContain('"-c", "port=5432"');
  expect(workerSource).toContain('"-p", "5432"');
  expect(workerSource).toContain('"--security-opt=apparmor=unconfined"');
  expect(workerSource).toContain(
    "--no-install-recommends ca-certificates coreutils libbz2-1.0",
  );
  expect(workerSource).toContain(
    '"PostgreSQL container exited before readiness: "',
  );
  expect(workerSource).toContain(
    '["podman", "logs", "--tail", "80", container]',
  );
  expect(workerSource).toContain(
    '"restore-drill: PostgreSQL recovery still in progress "',
  );
  expect(workerSource).toContain('" sentinel_counts=" + str(counts)');
  expect(workerSource).toContain("deadline = STARTED + worker_timeout - 300");
  expect(workerSource).not.toContain('["shutdown", "-h", "now"]');
  expect(workerSource).toContain("PGBACKREST_REPO1_S3_TOKEN");
  expect(workerSource).toContain("sync_dir = SNAPSHOT");
  expect(workerSource).toContain("input_text=None, log=True");
  expect(workerSource).toContain("log=False");
  expect(workerSource).toContain("def psql(container, sql, *, log=True)");
  expect(workerSource).toContain(
    'sql_quote(CONFIG["pitr_run_id"]), log=False)',
  );
  expect(workerSource).toContain('"pg_is_in_recovery()::text "');
  expect(workerSource).toContain(
    'if counts == (1, 0) and recovery_text == "false"',
  );
  expect(workerSource).toContain(
    "SQLite quick_check progress {quick_passed}/{len(db_files)}",
  );
  const compiled = spawnSync(
    "python3",
    ["-c", "import sys; compile(sys.stdin.read(), '<worker>', 'exec')"],
    { input: workerSource, encoding: "utf8" },
  );
  expect(compiled.stderr).toBe("");
  expect(compiled.status).toBe(0);
});

test("startup script rejects an invalid PITR target", () => {
  expect(() =>
    buildDisposableRestoreStartupScript({
      ...pgBackRestConfig(),
      target_time: "not-a-timestamp",
    }),
  ).toThrow("invalid disposable PITR target 'not-a-timestamp'");
});

test("only a diagnosed PITR WAL stall is eligible for a fresh worker retry", () => {
  const worker = passedWorker();
  expect(
    isRetryableDisposablePitrWalFailure({
      ...worker,
      status: "failed",
      stage: "postgres-pitr",
      error:
        "WAL replay stalled on segment 00000001000003C700000041 for 600 seconds",
    }),
  ).toBe(true);
  expect(
    isRetryableDisposablePitrWalFailure({
      ...worker,
      status: "failed",
      stage: "restore-pgbackrest",
      error: "pgBackRest source checksum mismatch",
    }),
  ).toBe(false);
});

test("disposable worker names are deterministic for crash cleanup", () => {
  expect(disposableRestoreInstanceName(config().run_id)).toBe(
    "cocalc-restore-11111111111141118111",
  );
});

test("GCP worker attempts cleanup when instance insertion fails ambiguously", async () => {
  const deleteInstance = jest.fn(async () => {
    const err = new Error("not found") as Error & { code: number };
    err.code = 404;
    throw err;
  });
  await expect(
    runDisposableGcpRestoreWorker({
      service_account_json: serviceAccount,
      zone: "us-west1-b",
      boot_disk_gb: 50,
      config: config(),
      clients: {
        instances: {
          insert: jest.fn(async () => {
            throw new Error("insert response timed out");
          }),
          delete: deleteInstance,
          getSerialPortOutput: jest.fn(),
        } as any,
        operations: {} as any,
      },
    }),
  ).rejects.toThrow("insert response timed out");
  expect(deleteInstance).toHaveBeenCalledWith(
    expect.objectContaining({
      instance: expect.stringMatching(/^cocalc-restore-/),
    }),
  );
});

test("GCP worker parses a bounded result and always deletes the VM", async () => {
  const worker = passedWorker();
  const marker = `COCALC_BAY_RESTORE_DRILL_RESULT_V1_nonce-1=${Buffer.from(
    JSON.stringify(worker),
  ).toString("base64")}\n`;
  const insert = jest.fn(async () => [{ name: "insert-1", status: "DONE" }]);
  const deleteInstance = jest.fn(async () => [
    { name: "delete-1", status: "DONE" },
  ]);
  const getSerialPortOutput = jest.fn(async () => [
    { contents: marker, next: "100" },
  ]);
  const result = await runDisposableGcpRestoreWorker({
    service_account_json: serviceAccount,
    zone: "us-west1-b",
    boot_disk_gb: 50,
    config: config(),
    clients: {
      instances: {
        insert,
        delete: deleteInstance,
        get: jest.fn(),
        getSerialPortOutput,
      } as any,
      operations: { wait: jest.fn() } as any,
    },
  });
  expect(result.worker.status).toBe("passed");
  expect(result.cleanup).toBe("deleted");
  expect(insert).toHaveBeenCalledWith(
    expect.objectContaining({
      instanceResource: expect.objectContaining({
        serviceAccounts: [],
        deletionProtection: false,
      }),
    }),
  );
  const startupScript =
    insert.mock.calls[0][0].instanceResource.metadata.items.find(
      (item: { key: string }) => item.key === "startup-script",
    ).value;
  const [encodedConfig] = decodedStartupBlocks(startupScript);
  expect(JSON.parse(encodedConfig).worker_timeout_seconds).toBe(7200);
  expect(deleteInstance).toHaveBeenCalledTimes(1);
});

test("GCP worker waits for a complete serial result line", async () => {
  const worker = passedWorker();
  const marker = `COCALC_BAY_RESTORE_DRILL_RESULT_V1_nonce-1=${Buffer.from(
    JSON.stringify(worker),
  ).toString("base64")}\n`;
  const splitAt = marker.length - 12;
  const getSerialPortOutput = jest
    .fn()
    .mockResolvedValueOnce([
      { contents: marker.slice(0, splitAt), next: `${splitAt}` },
    ])
    .mockResolvedValueOnce([
      { contents: marker.slice(splitAt), next: `${marker.length}` },
    ]);
  const deleteInstance = jest.fn(async () => [
    { name: "delete-1", status: "DONE" },
  ]);

  const result = await runDisposableGcpRestoreWorker({
    service_account_json: serviceAccount,
    zone: "us-west1-b",
    boot_disk_gb: 50,
    config: config(),
    sleep: async () => undefined,
    clients: {
      instances: {
        insert: jest.fn(async () => [{ name: "insert-1", status: "DONE" }]),
        delete: deleteInstance,
        get: jest.fn(),
        getSerialPortOutput,
      } as any,
      operations: { wait: jest.fn() } as any,
    },
  });

  expect(result.worker.status).toBe("passed");
  expect(getSerialPortOutput).toHaveBeenCalledTimes(2);
  expect(deleteInstance).toHaveBeenCalledTimes(1);
});

test("GCP worker deletes the VM when the serial result is invalid", async () => {
  const deleteInstance = jest.fn(async () => [
    { name: "delete-1", status: "DONE" },
  ]);
  await expect(
    runDisposableGcpRestoreWorker({
      service_account_json: serviceAccount,
      zone: "us-west1-b",
      boot_disk_gb: 50,
      config: config(),
      clients: {
        instances: {
          insert: jest.fn(async () => [{ name: "insert-1", status: "DONE" }]),
          delete: deleteInstance,
          get: jest.fn(),
          getSerialPortOutput: jest.fn(async () => {
            throw new Error("serial API failed");
          }),
        } as any,
        operations: { wait: jest.fn() } as any,
      },
    }),
  ).rejects.toThrow("serial API failed");
  expect(deleteInstance).toHaveBeenCalledTimes(1);
});
