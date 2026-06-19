import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
          lro: overrides.lro ?? {},
          projects: {},
          system: {},
        },
        pollMs: 100,
        timeoutMs: 60_000,
      };
      Object.assign(ctx.hub.projects, overrides.projects ?? {});
      Object.assign(ctx.hub.system, overrides.system ?? {});
      captured = await fn(ctx);
      return captured;
    },
    resolveProjectFromArgOrContext:
      overrides.resolveProjectFromArgOrContext ??
      (async () => ({ project_id: "project-id" })),
    resolveProjectProjectApi:
      overrides.resolveProjectProjectApi ??
      (async (_ctx: any, project_id: string) => ({
        project: { project_id },
        api: {
          waitUntilReady: async () => undefined,
          system: {
            exec: async () => ({
              type: "blocking",
              stdout: "",
              stderr: "",
              exit_code: 0,
            }),
          },
        },
      })),
    waitForLro: overrides.waitForLro ?? (async () => ({ status: "done" })),
    serializeLroSummary: (summary: any) => summary,
  };
  return {
    deps,
    get captured() {
      return captured;
    },
  };
}

function writeRootfsConfig(value: unknown): {
  path: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-rootfs-config-"));
  const path = join(dir, "rootfs-config.json");
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return {
    path,
    cleanup: () => rmSync(dir, { force: true, recursive: true }),
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

test("rootfs prepull queues all running hosts", async () => {
  let capturedArgs: any;
  const harness = rootfsDeps({
    system: {
      enqueueRootfsPrepull: async (opts: any) => {
        capturedArgs = opts;
        return { considered: 7, enqueued: 7 };
      },
    },
  });
  const program = new Command();
  registerRootfsCommand(program, harness.deps as any);

  await program.parseAsync([
    "node",
    "test",
    "rootfs",
    "prepull",
    "--limit",
    "7",
  ]);

  assert.deepEqual(capturedArgs, { host_id: undefined, limit: 7 });
  assert.deepEqual(harness.captured, { considered: 7, enqueued: 7 });
});

test("rootfs prepull queues one host", async () => {
  let capturedArgs: any;
  const harness = rootfsDeps({
    system: {
      enqueueRootfsPrepull: async (opts: any) => {
        capturedArgs = opts;
        return {
          considered: 1,
          enqueued: 1,
          host_id: "37782b66-190d-41c3-a7e5-f5662e34cd4a",
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
    "prepull",
    "37782b66-190d-41c3-a7e5-f5662e34cd4a",
    "--limit",
    "999",
  ]);

  assert.deepEqual(capturedArgs, {
    host_id: "37782b66-190d-41c3-a7e5-f5662e34cd4a",
    limit: undefined,
  });
  assert.equal(harness.captured.enqueued, 1);
});

test("rootfs save accepts portable config json", async () => {
  let capturedArgs: any;
  const config = writeRootfsConfig({
    kind: "cocalc-rootfs-config",
    version: 1,
    exported_at: "2026-06-17T00:00:00.000Z",
    metadata: {
      label: "Pluto notebooks",
      slug: "pluto-notebooks",
      description: "Julia and Pluto examples",
      family: "julia",
      version: "1.11",
      channel: "stable",
      visibility: "collaborators",
      tags: ["julia", "pluto"],
    },
    theme: {
      title: "Pluto",
      icon: "notebook",
      color: "#ffffff",
      accent_color: "#3366cc",
    },
    content: {
      version: 1,
      title: "Pluto examples",
      actions: [
        {
          kind: "copy-to-home",
          label: "Copy examples",
          source_path: "/opt/pluto/examples",
          target_path: "pluto-examples",
        },
        {
          kind: "project-app",
          label: "Launch Pluto",
          app_spec: {
            id: "pluto",
            kind: "service",
            title: "Pluto",
            command: { command: "julia" },
          },
        },
      ],
    },
  });
  const harness = rootfsDeps({
    system: {
      saveRootfsCatalogEntry: async (opts: any) => {
        capturedArgs = opts;
        return { id: "image-1", image: opts.image, label: opts.label };
      },
    },
  });
  const program = new Command();
  registerRootfsCommand(program, harness.deps as any);

  try {
    await program.parseAsync([
      "node",
      "test",
      "rootfs",
      "save",
      "--image",
      "cocalc.local/rootfs/pluto",
      "--config-file",
      config.path,
    ]);
  } finally {
    config.cleanup();
  }

  assert.deepEqual(capturedArgs, {
    image_id: undefined,
    image: "cocalc.local/rootfs/pluto",
    browser_id: undefined,
    label: "Pluto notebooks",
    slug: "pluto-notebooks",
    description: "Julia and Pluto examples",
    family: "julia",
    version: "1.11",
    channel: "stable",
    supersedes_image_id: undefined,
    visibility: "collaborators",
    tags: ["julia", "pluto"],
    theme: {
      title: "Pluto",
      description: undefined,
      color: "#ffffff",
      accent_color: "#3366cc",
      icon: "notebook",
      image_blob: null,
    },
    content: {
      version: 1,
      title: "Pluto examples",
      subtitle: undefined,
      description: undefined,
      publisher: undefined,
      license: undefined,
      actions: [
        {
          kind: "copy-to-home",
          label: "Copy examples",
          source_path: "/opt/pluto/examples",
          target_path: "pluto-examples",
          description: undefined,
        },
        {
          kind: "project-app",
          label: "Launch Pluto",
          app_spec: {
            id: "pluto",
            kind: "service",
            title: "Pluto",
            command: { command: "julia" },
          },
          description: undefined,
        },
      ],
    },
    content_warnings: [],
    official: undefined,
    prepull: undefined,
    hidden: undefined,
  });
});

test("rootfs publish accepts config json and lets flags override it", async () => {
  let capturedArgs: any;
  const config = writeRootfsConfig({
    kind: "cocalc-rootfs-config",
    version: 1,
    exported_at: "2026-06-17T00:00:00.000Z",
    metadata: {
      label: "Config label",
      slug: "config-label",
      visibility: "private",
      tags: ["from-config"],
    },
    content: {
      version: 1,
      title: "Config content",
      actions: [{ kind: "browse", label: "Browse", path: "/" }],
    },
  });
  const harness = rootfsDeps({
    resolveProjectFromArgOrContext: async () => ({ project_id: "project-1" }),
    system: {
      publishProjectRootfsImage: async (opts: any) => {
        capturedArgs = opts;
        return { op_id: "op-1", scope_type: "project", scope_id: "project-1" };
      },
    },
  });
  const program = new Command();
  registerRootfsCommand(program, harness.deps as any);

  try {
    await program.parseAsync([
      "node",
      "test",
      "rootfs",
      "publish",
      "--project",
      "project-1",
      "--config-file",
      config.path,
      "--label",
      "CLI label",
      "--tags",
      "cli,pluto",
      "--visibility",
      "public",
      "--slug",
      "cli-label",
      "--switch-project",
    ]);
  } finally {
    config.cleanup();
  }

  assert.deepEqual(capturedArgs, {
    project_id: "project-1",
    browser_id: undefined,
    label: "CLI label",
    slug: "cli-label",
    family: undefined,
    version: undefined,
    channel: undefined,
    supersedes_image_id: undefined,
    description: undefined,
    visibility: "public",
    tags: ["cli", "pluto"],
    theme: undefined,
    content: {
      version: 1,
      title: "Config content",
      subtitle: undefined,
      description: undefined,
      publisher: undefined,
      license: undefined,
      actions: [
        {
          kind: "browse",
          label: "Browse",
          path: "/",
          description: undefined,
        },
      ],
    },
    content_warnings: [],
    official: undefined,
    prepull: undefined,
    hidden: undefined,
    switch_project: true,
  });
});

test("rootfs recipe explain resolves local modules", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-rootfs-recipe-"));
  const recipePath = join(dir, "recipe.yaml");
  const moduleDir = join(dir, "modules");
  mkdirSync(join(moduleDir, "cocalc", "apt"), { recursive: true });
  try {
    writeFileSync(
      recipePath,
      [
        "version: 1",
        "name: demo",
        "steps:",
        "  - uses: cocalc/apt",
        "    with:",
        "      packages:",
        "        - curl",
        "publish:",
        "  label: Demo",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(moduleDir, "cocalc", "apt", "recipe.json"),
      JSON.stringify({
        id: "cocalc/apt",
        description: "Install packages",
        inputs: {
          packages: { required: true },
          no_recommends: { default: true },
        },
        run: { script: "install.sh" },
      }),
    );
    writeFileSync(join(moduleDir, "cocalc", "apt", "install.sh"), "true\n");
    const harness = rootfsDeps();
    const program = new Command();
    registerRootfsCommand(program, harness.deps as any);

    await program.parseAsync([
      "node",
      "test",
      "rootfs",
      "recipe",
      "explain",
      recipePath,
      "--module-dir",
      moduleDir,
    ]);

    assert.equal(harness.captured.recipe, "demo");
    assert.equal(harness.captured.steps[0].uses, "cocalc/apt");
    assert.deepEqual(harness.captured.steps[0].inputs, {
      packages: ["curl"],
      no_recommends: true,
    });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("rootfs recipe run creates project, executes modules, and publishes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-rootfs-recipe-run-"));
  const recipePath = join(dir, "recipe.json");
  const moduleDir = join(dir, "modules");
  mkdirSync(join(moduleDir, "cocalc", "demo"), { recursive: true });
  const execCalls: any[] = [];
  let publishArgs: any;
  try {
    writeFileSync(
      recipePath,
      JSON.stringify({
        version: 1,
        name: "demo",
        base: { image: "cocalc/base" },
        steps: [{ uses: "cocalc/demo", with: { value: "ok" } }],
        verify: ["test -x /usr/local/bin/demo"],
        publish: {
          label: "Demo image",
          slug: "demo-image",
          tags: ["demo"],
        },
      }),
    );
    writeFileSync(
      join(moduleDir, "cocalc", "demo", "recipe.json"),
      JSON.stringify({
        id: "cocalc/demo",
        inputs: { value: { required: true } },
        run: { script: "install.sh" },
        verify: { command: "command -v demo" },
        contributes: {
          metadata: { tags: ["module"] },
          content: {
            version: 1,
            title: "Demo content",
            actions: [{ kind: "browse", label: "Browse", path: "/" }],
          },
        },
      }),
    );
    writeFileSync(
      join(moduleDir, "cocalc", "demo", "install.sh"),
      "echo installing $VALUE\n",
    );
    const harness = rootfsDeps({
      projects: {
        createProject: async (opts: any) => {
          assert.equal(opts.rootfs_image, "cocalc/base");
          return "builder-project";
        },
        start: async () => ({ op_id: "start-op" }),
      },
      waitForLro: async () => ({ status: "succeeded" }),
      lro: {
        get: async () => ({ op_id: "publish-op", status: "succeeded" }),
      },
      resolveProjectProjectApi: async (_ctx: any, project_id: string) => ({
        project: { project_id },
        api: {
          waitUntilReady: async () => undefined,
          system: {
            exec: async (opts: any) => {
              execCalls.push(opts);
              return {
                type: "blocking",
                stdout: "ok",
                stderr: "",
                exit_code: 0,
              };
            },
          },
        },
      }),
      system: {
        publishProjectRootfsImage: async (opts: any) => {
          publishArgs = opts;
          return {
            op_id: "publish-op",
            scope_type: "project",
            scope_id: opts.project_id,
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
      "recipe",
      "run",
      recipePath,
      "--module-dir",
      moduleDir,
      "--publish",
      "--wait",
    ]);

    assert.equal(harness.captured.project_id, "builder-project");
    assert.equal(harness.captured.created_project, true);
    assert.equal(execCalls.length, 3);
    assert.equal(execCalls[0].env.VALUE, "ok");
    assert.deepEqual(publishArgs, {
      project_id: "builder-project",
      browser_id: undefined,
      label: "Demo image",
      slug: "demo-image",
      description: undefined,
      family: undefined,
      version: undefined,
      channel: undefined,
      visibility: undefined,
      tags: ["demo", "module"],
      theme: {},
      content: {
        version: 1,
        title: "Demo content",
        actions: [{ kind: "browse", label: "Browse", path: "/" }],
      },
      content_warnings: [],
      switch_project: undefined,
    });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
