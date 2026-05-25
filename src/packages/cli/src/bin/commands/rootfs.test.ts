import assert from "node:assert/strict";
import test from "node:test";

import { Command } from "commander";

import { registerRootfsCommand } from "./rootfs";

function rootfsDeps(overrides: Record<string, any> = {}) {
  let captured: any;
  const deps = {
    withContext: async (_command: unknown, _label: string, fn: any) => {
      const ctx = {
        globals: overrides.globals ?? {},
        hub: {
          system: {},
        },
      };
      Object.assign(ctx.hub.system, overrides.system ?? {});
      captured = await fn(ctx);
      return captured;
    },
    resolveProjectFromArgOrContext: async () => "project-id",
    waitForLro: async () => ({ status: "done" }),
    serializeLroSummary: (summary: any) => summary,
  };
  return {
    deps,
    get captured() {
      return captured;
    },
  };
}

test("rootfs shards forwards filters and formats shard inventory", async () => {
  let capturedArgs: any;
  const harness = rootfsDeps({
    system: {
      getRootfsRusticReposAdmin: async (opts: any) => {
        capturedArgs = opts;
        return {
          active_shards_per_region: 4,
          releases_per_shard: 1000,
          legacy: {
            artifact_count: 1,
            artifact_bytes: 2048,
          },
          repos: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              region: "wnam",
              bucket_id: "22222222-2222-4222-8222-222222222222",
              bucket_name: "cocalc-backups-wnam",
              root: "rustic/rootfs-images/wnam/shard-0001",
              status: "active",
              assigned_artifact_count: 7,
              artifact_bytes: 1048576,
              cap: 1000,
              available_slots: 993,
              updated: "2026-05-25T00:00:00.000Z",
            },
          ],
        };
      },
    },
  });
  const program = new Command();
  registerRootfsCommand(program, harness.deps as any);

  await program.parseAsync([
    "node",
    "test",
    "rootfs",
    "shards",
    "--region",
    "wnam",
    "--status",
    "active",
  ]);

  assert.deepEqual(capturedArgs, {
    region: "wnam",
    status: "active",
  });
  assert.match(harness.captured, /active_shards_per_region: 4/);
  assert.match(harness.captured, /legacy_single_repo: 1 DB artifacts, 2.0 KB/);
  assert.match(harness.captured, /region wnam:/);
  assert.match(harness.captured, /active 7\/1000/);
  assert.match(harness.captured, /status: active accepts new artifacts/);
});

test("rootfs shards can enrich inventory from R2 audit", async () => {
  let auditArgs: any;
  const harness = rootfsDeps({
    system: {
      getRootfsRusticReposAdmin: async () => ({
        active_shards_per_region: 4,
        releases_per_shard: 1000,
        legacy: {
          artifact_count: 0,
          artifact_bytes: 0,
        },
        repos: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            region: "wnam",
            bucket_name: "cocalc-backups-wnam",
            root: "rustic/rootfs-images/wnam/shard-0001",
            status: "active",
            assigned_artifact_count: 1,
            artifact_bytes: 2048,
            cap: 1000,
            available_slots: 999,
          },
        ],
      }),
      auditCloudflareR2Bucket: async (opts: any) => {
        auditArgs = opts;
        return {
          rustic_repos: [
            {
              repo: "rustic/rootfs-images/wnam/shard-0001",
              kind: "rootfs",
              object_count: 3,
              total_bytes: 4096,
            },
            {
              repo: "rustic/rootfs-images/wnam/orphan-shard",
              kind: "rootfs",
              object_count: 2,
              total_bytes: 1024,
            },
            {
              repo: "rustic/rootfs-images",
              kind: "rootfs",
              object_count: 1,
              total_bytes: 512,
            },
          ],
        };
      },
    },
  });
  const program = new Command();
  registerRootfsCommand(program, harness.deps as any);

  await program.parseAsync([
    "node",
    "test",
    "rootfs",
    "shards",
    "--r2-audit",
    "--refresh",
  ]);

  assert.deepEqual(auditArgs, {
    bucket: "cocalc-backups-wnam",
    prefix: "rustic/rootfs-images",
    refresh: true,
    max_age_minutes: 60,
  });
  assert.match(harness.captured, /R2 3 objects, 4.0 KB/);
  assert.match(harness.captured, /orphan_r2_rootfs_repos:/);
  assert.match(harness.captured, /legacy_single_repo: 0 DB artifacts/);
});
