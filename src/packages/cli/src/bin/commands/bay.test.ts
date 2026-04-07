import assert from "node:assert/strict";
import test from "node:test";

import { Command } from "commander";

import { registerBayCommand } from "./bay";

test("bay list returns the hub bay rows", async () => {
  let captured: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            listBays: async () => [
              {
                bay_id: "bay-0",
                label: "bay-0",
                region: null,
                deployment_mode: "single-bay",
                role: "combined",
                is_default: true,
              },
            ],
          },
        },
      };
      captured = await fn(ctx);
    },
  } as any);

  await program.parseAsync(["node", "test", "bay", "list"]);

  assert.equal(captured?.[0]?.bay_id, "bay-0");
});

test("bay show filters one bay from the hub list", async () => {
  let captured: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            listBays: async () => [
              {
                bay_id: "bay-0",
                label: "bay-0",
                region: null,
                deployment_mode: "single-bay",
                role: "combined",
                is_default: true,
              },
            ],
          },
        },
      };
      captured = await fn(ctx);
    },
  } as any);

  await program.parseAsync(["node", "test", "bay", "show", "bay-0"]);

  assert.equal(captured?.bay_id, "bay-0");
});

test("bay load calls the hub bay-load snapshot API", async () => {
  let captured: any;
  let callOpts: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            getBayLoad: async (opts: any) => {
              callOpts = opts;
              return {
                bay_id: "bay-0",
                label: "bay-0",
                region: null,
                deployment_mode: "single-bay",
                role: "combined",
                is_default: true,
                checked_at: "2026-04-07T07:00:00.000Z",
                browser_control: {
                  active_accounts: 2,
                  active_browsers: 3,
                  active_connections: 5,
                },
                hosts: { total_hosts: 4 },
                parallel_ops: {
                  worker_count: 2,
                  queued_total: 1,
                  running_total: 3,
                  stale_running_total: 0,
                  hotspots: [],
                },
                projections: {
                  account_project_index: {
                    unpublished_events: 0,
                    oldest_unpublished_event_age_ms: null,
                    maintenance_running: false,
                    last_success_at: "2026-04-07T07:00:00.000Z",
                  },
                  account_collaborator_index: {
                    unpublished_events: 0,
                    oldest_unpublished_event_age_ms: null,
                    maintenance_running: false,
                    last_success_at: "2026-04-07T07:00:00.000Z",
                  },
                  account_notification_index: {
                    unpublished_events: 0,
                    oldest_unpublished_event_age_ms: null,
                    maintenance_running: false,
                    last_success_at: "2026-04-07T07:00:00.000Z",
                  },
                },
              };
            },
          },
        },
      };
      captured = await fn(ctx);
    },
  } as any);

  await program.parseAsync(["node", "test", "bay", "load", "bay-0"]);

  assert.deepEqual(callOpts, { bay_id: "bay-0" });
  assert.equal(captured?.bay_id, "bay-0");
});

test("bay backups calls the hub bay-backups snapshot API", async () => {
  let captured: any;
  let callOpts: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            getBayBackups: async (opts: any) => {
              callOpts = opts;
              return {
                bay_id: "bay-0",
                label: "bay-0",
                region: null,
                deployment_mode: "single-bay",
                role: "combined",
                is_default: true,
                checked_at: "2026-04-07T07:00:00.000Z",
                r2: {
                  configured: true,
                  account_id_configured: true,
                  access_key_configured: true,
                  secret_key_configured: true,
                  bucket_prefix: "lite4-dev",
                  total_buckets: 1,
                  active_buckets: 1,
                  buckets: [],
                },
                repos: {
                  total_repos: 1,
                  active_repos: 1,
                  assigned_projects: 3,
                  repos: [],
                },
                projects: {
                  total_projects: 4,
                  host_assigned_projects: 4,
                  provisioned_projects: 3,
                  running_projects: 1,
                  repo_assigned_projects: 3,
                  repo_unassigned_projects: 1,
                  provisioned_up_to_date: 2,
                  provisioned_needs_backup: 1,
                  never_backed_up: 1,
                  latest_last_backup_at: "2026-04-07T07:00:00.000Z",
                },
                restore_readiness: {
                  latest_backup_set_id: "backup-1",
                  latest_backup_format: "pg_basebackup",
                  latest_backup_restore_test_status: "not-run",
                  latest_backup_restore_tested: false,
                  latest_backup_restore_tested_at: null,
                  latest_backup_pitr_test_status: "not-run",
                  latest_backup_pitr_tested: false,
                  latest_backup_pitr_tested_at: null,
                  gold_star: false,
                  last_restore_test_backup_set_id: null,
                  last_restore_test_status: null,
                  last_restore_tested_at: null,
                  last_restore_test_target_dir: null,
                  last_restore_test_recovery_ready: null,
                  last_pitr_test_backup_set_id: null,
                  last_pitr_test_status: null,
                  last_pitr_tested_at: null,
                  last_pitr_test_target_time: null,
                  last_pitr_test_target_dir: null,
                  last_pitr_test_remote_only: null,
                  summary: "Latest backup backup-1 has not been PITR-tested.",
                },
                backup_admission: null,
                backup_execution: null,
              };
            },
          },
        },
      };
      captured = await fn(ctx);
    },
  } as any);

  await program.parseAsync(["node", "test", "bay", "backups", "bay-0"]);

  assert.deepEqual(callOpts, { bay_id: "bay-0" });
  assert.equal(captured?.bay_id, "bay-0");
});

test("bay backup calls the hub run-bay-backup API", async () => {
  let captured: any;
  let callOpts: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            runBayBackup: async (opts: any) => {
              callOpts = opts;
              return {
                bay_id: "bay-0",
                label: "bay-0",
                region: null,
                deployment_mode: "single-bay",
                role: "combined",
                is_default: true,
                started_at: "2026-04-07T08:00:00.000Z",
                finished_at: "2026-04-07T08:01:00.000Z",
                backup_set_id: "backup-1",
                format: "pg_basebackup",
                bucket_name: "lite4-dev-wnam",
                object_prefix: null,
                remote_snapshot_id: "snap-1",
                remote_snapshot_host: "bay-0",
                rustic_repo_selector: "r2:bay-backups:wnam",
                local_manifest_path: "/tmp/manifest.json",
                storage_backend: "rustic",
                artifact_count: 2,
                artifact_bytes: 12345,
                artifacts: [],
                postgres: {
                  host: "/tmp/pg",
                  port: 5432,
                  user: "smc",
                  database: "smc",
                  current_user: "smc",
                  role_superuser: true,
                  role_replication: true,
                  data_directory: "/tmp/data",
                  config_file: "/tmp/data/postgresql.conf",
                  archive_mode: "off",
                  archive_command: null,
                  archive_timeout: null,
                  wal_level: "replica",
                  max_wal_senders: 10,
                  can_basebackup: true,
                  preferred_strategy: "pg_basebackup",
                },
                bay_backup: {
                  enabled: true,
                  backup_root: "/tmp/backups",
                  state_file: "/tmp/backups/state.json",
                  archives_dir: "/tmp/backups/archives",
                  manifests_dir: "/tmp/backups/manifests",
                  staging_dir: "/tmp/backups/staging",
                  wal_archive_dir: "/tmp/backups/wal/archive",
                  r2_configured: true,
                  current_storage_backend: "rustic",
                  bucket_name: "lite4-dev-wnam",
                  bucket_region: "wnam",
                  bucket_endpoint: "https://example.invalid",
                  object_prefix_root: "bay-backups/bay-0",
                  wal_object_prefix: "bay-backups/bay-0/wal",
                  rustic_repo_selector: "r2:bay-backups:wnam",
                  latest_backup_set_id: "backup-1",
                  latest_format: "pg_basebackup",
                  latest_storage_backend: "rustic",
                  latest_local_manifest_path: "/tmp/manifest.json",
                  latest_remote_manifest_key: null,
                  latest_object_prefix: null,
                  latest_remote_snapshot_id: "snap-1",
                  latest_remote_snapshot_host: "bay-0",
                  latest_artifact_count: 2,
                  latest_artifact_bytes: 12345,
                  last_archived_wal_segment: null,
                  last_uploaded_wal_segment: null,
                  archived_wal_count: 0,
                  pending_wal_count: 0,
                  last_started_at: "2026-04-07T08:00:00.000Z",
                  last_finished_at: "2026-04-07T08:01:00.000Z",
                  last_successful_backup_at: "2026-04-07T08:01:00.000Z",
                  last_successful_remote_backup_at: "2026-04-07T08:01:00.000Z",
                  last_successful_wal_archive_at: null,
                  last_error_at: null,
                  last_error: null,
                  restore_state: "ready",
                },
              };
            },
          },
        },
      };
      captured = await fn(ctx);
    },
  } as any);

  await program.parseAsync(["node", "test", "bay", "backup", "bay-0"]);

  assert.deepEqual(callOpts, { bay_id: "bay-0" });
  assert.equal(captured?.backup_set_id, "backup-1");
});

test("bay restore forwards bay id, backup set, target dir, and write mode", async () => {
  let captured: any;
  let callOpts: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            runBayRestore: async (opts: any) => {
              callOpts = opts;
              return {
                bay_id: "bay-0",
                label: "bay-0",
                region: null,
                deployment_mode: "single-bay",
                role: "combined",
                is_default: true,
                started_at: "2026-04-07T08:00:00.000Z",
                finished_at: "2026-04-07T08:02:00.000Z",
                dry_run: false,
                remote_only: false,
                target_time: null,
                backup_set_id: "backup-1",
                format: "pg_basebackup",
                target_dir: "/tmp/restore-target",
                data_dir: "/tmp/restore-target/data",
                sync_dir: "/tmp/restore-target/sync",
                secrets_dir: "/tmp/restore-target/secrets",
                backup_manifest_path: "/tmp/backup-manifest.json",
                restore_manifest_path:
                  "/tmp/restore-target/restore-manifest.json",
                source_storage_backend: "local",
                source_snapshot_id: null,
                rustic_repo_selector: null,
                wal_archive_dir: "/tmp/wal-archive",
                wal_storage_backend: "local",
                artifact_count: 3,
                wal_segment_count: 4,
                recovery_ready: true,
                notes: [],
              };
            },
          },
        },
      };
      captured = await fn(ctx);
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "bay",
    "restore",
    "bay-0",
    "--backup-set-id",
    "backup-1",
    "--target-dir",
    "/tmp/restore-target",
    "--write",
  ]);

  assert.deepEqual(callOpts, {
    bay_id: "bay-0",
    backup_set_id: "backup-1",
    target_dir: "/tmp/restore-target",
    target_time: undefined,
    dry_run: false,
    remote_only: false,
  });
  assert.equal(captured?.backup_set_id, "backup-1");
});

test("bay restore forwards target-time", async () => {
  let callOpts: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            runBayRestore: async (opts: any) => {
              callOpts = opts;
              return {
                bay_id: "bay-0",
                label: "bay-0",
                region: null,
                deployment_mode: "single-bay",
                role: "combined",
                is_default: true,
                started_at: "2026-04-07T08:00:00.000Z",
                finished_at: "2026-04-07T08:02:00.000Z",
                dry_run: true,
                remote_only: false,
                target_time: "2026-04-07T15:00:00.000Z",
                backup_set_id: "backup-1",
                format: "pg_basebackup",
                target_dir: "/tmp/restore-target",
                data_dir: "/tmp/restore-target/data",
                sync_dir: "/tmp/restore-target/sync",
                secrets_dir: "/tmp/restore-target/secrets",
                backup_manifest_path: "/tmp/backup-manifest.json",
                restore_manifest_path:
                  "/tmp/restore-target/restore-manifest.json",
                source_storage_backend: "local",
                source_snapshot_id: null,
                rustic_repo_selector: null,
                wal_archive_dir: "/tmp/wal-archive",
                wal_storage_backend: "local",
                artifact_count: 3,
                wal_segment_count: 4,
                recovery_ready: true,
                notes: [],
              };
            },
          },
        },
      };
      await fn(ctx);
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "bay",
    "restore",
    "--target-time",
    "2026-04-07T08:00:00-07:00",
  ]);

  assert.deepEqual(callOpts, {
    bay_id: undefined,
    backup_set_id: undefined,
    target_dir: undefined,
    target_time: "2026-04-07T08:00:00-07:00",
    dry_run: true,
    remote_only: false,
  });
});

test("bay restore-test forwards bay id, backup set, target dir, and keep mode", async () => {
  let captured: any;
  let callOpts: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            runBayRestoreTest: async (opts: any) => {
              callOpts = opts;
              return {
                bay_id: "bay-0",
                label: "bay-0",
                region: null,
                deployment_mode: "single-bay",
                role: "combined",
                is_default: true,
                started_at: "2026-04-07T08:00:00.000Z",
                finished_at: "2026-04-07T08:02:00.000Z",
                remote_only: false,
                target_time: "2026-04-07T08:01:00.000Z",
                backup_set_id: "backup-1",
                target_dir: "/tmp/restore-test-target",
                data_dir: "/tmp/restore-test-target/data",
                sync_dir: "/tmp/restore-test-target/sync",
                secrets_dir: "/tmp/restore-test-target/secrets",
                backup_manifest_path: "/tmp/backup-manifest.json",
                restore_manifest_path:
                  "/tmp/restore-test-target/restore-manifest.json",
                source_storage_backend: "local",
                source_snapshot_id: null,
                rustic_repo_selector: null,
                wal_archive_dir: "/tmp/wal-archive",
                wal_storage_backend: "local",
                wal_segment_count: 4,
                recovery_ready: true,
                pitr_verified: true,
                pitr_run_id: "run-1",
                kept_on_disk: true,
                verified_queries: ["current_database=smc", "pitr_pre_count=1"],
                notes: [],
              };
            },
          },
        },
      };
      captured = await fn(ctx);
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "bay",
    "restore-test",
    "bay-0",
    "--backup-set-id",
    "backup-1",
    "--target-dir",
    "/tmp/restore-test-target",
    "--keep",
  ]);

  assert.deepEqual(callOpts, {
    bay_id: "bay-0",
    backup_set_id: "backup-1",
    target_dir: "/tmp/restore-test-target",
    keep: true,
    remote_only: false,
  });
  assert.equal(captured?.backup_set_id, "backup-1");
});

test("bay restore-test forwards remote-only mode", async () => {
  let callOpts: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            runBayRestoreTest: async (opts: any) => {
              callOpts = opts;
              return {
                bay_id: "bay-0",
                label: "bay-0",
                region: null,
                deployment_mode: "single-bay",
                role: "combined",
                is_default: true,
                started_at: "2026-04-07T08:00:00.000Z",
                finished_at: "2026-04-07T08:02:00.000Z",
                remote_only: true,
                target_time: "2026-04-07T08:01:00.000Z",
                backup_set_id: "backup-1",
                target_dir: "/tmp/restore-test-target",
                data_dir: "/tmp/restore-test-target/data",
                sync_dir: "/tmp/restore-test-target/sync",
                secrets_dir: "/tmp/restore-test-target/secrets",
                backup_manifest_path: "/tmp/backup-manifest.json",
                restore_manifest_path:
                  "/tmp/restore-test-target/restore-manifest.json",
                source_storage_backend: "rustic",
                source_snapshot_id: "snap-1",
                rustic_repo_selector: "r2:bay-backups:wnam",
                wal_archive_dir: "/tmp/restore-test-target/wal-archive",
                wal_storage_backend: "r2",
                wal_segment_count: 4,
                recovery_ready: true,
                pitr_verified: true,
                pitr_run_id: "run-2",
                kept_on_disk: false,
                verified_queries: ["current_database=smc", "pitr_pre_count=1"],
                notes: [],
              };
            },
          },
        },
      };
      await fn(ctx);
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "bay",
    "restore-test",
    "--remote-only",
  ]);

  assert.deepEqual(callOpts, {
    bay_id: undefined,
    backup_set_id: undefined,
    target_dir: undefined,
    keep: false,
    remote_only: true,
  });
});

test("bay backfill defaults to a dry run", async () => {
  let captured: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            backfillBayOwnership: async (opts: any) => {
              captured = opts;
              return {
                bay_id: "bay-0",
                dry_run: true,
                limit_per_table: null,
                accounts_missing: 12,
                projects_missing: 34,
                hosts_missing: 5,
                accounts_updated: 0,
                projects_updated: 0,
                hosts_updated: 0,
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
  } as any);

  await program.parseAsync(["node", "test", "bay", "backfill"]);

  assert.deepEqual(captured, {
    bay_id: undefined,
    dry_run: true,
    limit_per_table: undefined,
  });
});

test("bay backfill forwards write mode and limit", async () => {
  let captured: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            backfillBayOwnership: async (opts: any) => {
              captured = opts;
              return {
                bay_id: "bay-7",
                dry_run: false,
                limit_per_table: 25,
                accounts_missing: 0,
                projects_missing: 0,
                hosts_missing: 0,
                accounts_updated: 3,
                projects_updated: 4,
                hosts_updated: 1,
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "bay",
    "backfill",
    "--write",
    "--bay-id",
    "bay-7",
    "--limit-per-table",
    "25",
  ]);

  assert.deepEqual(captured, {
    bay_id: "bay-7",
    dry_run: false,
    limit_per_table: 25,
  });
});

test("bay projection rebuild-account-project-index defaults to a dry run", async () => {
  let captured: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            rebuildAccountProjectIndex: async (opts: any) => {
              captured = opts;
              return {
                bay_id: "bay-0",
                target_account_id: "11111111-1111-4111-8111-111111111111",
                dry_run: true,
                existing_rows: 2,
                source_rows: 2,
                visible_rows: 1,
                hidden_rows: 1,
                deleted_rows: 0,
                inserted_rows: 0,
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "bay",
    "projection",
    "rebuild-account-project-index",
    "11111111-1111-4111-8111-111111111111",
  ]);

  assert.deepEqual(captured, {
    target_account_id: "11111111-1111-4111-8111-111111111111",
    dry_run: true,
  });
});

test("bay projection rebuild-account-project-index forwards write mode", async () => {
  let captured: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            rebuildAccountProjectIndex: async (opts: any) => {
              captured = opts;
              return {
                bay_id: "bay-0",
                target_account_id: "11111111-1111-4111-8111-111111111111",
                dry_run: false,
                existing_rows: 1,
                source_rows: 3,
                visible_rows: 2,
                hidden_rows: 1,
                deleted_rows: 1,
                inserted_rows: 3,
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "bay",
    "projection",
    "rebuild-account-project-index",
    "11111111-1111-4111-8111-111111111111",
    "--write",
  ]);

  assert.deepEqual(captured, {
    target_account_id: "11111111-1111-4111-8111-111111111111",
    dry_run: false,
  });
});

test("bay projection status-account-project-index calls the hub status api", async () => {
  let captured: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            getAccountProjectIndexProjectionStatus: async (opts: any) => {
              captured = opts;
              return {
                bay_id: "bay-0",
                backlog: {
                  bay_id: "bay-0",
                  checked_at: "2026-04-04T05:00:00.000Z",
                  unpublished_events: 3,
                  unpublished_event_types: {
                    "project.created": 1,
                    "project.membership_changed": 2,
                  },
                  oldest_unpublished_event_at: "2026-04-04T04:59:30.000Z",
                  newest_unpublished_event_at: "2026-04-04T04:59:59.000Z",
                  oldest_unpublished_event_age_ms: 30_000,
                  newest_unpublished_event_age_ms: 1_000,
                },
                maintenance: {
                  enabled: true,
                  observed_bay_id: "bay-0",
                  interval_ms: 5000,
                  batch_limit: 100,
                  max_batches_per_tick: 5,
                  running: false,
                  started_at: "2026-04-04T04:00:00.000Z",
                  last_tick_started_at: "2026-04-04T05:00:00.000Z",
                  last_tick_finished_at: "2026-04-04T05:00:00.010Z",
                  last_tick_duration_ms: 10,
                  last_success_at: "2026-04-04T05:00:00.010Z",
                  last_error_at: null,
                  last_error: null,
                  consecutive_failures: 0,
                  last_result: {
                    bay_id: "bay-0",
                    batches: 1,
                    scanned_events: 3,
                    applied_events: 3,
                    inserted_rows: 4,
                    deleted_rows: 0,
                    event_types: {
                      "project.created": 1,
                      "project.membership_changed": 2,
                    },
                  },
                },
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "bay",
    "projection",
    "status-account-project-index",
  ]);

  assert.deepEqual(captured, {});
});

test("bay projection status-account-collaborator-index calls the hub status api", async () => {
  let captured: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            getAccountCollaboratorIndexProjectionStatus: async (opts: any) => {
              captured = opts;
              return {
                bay_id: "bay-0",
                backlog: {
                  bay_id: "bay-0",
                  checked_at: "2026-04-04T05:00:00.000Z",
                  unpublished_events: 2,
                  unpublished_event_types: {
                    "project.created": 1,
                    "project.membership_changed": 1,
                  },
                  oldest_unpublished_event_at: "2026-04-04T04:59:30.000Z",
                  newest_unpublished_event_at: "2026-04-04T04:59:59.000Z",
                  oldest_unpublished_event_age_ms: 30_000,
                  newest_unpublished_event_age_ms: 1_000,
                },
                maintenance: {
                  enabled: true,
                  observed_bay_id: "bay-0",
                  interval_ms: 5000,
                  batch_limit: 100,
                  max_batches_per_tick: 5,
                  running: false,
                  started_at: "2026-04-04T04:00:00.000Z",
                  last_tick_started_at: "2026-04-04T05:00:00.000Z",
                  last_tick_finished_at: "2026-04-04T05:00:00.010Z",
                  last_tick_duration_ms: 10,
                  last_success_at: "2026-04-04T05:00:00.010Z",
                  last_error_at: null,
                  last_error: null,
                  consecutive_failures: 0,
                  last_result: {
                    bay_id: "bay-0",
                    batches: 1,
                    scanned_events: 2,
                    applied_events: 2,
                    inserted_rows: 4,
                    deleted_rows: 1,
                    event_types: {
                      "project.created": 1,
                      "project.membership_changed": 1,
                    },
                  },
                },
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "bay",
    "projection",
    "status-account-collaborator-index",
  ]);

  assert.deepEqual(captured, {});
});

test("bay projection drain-account-project-index defaults to a dry run", async () => {
  let captured: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            drainAccountProjectIndexProjection: async (opts: any) => {
              captured = opts;
              return {
                bay_id: "bay-0",
                dry_run: true,
                requested_limit: 100,
                scanned_events: 2,
                applied_events: 2,
                inserted_rows: 3,
                deleted_rows: 1,
                event_types: {
                  "project.created": 1,
                  "project.deleted": 1,
                },
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "bay",
    "projection",
    "drain-account-project-index",
  ]);

  assert.deepEqual(captured, {
    bay_id: undefined,
    limit: undefined,
    dry_run: true,
  });
});

test("bay projection drain-account-project-index forwards write mode, bay, and limit", async () => {
  let captured: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            drainAccountProjectIndexProjection: async (opts: any) => {
              captured = opts;
              return {
                bay_id: "bay-7",
                dry_run: false,
                requested_limit: 25,
                scanned_events: 5,
                applied_events: 5,
                inserted_rows: 7,
                deleted_rows: 2,
                event_types: {
                  "project.created": 1,
                  "project.membership_changed": 4,
                },
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "bay",
    "projection",
    "drain-account-project-index",
    "--write",
    "--bay-id",
    "bay-7",
    "--limit",
    "25",
  ]);

  assert.deepEqual(captured, {
    bay_id: "bay-7",
    limit: 25,
    dry_run: false,
  });
});

test("bay projection rebuild-account-collaborator-index defaults to a dry run", async () => {
  let captured: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            rebuildAccountCollaboratorIndex: async (opts: any) => {
              captured = opts;
              return {
                bay_id: "bay-0",
                target_account_id: "11111111-1111-4111-8111-111111111111",
                dry_run: true,
                existing_rows: 3,
                source_project_rows: 2,
                source_collaborator_rows: 3,
                deleted_rows: 0,
                inserted_rows: 0,
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "bay",
    "projection",
    "rebuild-account-collaborator-index",
    "11111111-1111-4111-8111-111111111111",
  ]);

  assert.deepEqual(captured, {
    target_account_id: "11111111-1111-4111-8111-111111111111",
    dry_run: true,
  });
});

test("bay projection rebuild-account-collaborator-index forwards write mode", async () => {
  let captured: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            rebuildAccountCollaboratorIndex: async (opts: any) => {
              captured = opts;
              return {
                bay_id: "bay-0",
                target_account_id: "11111111-1111-4111-8111-111111111111",
                dry_run: false,
                existing_rows: 2,
                source_project_rows: 4,
                source_collaborator_rows: 5,
                deleted_rows: 2,
                inserted_rows: 5,
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "bay",
    "projection",
    "rebuild-account-collaborator-index",
    "11111111-1111-4111-8111-111111111111",
    "--write",
  ]);

  assert.deepEqual(captured, {
    target_account_id: "11111111-1111-4111-8111-111111111111",
    dry_run: false,
  });
});

test("bay projection drain-account-collaborator-index defaults to a dry run", async () => {
  let captured: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            drainAccountCollaboratorIndexProjection: async (opts: any) => {
              captured = opts;
              return {
                bay_id: "bay-0",
                dry_run: true,
                requested_limit: 100,
                scanned_events: 2,
                applied_events: 2,
                inserted_rows: 5,
                deleted_rows: 3,
                event_types: {
                  "project.created": 1,
                  "project.membership_changed": 1,
                },
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "bay",
    "projection",
    "drain-account-collaborator-index",
  ]);

  assert.deepEqual(captured, {
    bay_id: undefined,
    limit: undefined,
    dry_run: true,
  });
});

test("bay projection drain-account-collaborator-index forwards write mode, bay, and limit", async () => {
  let captured: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            drainAccountCollaboratorIndexProjection: async (opts: any) => {
              captured = opts;
              return {
                bay_id: "bay-7",
                dry_run: false,
                requested_limit: 25,
                scanned_events: 5,
                applied_events: 5,
                inserted_rows: 11,
                deleted_rows: 7,
                event_types: {
                  "project.created": 1,
                  "project.membership_changed": 4,
                },
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "bay",
    "projection",
    "drain-account-collaborator-index",
    "--write",
    "--bay-id",
    "bay-7",
    "--limit",
    "25",
  ]);

  assert.deepEqual(captured, {
    bay_id: "bay-7",
    limit: 25,
    dry_run: false,
  });
});

test("bay projection status-account-notification-index calls the hub status api", async () => {
  let captured: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            getAccountNotificationIndexProjectionStatus: async (opts: any) => {
              captured = opts;
              return {
                bay_id: "bay-0",
                backlog: {
                  bay_id: "bay-0",
                  checked_at: "2026-04-04T05:00:00.000Z",
                  unpublished_events: 2,
                  unpublished_event_types: {
                    "notification.mention_upserted": 2,
                  },
                  oldest_unpublished_event_at: "2026-04-04T04:55:00.000Z",
                  newest_unpublished_event_at: "2026-04-04T04:59:00.000Z",
                  oldest_unpublished_event_age_ms: 300000,
                  newest_unpublished_event_age_ms: 60000,
                },
                maintenance: {
                  enabled: true,
                  observed_bay_id: "bay-0",
                  interval_ms: 5000,
                  batch_limit: 100,
                  max_batches_per_tick: 5,
                  running: false,
                  started_at: null,
                  last_tick_started_at: null,
                  last_tick_finished_at: null,
                  last_tick_duration_ms: null,
                  last_success_at: null,
                  last_error_at: null,
                  last_error: null,
                  consecutive_failures: 0,
                  last_result: null,
                },
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "bay",
    "projection",
    "status-account-notification-index",
  ]);

  assert.deepEqual(captured, {});
});

test("bay projection rebuild-account-notification-index defaults to a dry run", async () => {
  let captured: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            rebuildAccountNotificationIndex: async (opts: any) => {
              captured = opts;
              return {
                bay_id: "bay-0",
                target_account_id: "11111111-1111-4111-8111-111111111111",
                dry_run: true,
                existing_rows: 1,
                source_rows: 3,
                unread_rows: 2,
                saved_rows: 1,
                deleted_rows: 0,
                inserted_rows: 0,
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "bay",
    "projection",
    "rebuild-account-notification-index",
    "11111111-1111-4111-8111-111111111111",
  ]);

  assert.deepEqual(captured, {
    target_account_id: "11111111-1111-4111-8111-111111111111",
    dry_run: true,
  });
});

test("bay projection drain-account-notification-index forwards write mode, bay, and limit", async () => {
  let captured: any;
  const program = new Command();
  registerBayCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          system: {
            drainAccountNotificationIndexProjection: async (opts: any) => {
              captured = opts;
              return {
                bay_id: "bay-7",
                dry_run: false,
                requested_limit: 25,
                scanned_events: 5,
                applied_events: 5,
                inserted_rows: 5,
                deleted_rows: 0,
                event_types: {
                  "notification.mention_upserted": 5,
                },
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "bay",
    "projection",
    "drain-account-notification-index",
    "--write",
    "--bay-id",
    "bay-7",
    "--limit",
    "25",
  ]);

  assert.deepEqual(captured, {
    bay_id: "bay-7",
    limit: 25,
    dry_run: false,
  });
});
