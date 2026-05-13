import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";

import { registerCloudflareCommand } from "./cloudflare";

function deps(overrides: Record<string, any> = {}) {
  return {
    withContext: async (_command: unknown, _label: string, fn: any) => {
      const ctx = {
        hub: {
          system: {},
        },
      };
      Object.assign(ctx.hub.system, overrides.system ?? {});
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

test("cloudflare r2 usage requests usage summary", async () => {
  let called = false;
  const program = new Command();
  registerCloudflareCommand(
    program,
    deps({
      system: {
        getCloudflareR2Usage: async () => {
          called = true;
          return {
            checked_at: "2026-05-12T00:00:00.000Z",
            account_id: "acct",
            bucket_count: 1,
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

  assert.equal(called, true);
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
    "--refresh",
    "--max-age-minutes",
    "5",
    "--categories",
  ]);

  assert.deepEqual(capturedArgs, {
    bucket: "alpha-wnam",
    prefix: "rustic/",
    refresh: true,
    max_age_minutes: 5,
  });
});
