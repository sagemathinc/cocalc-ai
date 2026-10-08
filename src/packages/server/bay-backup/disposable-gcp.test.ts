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
  workerStageSeconds,
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
    'STAGE = enter_stage("postgres-" + CONFIG["restore_mode"])',
  );
  expect(workerSource).toContain('"recovery.signal", "standby.signal"');
  expect(workerSource).toContain('"-c", "fsync=off"');
  expect(workerSource).toContain(
    'STAGE = enter_stage("postgres-snapshot-recovery")',
  );
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
  expect(workerSource).toContain('STAGE = enter_stage("build-pgbackrest")');
  // WAL is prefetched in parallel instead of one R2 request per segment.
  expect(workerSource).toContain('"archive-async=y"');
  expect(workerSource).toContain('"spool-path=" + str(spool_path)');
  expect(workerSource).toContain('spool_path="/var/spool/pgbackrest"');
  expect(workerSource).toContain(
    "mkdir -p /var/spool/pgbackrest && chown 999:999 /var/spool/pgbackrest",
  );
  expect(workerSource).toContain(
    '"process-max=" + str(PGBACKREST_PROCESS_MAX)',
  );
  expect(workerSource).not.toContain('"process-max=2"');
  // Replay settings apply to the disposable PITR server only.
  expect(workerSource).toContain('if CONFIG["restore_mode"] == "pitr":');
  expect(workerSource).toContain(
    '"-c", "shared_buffers=" + str(POSTGRES_SHARED_BUFFERS_MB) + "MB"',
  );
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
    /ARCHIVE_GET_WRAPPER = r'''([\s\S]*?)'''/,
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
  expect(workerSource).toContain('"PostgreSQL exited before readiness: "');
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

test("PITR watchdog tolerates timeline probes and still detects stalled WAL segments", () => {
  const [, workerSource] = decodedStartupBlocks(
    buildDisposableRestoreStartupScript(pgBackRestConfig()),
  );
  // Execute the actual generated recovery-loop block with a controlled clock
  // and archive state, without running a restore or touching credentials.
  const checked = spawnSync(
    "python3",
    [
      "-c",
      `
import ast
import re
import sys

tree = ast.parse(sys.stdin.read())
watchdog = next(
    node for node in ast.walk(tree)
    if isinstance(node, ast.If) and any(
        isinstance(statement, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "archive_state"
            for target in statement.targets
        ) for statement in node.body
    )
)
code = compile(ast.Module(body=[watchdog], type_ignores=[]), "<watchdog>", "exec")
wal = "00000001000003C700000041"
next_wal = "00000001000003C700000042"

class Clock:
    value = 0
    def time(self):
        return self.value

def run(updates, expected_stall=None):
    clock = Clock()
    archive = {}
    scope = dict(
        CONFIG={"restore_mode": "pitr"}, REPOSITORY_TYPE="pgbackrest",
        time=clock, re=re, next_archive_get_check=0, container="synthetic",
        archive_get_state=lambda _: archive, stalled_wal_segment=None,
        stalled_wal_since=None, WAL_REPLAY_STALL_TIMEOUT_SECONDS=600,
    )
    try:
        for at, segment, status in updates:
            clock.value = at
            archive.update(segment=segment, status=status, attempt="3", exit_code="1")
            exec(code, scope)
    except RuntimeError as error:
        assert expected_stall is not None, str(error)
        assert ("WAL replay stalled on segment " + expected_stall + " for ") in str(error), str(error)
    else:
        assert expected_stall is None, "stalled WAL was not detected"

for history in ["00000001.history", "00000002.history"]:
    run([(0, history, "failed"), (609, history, "failed"), (1200, history, "failed")])
    # A history probe also clears the timer for the preceding WAL request.
    run([(0, wal, "failed"), (500, history, "failed"), (700, wal, "failed"), (1200, wal, "failed")])

run([(0, wal, "failed"), (590, wal, "failed")])
run([(0, wal, "failed"), (609, wal, "failed")], expected_stall=wal)
run([(0, wal, "running"), (609, wal, "running")], expected_stall=wal)
run([(0, wal, "failed"), (500, wal, "succeeded"), (700, wal, "failed"), (1200, wal, "failed")])
run([(0, wal, "failed"), (500, next_wal, "failed"), (700, next_wal, "failed")])
run([(0, wal, "failed"), (500, next_wal, "failed"), (1109, next_wal, "failed")], expected_stall=next_wal)
`,
    ],
    { input: workerSource, encoding: "utf8" },
  );
  expect(checked.stderr).toBe("");
  expect(checked.status).toBe(0);
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
      stage: "postgres-pitr",
      error:
        "WAL replay stalled on segment 00000001.history for 609 seconds; archive-get status=failed attempt=3 exit_code=1",
    }),
  ).toBe(false);
  expect(
    isRetryableDisposablePitrWalFailure({
      ...worker,
      status: "failed",
      stage: "restore-pgbackrest",
      error: "pgBackRest source checksum mismatch",
    }),
  ).toBe(false);
  expect(
    isRetryableDisposablePitrWalFailure({
      ...worker,
      status: "failed",
      stage: "postgres-pitr",
      error: "PITR verification timed out: archive-get exited with status 1",
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

function workerFunctions(workerSource: string, names: string[]): string {
  // The generated module runs the drill at import; extract only definitions.
  const extract = spawnSync(
    "python3",
    [
      "-c",
      `
import ast, sys
names = set(sys.argv[1:])
source = sys.stdin.read()
tree = ast.parse(source)
for node in tree.body:
    if isinstance(node, (ast.FunctionDef, ast.Assign)) and (
        getattr(node, "name", None) in names or any(
            isinstance(t, ast.Name) and t.id in names
            for t in getattr(node, "targets", [])
        )
    ):
        print(ast.get_source_segment(source, node))
`,
      ...names,
    ],
    { input: workerSource, encoding: "utf8" },
  );
  expect(extract.stderr).toBe("");
  return extract.stdout;
}

test("Conat SQLite checks run in-process and report corrupt or missing databases", () => {
  const [, workerSource] = decodedStartupBlocks(
    buildDisposableRestoreStartupScript(pgBackRestConfig()),
  );
  expect(workerSource).not.toContain('["sqlite3", "-readonly", str(path)');
  const functions = workerFunctions(workerSource, [
    "bounded",
    "sqlite_quick_check",
    "QUICK_CHECK_WORKERS",
  ]);
  const checked = spawnSync(
    "python3",
    [
      "-c",
      `
import os, pathlib, sqlite3, sys, tempfile, time
from concurrent.futures import ThreadPoolExecutor
exec(sys.stdin.read())
root = pathlib.Path(tempfile.mkdtemp())
good = root / "with space?#.db"
connection = sqlite3.connect(good)
connection.execute("create table t(x)")
connection.executemany("insert into t values (?)", [(i,) for i in range(1000)])
connection.commit()
connection.close()
corrupt = root / "corrupt.db"
data = bytearray(good.read_bytes())
data[4096:8192] = b"\\xff" * 4096
corrupt.write_bytes(bytes(data))
with ThreadPoolExecutor(max_workers=QUICK_CHECK_WORKERS) as pool:
    results = list(pool.map(sqlite_quick_check, [good, corrupt, root / "missing.db"]))
print(results[0])
print("corrupt-ok" if results[1] == "ok" else "corrupt-detected")
print("missing-ok" if results[2] == "ok" else "missing-detected")
print(QUICK_CHECK_WORKERS >= 2)
# A read-only check never creates or changes files.
print(sorted(path.name for path in root.iterdir()))
`,
    ],
    { input: functions, encoding: "utf8" },
  );
  expect(checked.stderr).toBe("");
  expect(checked.stdout.trim().split("\n")).toEqual([
    "ok",
    "corrupt-detected",
    "missing-detected",
    "True",
    "['corrupt.db', 'with space?#.db']",
  ]);
});

test("the worker result records the time spent in each stage", () => {
  const [, workerSource] = decodedStartupBlocks(
    buildDisposableRestoreStartupScript(pgBackRestConfig()),
  );
  expect(workerSource).toContain('"stage_seconds": stage_seconds()');
  const functions = workerFunctions(workerSource, [
    "STAGE",
    "STAGE_SECONDS",
    "enter_stage",
    "stage_seconds",
  ]);
  const checked = spawnSync(
    "python3",
    [
      "-c",
      `
import json, sys, time
class Clock:
    now = 100.0
    def time(self):
        return self.now
time = Clock()
_STAGE_ENTERED = time.time()
exec(sys.stdin.read())
time.now = 103.0
STAGE = enter_stage("restore-rustic")
time.now = 110.0
STAGE = enter_stage("validate-conat")
time.now = 111.5
print(json.dumps(stage_seconds(), sort_keys=True))
`,
    ],
    { input: functions, encoding: "utf8" },
  );
  expect(checked.stderr).toBe("");
  expect(JSON.parse(checked.stdout.trim().split("\n").at(-1)!)).toEqual({
    bootstrap: 3,
    "restore-rustic": 7,
    "validate-conat": 1.5,
  });
});

test("stage timings from a worker result are bounded and numeric", () => {
  expect(workerStageSeconds(undefined)).toBeNull();
  expect(workerStageSeconds({})).toBeNull();
  expect(
    workerStageSeconds({
      stage_seconds: {
        "validate-conat": 241.26,
        "postgres-pitr": 1534,
        "Bad Stage": 1,
        "restore-pgbackrest": Number.NaN,
        complete: -3,
      } as any,
    }),
  ).toEqual({ "validate-conat": 241.3, "postgres-pitr": 1534, complete: 0 });
});

test("a production restore picks the Conat snapshot at or before its target", () => {
  const [, workerSource] = decodedStartupBlocks(
    buildDisposableRestoreStartupScript(pgBackRestConfig()),
  );
  const functions = workerFunctions(workerSource, [
    "parse_time",
    "choose_sqlite_snapshot",
    "strip_recovery_settings",
  ]);
  const checked = spawnSync(
    "python3",
    [
      "-c",
      `
import datetime, json, re, sys
exec(sys.stdin.read())
groups = [
  {"snapshots": [
    {"id": "a", "time": "2026-10-07T20:00:00.123456789+00:00"},
    {"id": "c", "time": "2026-10-07T23:30:00-07:00"},
  ]},
  {"snapshots": [{"id": "b", "time": "2026-10-08T01:00:00Z"}]},
]
out = {
  "latest": choose_sqlite_snapshot(groups)[0],
  "before": choose_sqlite_snapshot(groups, "2026-10-08 02:00:00+00")[0],
  "exact": choose_sqlite_snapshot(groups, "2026-10-08T01:00:00+00:00")[0],
  "early": choose_sqlite_snapshot(groups, "2026-10-07 21:00:00+00")[0],
}
try:
  choose_sqlite_snapshot(groups, "2026-10-07 19:00:00+00")
except RuntimeError as err:
  out["none"] = str(err)
try:
  parse_time("2026-10-07 19:00:00")
except ValueError as err:
  out["naive"] = "rejected"
conf = """# Do not edit this file manually!
shared_buffers = '4GB'

# Recovery settings generated by pgBackRest restore on 2026-10-08 03:00:00
restore_command = 'pgbackrest --stanza=cocalc-bay-0 archive-get %f "%p"'
recovery_target_time = '2026-10-08 02:00:00+00'
recovery_target_action = 'promote'

# cocalc bay restore
archive_mode = 'off'
archive_command = '/bin/false'
restore_command = '/mnt/x/cocalc-pgbackrest-archive-get %f %p'
"""
out["conf"] = strip_recovery_settings(conf)
print(json.dumps(out))
`,
    ],
    { input: functions, encoding: "utf8" },
  );
  expect(checked.stderr).toBe("");
  const out = JSON.parse(checked.stdout);
  // 23:30 -07:00 is 06:30 UTC on the 8th: the newest overall.
  expect(out.latest).toBe("c");
  expect(out.before).toBe("b");
  expect(out.exact).toBe("b");
  expect(out.early).toBe("a");
  expect(out.none).toContain("no Conat SQLite snapshot exists at or before");
  expect(out.naive).toBe("rejected");
  expect(out.conf).toBe(
    "# Do not edit this file manually!\nshared_buffers = '4GB'\n",
  );
});

test("the production engine runs host binaries as the bay user and never on the live socket", () => {
  const [, workerSource] = decodedStartupBlocks(
    buildDisposableRestoreStartupScript(pgBackRestConfig()),
  );
  // Same pgBackRest settings and archive-get wrapper as the drill.
  expect(workerSource).toContain(
    'write_pgbackrest_config(\n        ROOT / "pgbackrest.conf", pg1_path=ROOT / "postgres", spool_path=ROOT / "spool",',
  );
  expect(workerSource).toContain(
    'handle.write("restore_command = " + sql_quote(str(pgbackrest_archive_get_script) + " %f %p") + "\\n")',
  );
  expect(workerSource).toContain('"setpriv", "--reuid", CONFIG["bay_user"]');
  expect(workerSource).toContain(
    '"-k", LOCAL_RUN_DIR, "-p", str(CONFIG["local_port"])',
  );
  // Production data keeps fsync on; only the disposable drill turns it off.
  const local = workerSource.slice(
    workerSource.indexOf("def start_local_postgres"),
    workerSource.indexOf("def stop_local_postgres"),
  );
  expect(local).not.toContain("fsync=off");
  expect(local).toContain('"-c", "archive_mode=off"');
  // It stops cleanly and hands back an unmodified hba and auto.conf.
  expect(workerSource).toContain(
    'hba.write_text(original_hba, encoding="utf-8")',
  );
  expect(workerSource).toContain("strip_recovery_settings(auto_conf.read_text");
  expect(workerSource).toContain(
    '"Database cluster state:               shut down"',
  );
});
