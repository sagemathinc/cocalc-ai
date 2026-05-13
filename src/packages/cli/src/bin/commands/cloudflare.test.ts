import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";

import { registerCloudflareCommand } from "./cloudflare";

function deps(overrides: Record<string, any> = {}) {
  return {
    withContext: async (_command: unknown, _label: string, fn: any) => {
      const ctx = {
        globals: { json: true, output: "json" },
        timeoutMs: 30_000,
        rpcTimeoutMs: 30_000,
        pollMs: 0,
        hub: {
          system: {},
          lro: {},
        },
      };
      Object.assign(ctx.hub.system, overrides.system ?? {});
      Object.assign(ctx.hub.lro, overrides.lro ?? {});
      return await fn(ctx);
    },
  };
}

test("cloudflare teardown plan creates read-only plan", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerCloudflareCommand(
    program,
    deps({
      system: {
        createCloudflareTeardownPlan: async (opts: any) => {
          capturedArgs = opts;
          return {
            id: "plan-1",
            status: "planned",
            include_r2: true,
            expires_at: "2026-05-12T00:10:00.000Z",
            confirmation_text: "delete 1 tunnels, 2 dns records, 0 r2 buckets",
            summary: {
              selected: { tunnels: 1, dns_records: 2, r2_buckets: 0 },
              counts: {
                active_projects: 3,
                archived_project_candidates: 4,
                projects_with_backups: 5,
                r2_bucket_records: 6,
                cloudflare_r2_buckets: 7,
              },
              warnings: [],
              notes: [],
            },
          };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "cloudflare",
    "teardown",
    "plan",
    "--include-r2",
  ]);

  assert.deepEqual(capturedArgs, { include_r2: true });
});

test("cloudflare teardown review fetches saved plan", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerCloudflareCommand(
    program,
    deps({
      system: {
        getCloudflareTeardownPlan: async (opts: any) => {
          capturedArgs = opts;
          return {
            id: opts.plan_id,
            status: "planned",
            include_r2: false,
            expires_at: "2026-05-12T00:10:00.000Z",
            confirmation_text: "delete 0 tunnels, 0 dns records, 0 r2 buckets",
            plan_json: { resources: [] },
            summary: {
              selected: { tunnels: 0, dns_records: 0, r2_buckets: 0 },
              counts: {
                active_projects: 0,
                archived_project_candidates: 0,
                projects_with_backups: 0,
                r2_bucket_records: 0,
                cloudflare_r2_buckets: 0,
              },
              warnings: [],
              notes: [],
            },
          };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "cloudflare",
    "teardown",
    "review",
    "plan-1",
  ]);

  assert.deepEqual(capturedArgs, { plan_id: "plan-1" });
});

test("cloudflare teardown apply starts LRO", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerCloudflareCommand(
    program,
    deps({
      system: {
        startCloudflareTeardownApply: async (opts: any) => {
          capturedArgs = opts;
          return {
            op_id: "teardown-apply-1",
            scope_type: "account",
            scope_id: "acct",
            service: "persist",
            stream_name: "lro:teardown-apply-1",
          };
        },
      },
      lro: {
        get: async () => ({
          op_id: "teardown-apply-1",
          status: "succeeded",
          result: {
            plan_id: "plan-1",
            applied_at: "2026-05-13T00:00:00.000Z",
            deleted_dns_records: 2,
            deleted_tunnels: 1,
            skipped_r2_buckets: 0,
            actions: [],
            notes: [],
          },
          progress_summary: {
            phase: "done",
            plan_id: "plan-1",
            deleted_dns_records: 2,
            total_dns_records: 2,
            deleted_tunnels: 1,
            total_tunnels: 1,
            skipped_r2_buckets: 0,
            total_r2_buckets: 0,
          },
        }),
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "cloudflare",
    "teardown",
    "apply",
    "plan-1",
    "--confirm",
    "delete 1 tunnels, 2 dns records, 0 r2 buckets",
  ]);

  assert.deepEqual(capturedArgs, {
    plan_id: "plan-1",
    confirm: "delete 1 tunnels, 2 dns records, 0 r2 buckets",
    delete_r2_contents: false,
  });
});

test("cloudflare r2 usage requests usage summary", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerCloudflareCommand(
    program,
    deps({
      system: {
        getCloudflareR2Usage: async (opts: any) => {
          capturedArgs = opts;
          return {
            checked_at: "2026-05-12T00:00:00.000Z",
            account_id: "acct",
            filtered_by_prefix: false,
            bucket_count: 1,
            cloudflare_bucket_count: 1,
            totals: { object_count: 2, total_bytes: 1024 },
            buckets: [
              {
                bucket: "alpha-wnam",
                object_count: 2,
                total_bytes: 1024,
                metrics_source: "graphql",
                database: { known: true, purpose: "project-backups" },
              },
            ],
            warnings: [],
            notes: [],
          };
        },
      },
    }) as any,
  );

  await program.parseAsync(["node", "test", "cloudflare", "r2", "usage"]);

  assert.deepEqual(capturedArgs, {
    all_buckets: false,
    scan: undefined,
    refresh: false,
    max_age_minutes: undefined,
  });
});

test("cloudflare r2 usage can request all visible buckets", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerCloudflareCommand(
    program,
    deps({
      system: {
        getCloudflareR2Usage: async (opts: any) => {
          capturedArgs = opts;
          return {
            checked_at: "2026-05-12T00:00:00.000Z",
            account_id: "acct",
            bucket_prefix: "lite4b",
            filtered_by_prefix: false,
            bucket_count: 0,
            cloudflare_bucket_count: 20,
            totals: {},
            buckets: [],
            warnings: ["none matched"],
            notes: [],
          };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "cloudflare",
    "r2",
    "usage",
    "--all",
  ]);

  assert.deepEqual(capturedArgs, {
    all_buckets: true,
    scan: undefined,
    refresh: false,
    max_age_minutes: undefined,
  });
});

test("cloudflare r2 usage passes S3 scan controls", async () => {
  let capturedUsageArgs: any;
  let capturedAuditArgs: any;
  const program = new Command();
  registerCloudflareCommand(
    program,
    deps({
      system: {
        getCloudflareR2Usage: async (opts: any) => {
          capturedUsageArgs = opts;
          return {
            checked_at: "2026-05-12T00:00:00.000Z",
            account_id: "acct",
            filtered_by_prefix: true,
            bucket_count: 1,
            cloudflare_bucket_count: 1,
            totals: {},
            buckets: [
              {
                bucket: "lite4b-wnam",
                metrics_source: "unavailable",
                database: { known: true, purpose: "project-backups" },
              },
            ],
            warnings: [],
            notes: [],
          };
        },
        auditCloudflareR2Bucket: async (opts: any) => {
          capturedAuditArgs = opts;
          return {
            account_id: "acct",
            bucket: opts.bucket,
            scanned_at: "2026-05-12T00:01:00.000Z",
            cache: {
              hit: false,
              max_age_minutes: opts.max_age_minutes,
              expires_at: "2026-05-12T01:01:00.000Z",
            },
            object_count: 3,
            total_bytes: 4096,
            categories: [],
            top_prefixes: [],
            top_objects: [],
            database: { known: true, purpose: "project-backups" },
            warnings: [],
            notes: [],
          };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "cloudflare",
    "r2",
    "usage",
    "--scan",
    "--refresh",
    "--max-age-minutes",
    "10",
  ]);

  assert.deepEqual(capturedUsageArgs, {
    all_buckets: false,
    scan: false,
    refresh: false,
    max_age_minutes: 10,
  });
  assert.deepEqual(capturedAuditArgs, {
    bucket: "lite4b-wnam",
    refresh: true,
    max_age_minutes: 10,
  });
});

test("cloudflare r2 audit passes cache controls", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerCloudflareCommand(
    program,
    deps({
      system: {
        auditCloudflareR2Bucket: async (opts: any) => {
          capturedArgs = opts;
          return {
            account_id: "acct",
            bucket: opts.bucket,
            prefix: opts.prefix,
            scanned_at: "2026-05-12T00:00:00.000Z",
            cache: {
              hit: false,
              max_age_minutes: opts.max_age_minutes,
              expires_at: "2026-05-12T01:00:00.000Z",
            },
            object_count: 1,
            total_bytes: 2048,
            categories: [
              {
                category: "project_backup_rustic_repo",
                object_count: 1,
                total_bytes: 2048,
                examples: ["rustic/shared-wnam-0001/config"],
              },
            ],
            top_prefixes: [],
            top_objects: [],
            warnings: [],
            notes: [],
          };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "cloudflare",
    "r2",
    "audit",
    "alpha-wnam",
    "--prefix",
    "rustic/",
    "--max-age-minutes",
    "5",
    "--categories",
  ]);

  assert.deepEqual(capturedArgs, {
    bucket: "alpha-wnam",
    prefix: "rustic/",
    refresh: false,
    max_age_minutes: 5,
  });
});

test("cloudflare r2 audit can show rustic repository kind groups", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerCloudflareCommand(
    program,
    deps({
      system: {
        auditCloudflareR2Bucket: async (opts: any) => {
          capturedArgs = opts;
          return {
            account_id: "acct",
            bucket: opts.bucket,
            scanned_at: "2026-05-12T00:00:00.000Z",
            cache: {
              hit: true,
              max_age_minutes: 60,
              expires_at: "2026-05-12T01:00:00.000Z",
            },
            object_count: 3,
            total_bytes: 6144,
            rustic_repos: [
              {
                repo: "rustic/shared-wnam-0001",
                kind: "project-backup",
                object_count: 1,
                total_bytes: 1024,
                examples: [],
              },
              {
                repo: "rustic/shared-wnam-0002",
                kind: "project-backup",
                object_count: 1,
                total_bytes: 2048,
                examples: [],
              },
              {
                repo: "rustic/bay-backups/bay-1",
                kind: "bay-backup",
                object_count: 1,
                total_bytes: 3072,
                examples: [],
              },
            ],
            categories: [],
            top_prefixes: [],
            top_objects: [],
            warnings: [],
            notes: [],
          };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "cloudflare",
    "r2",
    "audit",
    "alpha-wnam",
    "--rustic-kinds",
  ]);

  assert.deepEqual(capturedArgs, {
    bucket: "alpha-wnam",
    prefix: undefined,
    refresh: false,
    max_age_minutes: undefined,
  });
});

test("cloudflare r2 audit refresh starts LRO", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerCloudflareCommand(
    program,
    deps({
      system: {
        auditCloudflareR2Bucket: async () => {
          throw new Error("direct audit should not be used for refresh");
        },
        startCloudflareR2Audit: async (opts: any) => {
          capturedArgs = opts;
          return {
            op_id: "audit-op-1",
            scope_type: "account",
            scope_id: "acct",
            service: "persist",
            stream_name: "lro:audit-op-1",
          };
        },
      },
      lro: {
        get: async () => ({
          op_id: "audit-op-1",
          status: "succeeded",
          result: {
            account_id: "acct",
            bucket: "alpha-wnam",
            prefix: "rustic/",
            scanned_at: "2026-05-12T00:00:00.000Z",
            cache: {
              hit: false,
              max_age_minutes: 5,
              expires_at: "2026-05-12T01:00:00.000Z",
            },
            object_count: 1,
            total_bytes: 2048,
            categories: [],
            top_prefixes: [],
            top_objects: [],
            warnings: [],
            notes: [],
          },
          progress_summary: {
            phase: "done",
            bucket: "alpha-wnam",
            objects_seen: 1,
            bytes_seen: 2048,
          },
        }),
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "cloudflare",
    "r2",
    "audit",
    "alpha-wnam",
    "--prefix",
    "rustic/",
    "--refresh",
    "--max-age-minutes",
    "5",
  ]);

  assert.deepEqual(capturedArgs, {
    bucket: "alpha-wnam",
    prefix: "rustic/",
    refresh: true,
    max_age_minutes: 5,
  });
});

test("cloudflare r2 bay-backups plan forwards bucket and prefix", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerCloudflareCommand(
    program,
    deps({
      system: {
        getCloudflareR2BayBackupCleanupPlan: async (opts: any) => {
          capturedArgs = opts;
          return {
            bucket: opts.bucket,
            prefix: opts.prefix,
            checked_at: "2026-05-13T00:00:00.000Z",
            object_count: 2,
            total_bytes: 4096,
            wal_object_count: 2,
            wal_total_bytes: 4096,
            manifest_object_count: 0,
            manifest_total_bytes: 0,
            other_object_count: 0,
            other_total_bytes: 0,
            bay_prefixes: [],
            confirmation_text:
              "delete direct bay backups from lite4b-wnam/bay-backups/: 2 objects 4096 bytes",
            warnings: [],
            notes: [],
          };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "cloudflare",
    "r2",
    "bay-backups",
    "plan",
    "lite4b-wnam",
    "--prefix",
    "bay-backups/bay-0/",
  ]);

  assert.deepEqual(capturedArgs, {
    bucket: "lite4b-wnam",
    prefix: "bay-backups/bay-0/",
  });
});

test("cloudflare r2 bay-backups delete starts LRO", async () => {
  let capturedArgs: any;
  const confirm =
    "delete direct bay backups from lite4b-wnam/bay-backups/: 2 objects 4096 bytes";
  const program = new Command();
  registerCloudflareCommand(
    program,
    deps({
      system: {
        startCloudflareR2BayBackupCleanup: async (opts: any) => {
          capturedArgs = opts;
          return {
            op_id: "cleanup-op-1",
            scope_type: "account",
            scope_id: "acct",
            service: "persist",
            stream_name: "lro:cleanup-op-1",
          };
        },
      },
      lro: {
        get: async () => ({
          op_id: "cleanup-op-1",
          status: "succeeded",
          result: {
            bucket: "lite4b-wnam",
            prefix: "bay-backups/",
            checked_at: "2026-05-13T00:00:00.000Z",
            object_count: 2,
            total_bytes: 4096,
            wal_object_count: 2,
            wal_total_bytes: 4096,
            manifest_object_count: 0,
            manifest_total_bytes: 0,
            other_object_count: 0,
            other_total_bytes: 0,
            bay_prefixes: [],
            confirmation_text: confirm,
            warnings: [],
            notes: [],
            deleted_object_count: 2,
            deleted_total_bytes: 4096,
          },
          progress_summary: {
            phase: "done",
            bucket: "lite4b-wnam",
            prefix: "bay-backups/",
            objects_seen: 2,
            objects_deleted: 2,
            bytes_deleted: 4096,
          },
        }),
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "cloudflare",
    "r2",
    "bay-backups",
    "delete",
    "lite4b-wnam",
    "--confirm",
    confirm,
  ]);

  assert.deepEqual(capturedArgs, {
    bucket: "lite4b-wnam",
    prefix: "bay-backups/",
    confirm,
  });
});
