import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Command } from "commander";

import { registerRootfsCommand } from "./rootfs";
import { listRootfsRecipes } from "./rootfs-recipe";

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
            readRootfsBuildLog: async (opts: any) => ({
              build_id: opts.build_id,
              project_id,
              lines: opts.lines ?? 0,
              byte_offset: opts.byte_offset ?? 0,
              next_byte_offset: opts.byte_offset ?? 0,
              bytes: 0,
              eof: true,
              text: "",
              found: true,
              path: ".cocalc/rootfs-builds/build-1/build.log",
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
      "--arch",
      "amd64",
      "--size-gb",
      "5.858",
      "--gpu",
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
    arch: "amd64",
    gpu: true,
    size_gb: 5.858,
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
    arch: undefined,
    gpu: undefined,
    size_gb: undefined,
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

test("rootfs publish uses saved project RootFS publish config", async () => {
  let capturedArgs: any;
  const harness = rootfsDeps({
    resolveProjectFromArgOrContext: async () => ({ project_id: "project-1" }),
    projects: {
      getProjectRootfsPublishConfig: async (opts: any) => {
        assert.deepEqual(opts, { project_id: "project-1" });
        return {
          kind: "cocalc-project-rootfs-publish-config",
          version: 1,
          updated_at: "2026-06-19T00:00:00.000Z",
          config: {
            kind: "cocalc-rootfs-config",
            version: 1,
            exported_at: "2026-06-19T00:00:00.000Z",
            metadata: {
              label: "Saved label",
              slug: "saved-label",
              tags: ["saved"],
            },
            content: {
              version: 1,
              title: "Saved content",
              actions: [{ kind: "browse", label: "Browse", path: "/" }],
            },
          },
        };
      },
    },
    system: {
      publishProjectRootfsImage: async (opts: any) => {
        capturedArgs = opts;
        return { op_id: "op-1", scope_type: "project", scope_id: "project-1" };
      },
    },
  });
  const program = new Command();
  registerRootfsCommand(program, harness.deps as any);

  await program.parseAsync([
    "node",
    "test",
    "rootfs",
    "publish",
    "--project",
    "project-1",
  ]);

  assert.deepEqual(capturedArgs, {
    project_id: "project-1",
    browser_id: undefined,
    label: "Saved label",
    slug: "saved-label",
    family: undefined,
    version: undefined,
    channel: undefined,
    supersedes_image_id: undefined,
    description: undefined,
    visibility: undefined,
    tags: ["saved"],
    theme: undefined,
    arch: undefined,
    gpu: undefined,
    size_gb: undefined,
    content: {
      version: 1,
      title: "Saved content",
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
    switch_project: undefined,
  });
});

test("rootfs publish lets flags override saved project RootFS publish config", async () => {
  let capturedArgs: any;
  const harness = rootfsDeps({
    resolveProjectFromArgOrContext: async () => ({ project_id: "project-1" }),
    projects: {
      getProjectRootfsPublishConfig: async () => ({
        kind: "cocalc-project-rootfs-publish-config",
        version: 1,
        updated_at: "2026-06-19T00:00:00.000Z",
        config: {
          kind: "cocalc-rootfs-config",
          version: 1,
          exported_at: "2026-06-19T00:00:00.000Z",
          metadata: {
            label: "Saved label",
            slug: "saved-label",
            visibility: "private",
            tags: ["saved"],
          },
        },
      }),
    },
    system: {
      publishProjectRootfsImage: async (opts: any) => {
        capturedArgs = opts;
        return { op_id: "op-1", scope_type: "project", scope_id: "project-1" };
      },
    },
  });
  const program = new Command();
  registerRootfsCommand(program, harness.deps as any);

  await program.parseAsync([
    "node",
    "test",
    "rootfs",
    "publish",
    "--project",
    "project-1",
    "--slug",
    "cli-label",
    "--visibility",
    "public",
  ]);

  assert.equal(capturedArgs.label, "Saved label");
  assert.equal(capturedArgs.slug, "cli-label");
  assert.equal(capturedArgs.visibility, "public");
  assert.deepEqual(capturedArgs.tags, ["saved"]);
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

test("rootfs recipe ls lists bundled examples and modules", () => {
  const result = listRootfsRecipes(join(process.cwd(), "../rootfs-recipes"));
  assert.ok(result.examples.some((recipe) => recipe.name === "cocalc-base"));
  assert.ok(result.examples.some((recipe) => recipe.name === "code-server"));
  assert.ok(result.examples.some((recipe) => recipe.name === "ml-pytorch-gpu"));
  assert.ok(
    result.modules.some((module) => module.id === "cocalc/code-server"),
  );
  assert.ok(
    result.modules.some((module) => module.id === "cocalc/jupyter-python"),
  );
  assert.ok(result.modules.some((module) => module.id === "cocalc/apt"));
});

test("rootfs recipe list is an alias for ls", async () => {
  const seen: string[] = [];
  const originalLog = console.log;
  console.log = (message?: any) => {
    seen.push(String(message ?? ""));
  };
  try {
    const program = new Command();
    registerRootfsCommand(program, rootfsDeps().deps as any);

    await program.parseAsync(["node", "test", "rootfs", "recipe", "list"]);
  } finally {
    console.log = originalLog;
  }
  assert.ok(seen.join("\n").includes("Module directory:"));
  assert.ok(seen.join("\n").includes("Recipes:"));
  assert.ok(seen.join("\n").includes("Modules:"));
});

test("rootfs recipe explain parses bundled cocalc base recipe", async () => {
  const harness = rootfsDeps();
  const program = new Command();
  registerRootfsCommand(program, harness.deps as any);

  await program.parseAsync([
    "node",
    "test",
    "rootfs",
    "recipe",
    "explain",
    join(process.cwd(), "../rootfs-recipes/examples/cocalc-base.yaml"),
  ]);

  assert.equal(harness.captured.recipe, "cocalc-base");
  assert.equal(harness.captured.steps[0].uses, "cocalc/apt");
  assert.equal(harness.captured.steps[1].kind, "run");
  assert.equal(harness.captured.steps[2].uses, "cocalc/jupyter-python");
  assert.equal(harness.captured.publish.slug, "cocalc-minimal-base");
});

test("rootfs recipe explain resolves bundled recipe examples by name", async () => {
  const harness = rootfsDeps();
  const program = new Command();
  registerRootfsCommand(program, harness.deps as any);

  await program.parseAsync([
    "node",
    "test",
    "rootfs",
    "recipe",
    "explain",
    "cocalc-base",
  ]);

  assert.equal(harness.captured.recipe, "cocalc-base");
  assert.equal(harness.captured.steps[2].uses, "cocalc/jupyter-python");
  assert.equal(harness.captured.publish.slug, "cocalc-minimal-base");
});

test("rootfs recipe explain parses bundled code-server recipe", async () => {
  const harness = rootfsDeps();
  const program = new Command();
  registerRootfsCommand(program, harness.deps as any);

  await program.parseAsync([
    "node",
    "test",
    "rootfs",
    "recipe",
    "explain",
    "code-server",
  ]);

  assert.equal(harness.captured.recipe, "code-server");
  assert.equal(harness.captured.steps[0].uses, "cocalc/apt");
  assert.equal(harness.captured.steps[1].uses, "cocalc/code-server");
  assert.equal(harness.captured.steps[1].inputs.prefix, "/opt/code-server");
  assert.equal(harness.captured.publish.slug, "code-server");
  assert.equal(
    harness.captured.steps[1].contributes.content.actions[1].app_spec.id,
    "code-server",
  );
});

test("rootfs recipe explain treats bundled modules as one-step recipes", async () => {
  for (const recipe of [
    "cocalc/jupyter-python",
    "jupyter-python",
    join(process.cwd(), "../rootfs-recipes/cocalc/jupyter-python"),
    join(process.cwd(), "../rootfs-recipes/cocalc/jupyter-python/recipe.json"),
  ]) {
    const harness = rootfsDeps();
    const program = new Command();
    registerRootfsCommand(program, harness.deps as any);

    await program.parseAsync([
      "node",
      "test",
      "rootfs",
      "recipe",
      "explain",
      recipe,
    ]);

    assert.equal(harness.captured.recipe, "cocalc/jupyter-python");
    assert.equal(harness.captured.steps.length, 1);
    assert.equal(harness.captured.steps[0].uses, "cocalc/jupyter-python");
    assert.equal(
      harness.captured.steps[0].inputs.prefix,
      "/opt/cocalc-jupyter",
    );
  }
});

test("rootfs recipe explain includes direct module timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-rootfs-module-timeout-"));
  const moduleDir = join(dir, "modules");
  const modulePath = join(moduleDir, "cocalc", "demo");
  try {
    mkdirSync(modulePath, { recursive: true });
    writeFileSync(
      join(modulePath, "recipe.json"),
      JSON.stringify({
        id: "cocalc/demo",
        version: 1,
        timeout: 42,
        run: { script: "install.sh" },
      }),
    );
    writeFileSync(join(modulePath, "install.sh"), "true\n");
    const harness = rootfsDeps();
    const program = new Command();
    registerRootfsCommand(program, harness.deps as any);

    await program.parseAsync([
      "node",
      "test",
      "rootfs",
      "recipe",
      "explain",
      "cocalc/demo",
      "--module-dir",
      moduleDir,
    ]);

    assert.equal(harness.captured.steps[0].timeout, 42);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("rootfs recipe run executes bundled module scripts from the embedded registry", async () => {
  const execCalls: any[] = [];
  const harness = rootfsDeps({
    globals: { json: true, quiet: true },
    projects: {
      start: async () => ({ op_id: "start-op" }),
    },
    waitForLro: async () => ({ status: "succeeded" }),
    resolveProjectFromArgOrContext: async (_ctx: any, project: string) => ({
      project_id: project,
    }),
    resolveProjectProjectApi: async (_ctx: any, project_id: string) => ({
      project: { project_id },
      api: {
        waitUntilReady: async () => undefined,
        system: {
          exec: async (opts: any) => {
            execCalls.push(opts);
            return {
              type: "blocking",
              stdout: "",
              stderr: "",
              exit_code: 0,
            };
          },
        },
      },
    }),
  });
  const program = new Command();
  registerRootfsCommand(program, harness.deps as any);

  await program.parseAsync([
    "node",
    "test",
    "rootfs",
    "recipe",
    "run",
    "cocalc/content-actions",
    "--project",
    "existing-project",
  ]);

  assert.equal(harness.captured.project_id, "existing-project");
  assert.equal(harness.captured.created_project, false);
  assert.equal(execCalls.length, 2);
  assert.match(execCalls[0].command, /RootFS content action/);
  assert.match(execCalls[1].command, /cocalc-content-actions/);
});

test("rootfs recipe run --dry-run prints expanded runnable shell script", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-rootfs-dry-run-"));
  const recipePath = join(dir, "recipe.yaml");
  const moduleDir = join(dir, "modules");
  const modulePath = join(moduleDir, "cocalc", "demo");
  const oldWrite = process.stdout.write;
  let stdout = "";
  try {
    mkdirSync(modulePath, { recursive: true });
    writeFileSync(
      recipePath,
      [
        "version: 1",
        "name: demo",
        "steps:",
        "  - uses: cocalc/demo",
        "    with:",
        "      value: override",
        "    timeout: 42",
        "verify:",
        "  - test -f /tmp/cocalc-demo",
        "publish:",
        "  label: Demo",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(modulePath, "recipe.json"),
      JSON.stringify({
        id: "cocalc/demo",
        version: 1,
        description: "Demo module",
        inputs: {
          value: { default: "default" },
        },
        run: { script: "install.sh" },
        verify: { script: "verify.sh" },
        contributes: {
          metadata: { tags: ["demo"] },
        },
      }),
    );
    writeFileSync(
      join(modulePath, "install.sh"),
      'echo "install $VALUE" > /tmp/cocalc-demo\n',
    );
    writeFileSync(
      join(modulePath, "verify.sh"),
      'grep -q "install override" /tmp/cocalc-demo\n',
    );
    process.stdout.write = ((chunk: any) => {
      stdout += String(chunk);
      return true;
    }) as any;

    const harness = rootfsDeps({
      projects: {
        createProject: async () => {
          throw new Error("dry-run must not create a project");
        },
      },
      resolveProjectProjectApi: async () => {
        throw new Error("dry-run must not execute in a project");
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
      "--dry-run",
    ]);

    assert.match(stdout, /^#!\/usr\/bin\/env bash/);
    assert.match(stdout, /# Step 1: cocalc\/demo/);
    assert.match(stdout, /# Timeout from recipe metadata: 42s/);
    assert.match(stdout, /VALUE='override'/);
    assert.match(stdout, /export .*VALUE/);
    assert.match(stdout, /echo "install \$VALUE" > \/tmp\/cocalc-demo/);
    assert.match(stdout, /# Step 1 verify: cocalc\/demo/);
    assert.match(stdout, /grep -q "install override" \/tmp\/cocalc-demo/);
    assert.match(stdout, /# Top-level verify 1/);
    assert.match(stdout, /test -f \/tmp\/cocalc-demo/);
    assert.match(stdout, /"label": "Demo"/);
    assert.match(stdout, /"tags": \[\n      "demo"\n    \]/);
  } finally {
    process.stdout.write = oldWrite;
    rmSync(dir, { force: true, recursive: true });
  }
});

test("rootfs recipe explain parses bundled machine learning GPU recipes", async () => {
  for (const [recipe, module, slug] of [
    ["ml-pytorch-gpu.yaml", "cocalc/pytorch-gpu", "pytorch-gpu-ml"],
    ["ml-tensorflow-gpu.yaml", "cocalc/tensorflow-gpu", "tensorflow-gpu-ml"],
  ]) {
    const harness = rootfsDeps();
    const program = new Command();
    registerRootfsCommand(program, harness.deps as any);

    await program.parseAsync([
      "node",
      "test",
      "rootfs",
      "recipe",
      "explain",
      join(process.cwd(), "../rootfs-recipes/examples", recipe),
    ]);

    assert.equal(harness.captured.steps[0].uses, "cocalc/apt");
    assert.equal(harness.captured.steps[1].kind, "run");
    assert.equal(harness.captured.steps[2].uses, "cocalc/jupyter-python");
    assert.equal(
      harness.captured.steps[2].inputs.python,
      "/opt/cocalc-python/bin/python3.12",
    );
    assert.equal(harness.captured.steps[3].uses, module);
    assert.equal(harness.captured.publish.slug, slug);
    assert.ok(harness.captured.publish.tags.includes("nvidia-gpu"));
  }
});

test("rootfs build runs recipe and saves publish config on the project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-rootfs-build-"));
  const recipePath = join(dir, "recipe.json");
  let savedConfig: any;
  let buildRequest: any;
  try {
    writeFileSync(
      recipePath,
      JSON.stringify({
        version: 1,
        name: "build-demo",
        steps: [{ name: "install", run: "true" }],
        publish: {
          label: "Build demo",
          slug: "build-demo",
          tags: ["demo"],
        },
      }),
    );
    const harness = rootfsDeps({
      globals: { quiet: true },
      projects: {
        createProject: async (opts: any) => {
          assert.equal(opts.title, "RootFS build: build-demo");
          return "builder-project";
        },
        start: async () => ({ op_id: "start-op" }),
        setProjectRootfsPublishConfig: async (opts: any) => {
          savedConfig = opts;
        },
        startProjectRootfsBuild: async (opts: any) => {
          buildRequest = opts;
          return {
            build_id: "build-1",
            project_id: opts.project_id,
            host_id: "host-1",
            status: "running",
            created_at: "2026-06-22T00:00:00.000Z",
            paths: {
              dir: ".cocalc/rootfs-builds/build-1",
              script: ".cocalc/rootfs-builds/build-1/run.sh",
              log: ".cocalc/rootfs-builds/build-1/build.log",
              status: ".cocalc/rootfs-builds/build-1/status.json",
              events: ".cocalc/rootfs-builds/build-1/events.ndjson",
            },
          };
        },
        getProjectRootfsBuildLog: async () => ({
          build_id: "build-1",
          project_id: "builder-project",
          host_id: "host-1",
          lines: 0,
          byte_offset: 0,
          next_byte_offset: 0,
          bytes: 0,
          eof: true,
          text: "",
          found: true,
          path: ".cocalc/rootfs-builds/build-1/build.log",
        }),
        getProjectRootfsBuildStatus: async () => ({
          build_id: "build-1",
          project_id: "builder-project",
          host_id: "host-1",
          status: "succeeded",
          created_at: "2026-06-22T00:00:00.000Z",
          paths: {
            dir: ".cocalc/rootfs-builds/build-1",
            script: ".cocalc/rootfs-builds/build-1/run.sh",
            log: ".cocalc/rootfs-builds/build-1/build.log",
            status: ".cocalc/rootfs-builds/build-1/status.json",
            events: ".cocalc/rootfs-builds/build-1/events.ndjson",
          },
        }),
      },
      waitForLro: async () => ({ status: "succeeded" }),
    });
    const program = new Command();
    registerRootfsCommand(program, harness.deps as any);

    await program.parseAsync(["node", "test", "rootfs", "build", recipePath]);

    assert.equal(savedConfig.project_id, "builder-project");
    assert.equal(
      savedConfig.config.kind,
      "cocalc-project-rootfs-publish-config",
    );
    assert.equal(savedConfig.config.recipe.name, "build-demo");
    assert.equal(savedConfig.config.config.metadata.label, "Build demo");
    assert.equal(buildRequest.project_id, "builder-project");
    assert.equal(buildRequest.recipe_ref, "build-demo");
    assert.match(
      buildRequest.script,
      /Generated by: cocalc rootfs recipe run --dry-run/,
    );
    assert.match(buildRequest.script, /Step 1: install/);
    assert.match(
      harness.captured,
      /next: cocalc rootfs publish --project=builder-project/,
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("rootfs build status logs and cancel use project build APIs", async () => {
  const calls: any[] = [];
  const harness = rootfsDeps({
    globals: { quiet: true },
    resolveProjectFromArgOrContext: async (_ctx: any, project: string) => {
      calls.push(["resolve", project]);
      return { project_id: "builder-project" };
    },
    resolveProjectProjectApi: async (_ctx: any, project: string) => {
      calls.push(["project-api", project]);
      return {
        project: { project_id: "builder-project" },
        api: {
          system: {
            readRootfsBuildLog: async (opts: any) => {
              calls.push(["direct-log", opts]);
              return {
                build_id: opts.build_id,
                project_id: "builder-project",
                host_id: "host-1",
                lines: opts.lines,
                byte_offset: 0,
                next_byte_offset: 4,
                bytes: 4,
                eof: true,
                text: "done",
                found: true,
                path: ".cocalc/rootfs-builds/build-1/build.log",
              };
            },
          },
        },
      };
    },
    projects: {
      getProjectRootfsBuildStatus: async (opts: any) => {
        calls.push(["status", opts]);
        return {
          build_id: opts.build_id,
          project_id: opts.project_id,
          host_id: "host-1",
          status: "succeeded",
          created_at: "2026-06-22T00:00:00.000Z",
          paths: {
            log: ".cocalc/rootfs-builds/build-1/build.log",
            script: ".cocalc/rootfs-builds/build-1/run.sh",
          },
        };
      },
      getProjectRootfsBuildLog: async () => {
        throw new Error("hub log API should not be used");
      },
      cancelProjectRootfsBuild: async (opts: any) => {
        calls.push(["cancel", opts]);
        return {
          build_id: opts.build_id,
          project_id: opts.project_id,
          status: "canceling",
          signaled: true,
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
    "build-status",
    "build-1",
    "--project",
    "Builder",
  ]);
  assert.match(harness.captured, /status: succeeded/);

  await program.parseAsync([
    "node",
    "test",
    "rootfs",
    "build-logs",
    "build-1",
    "--project",
    "Builder",
    "--tail",
    "25",
  ]);

  await program.parseAsync([
    "node",
    "test",
    "rootfs",
    "build-cancel",
    "build-1",
    "--project",
    "Builder",
  ]);

  assert.deepEqual(calls, [
    ["resolve", "Builder"],
    ["status", { project_id: "builder-project", build_id: "build-1" }],
    ["resolve", "Builder"],
    ["project-api", "builder-project"],
    [
      "direct-log",
      {
        build_id: "build-1",
        lines: 25,
        byte_offset: undefined,
        max_bytes: undefined,
      },
    ],
    ["resolve", "Builder"],
    ["cancel", { project_id: "builder-project", build_id: "build-1" }],
  ]);
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
          family: "demo",
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
          metadata: { family: "module", tags: ["module"] },
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
      globals: { json: true, quiet: true },
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
    assert.equal(execCalls[0].async_call, true);
    assert.equal(execCalls[0].timeout, 900);
    assert.deepEqual(publishArgs, {
      project_id: "builder-project",
      browser_id: undefined,
      label: "Demo image",
      slug: "demo-image",
      description: undefined,
      family: "demo",
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

test("rootfs recipe run --here executes locally and writes config metadata", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-rootfs-recipe-here-"));
  const recipePath = join(dir, "recipe.json");
  const oldProjectId = process.env.COCALC_PROJECT_ID;
  const oldHome = process.env.HOME;
  const oldCwd = process.cwd();
  try {
    writeFileSync(
      recipePath,
      JSON.stringify({
        version: 1,
        name: "local-demo",
        steps: [
          {
            name: "local install",
            run: 'test "$COCALC_PROJECT_ID" = here-project && echo local > marker.txt',
          },
        ],
        verify: ["test -f marker.txt"],
        publish: {
          label: "Local demo",
          slug: "local-demo",
          tags: ["local"],
        },
      }),
    );
    process.env.COCALC_PROJECT_ID = "here-project";
    process.env.HOME = dir;
    process.chdir(dir);

    const harness = rootfsDeps({
      globals: { quiet: true },
      projects: {
        createProject: async () => {
          throw new Error("should not create a builder project for --here");
        },
      },
      resolveProjectProjectApi: async () => {
        throw new Error("should not use project-host exec for --here");
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
      "--here",
    ]);

    assert.equal(existsSync(join(dir, "marker.txt")), true);
    assert.match(harness.captured, /project_id: here-project/);
    assert.match(harness.captured, /created_project: false/);
    assert.match(
      harness.captured,
      /config_path: .*local-demo.*\.rootfs-config\.json/,
    );
    const match = `${harness.captured}`.match(/^config_path: (.*)$/m);
    assert.ok(match?.[1]);
    const config = JSON.parse(readFileSync(match[1], "utf8"));
    assert.equal(config.metadata.label, "Local demo");
  } finally {
    process.chdir(oldCwd);
    if (oldProjectId == null) {
      delete process.env.COCALC_PROJECT_ID;
    } else {
      process.env.COCALC_PROJECT_ID = oldProjectId;
    }
    if (oldHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = oldHome;
    }
    rmSync(dir, { force: true, recursive: true });
  }
});

test("rootfs recipe run --here honors direct module timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-rootfs-recipe-here-timeout-"));
  const moduleDir = join(dir, "modules");
  const modulePath = join(moduleDir, "cocalc", "demo");
  const oldProjectId = process.env.COCALC_PROJECT_ID;
  try {
    mkdirSync(modulePath, { recursive: true });
    writeFileSync(
      join(modulePath, "recipe.json"),
      JSON.stringify({
        id: "cocalc/demo",
        version: 1,
        timeout: 1,
        run: { shell: "bash", script: "install.sh" },
      }),
    );
    writeFileSync(join(modulePath, "install.sh"), "sleep 2\n");
    process.env.COCALC_PROJECT_ID = "here-project";

    const harness = rootfsDeps({ globals: { quiet: true } });
    const program = new Command();
    registerRootfsCommand(program, harness.deps as any);

    await assert.rejects(
      program.parseAsync([
        "node",
        "test",
        "rootfs",
        "recipe",
        "run",
        "cocalc/demo",
        "--module-dir",
        moduleDir,
        "--here",
      ]),
      /timed out after 1s/,
    );
  } finally {
    if (oldProjectId == null) {
      delete process.env.COCALC_PROJECT_ID;
    } else {
      process.env.COCALC_PROJECT_ID = oldProjectId;
    }
    rmSync(dir, { force: true, recursive: true });
  }
});

test("rootfs recipe run hints about --here inside a project shell", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-rootfs-recipe-hint-"));
  const recipePath = join(dir, "recipe.json");
  const oldProjectId = process.env.COCALC_PROJECT_ID;
  const oldWrite = process.stderr.write;
  let stderr = "";
  try {
    writeFileSync(
      recipePath,
      JSON.stringify({
        version: 1,
        name: "hint-demo",
        steps: [{ name: "install", run: "true" }],
        publish: { label: "Hint demo" },
      }),
    );
    process.env.COCALC_PROJECT_ID = "current-project";
    process.stderr.write = ((chunk: any, ...args: any[]) => {
      stderr += `${chunk}`;
      return oldWrite.call(process.stderr, chunk, ...args);
    }) as typeof process.stderr.write;
    const harness = rootfsDeps({
      projects: {
        createProject: async () => "builder-project",
        start: async () => ({ op_id: "start-op" }),
      },
      waitForLro: async () => ({ status: "succeeded" }),
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
    ]);

    assert.match(
      stderr,
      /Use --here to run this recipe in the current project/,
    );
    assert.match(harness.captured, /created_project: true/);
  } finally {
    process.stderr.write = oldWrite;
    if (oldProjectId == null) {
      delete process.env.COCALC_PROJECT_ID;
    } else {
      process.env.COCALC_PROJECT_ID = oldProjectId;
    }
    rmSync(dir, { force: true, recursive: true });
  }
});

test("rootfs recipe run human summary omits command logs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-rootfs-recipe-human-"));
  const recipePath = join(dir, "recipe.json");
  try {
    writeFileSync(
      recipePath,
      JSON.stringify({
        version: 1,
        name: "human-demo",
        steps: [{ name: "install noisy package", run: "echo huge log" }],
        verify: ["echo verify log"],
        publish: {
          label: "Human demo image",
          tags: ["demo"],
        },
      }),
    );
    const harness = rootfsDeps({
      globals: { quiet: true },
      projects: {
        createProject: async () => "builder-project",
        start: async () => ({ op_id: "start-op" }),
      },
      waitForLro: async () => ({ status: "succeeded" }),
      resolveProjectProjectApi: async (_ctx: any, project_id: string) => ({
        project: { project_id },
        api: {
          waitUntilReady: async () => undefined,
          system: {
            exec: async () => ({
              type: "blocking",
              stdout: "this is the full command log",
              stderr: "",
              exit_code: 0,
            }),
          },
        },
      }),
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
    ]);

    assert.match(harness.captured, /recipe: human-demo/);
    assert.match(harness.captured, /project_id: builder-project/);
    assert.match(harness.captured, /steps:\n  - install noisy package: ok/);
    assert.match(harness.captured, /verify:\n  - verify 1: ok/);
    assert.match(harness.captured, /label: Human demo image/);
    assert.match(harness.captured, /tags: demo/);
    assert.doesNotMatch(harness.captured, /this is the full command log/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("rootfs recipe run polls async command output and honors step timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-rootfs-recipe-async-"));
  const recipePath = join(dir, "recipe.json");
  const execCalls: any[] = [];
  let polls = 0;
  try {
    writeFileSync(
      recipePath,
      JSON.stringify({
        version: 1,
        name: "async-demo",
        steps: [{ name: "slow install", run: "echo installing" }],
      }),
    );
    const harness = rootfsDeps({
      globals: { json: true, quiet: true },
      projects: {
        createProject: async () => "builder-project",
        start: async () => ({ op_id: "start-op" }),
      },
      waitForLro: async () => ({ status: "succeeded" }),
      resolveProjectProjectApi: async (_ctx: any, project_id: string) => ({
        project: { project_id },
        api: {
          waitUntilReady: async () => undefined,
          system: {
            exec: async (opts: any) => {
              execCalls.push(opts);
              if (opts.async_call) {
                return {
                  type: "async",
                  job_id: "job-1",
                  status: "running",
                  stdout: "started\n",
                  stderr: "",
                  exit_code: 0,
                  start: Date.now(),
                };
              }
              assert.equal(opts.async_get, "job-1");
              polls += 1;
              return {
                type: "async",
                job_id: "job-1",
                status: polls === 1 ? "running" : "completed",
                stdout:
                  polls === 1
                    ? "started\nworking\n"
                    : "started\nworking\ndone\n",
                stderr: "",
                exit_code: 0,
                start: Date.now(),
              };
            },
          },
        },
      }),
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
      "--step-timeout",
      "123",
    ]);

    assert.equal(harness.captured.steps.length, 1);
    assert.equal(harness.captured.steps[0].stdout, "started\nworking\ndone\n");
    assert.equal(execCalls[0].async_call, true);
    assert.equal(execCalls[0].timeout, 123);
    assert.ok(execCalls.some((call) => call.async_get === "job-1"));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("rootfs recipe run reconnects while polling async command output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-rootfs-recipe-reconnect-"));
  const recipePath = join(dir, "recipe.json");
  const execCalls: any[] = [];
  let resolveCalls = 0;
  let refreshWaits = 0;
  try {
    writeFileSync(
      recipePath,
      JSON.stringify({
        version: 1,
        name: "reconnect-demo",
        steps: [{ name: "slow install", run: "echo installing" }],
      }),
    );
    const harness = rootfsDeps({
      globals: { json: true, quiet: true },
      projects: {
        createProject: async () => "builder-project",
        start: async () => ({ op_id: "start-op" }),
      },
      waitForLro: async () => ({ status: "succeeded" }),
      resolveProjectProjectApi: async (_ctx: any, project_id: string) => {
        resolveCalls += 1;
        const firstConnection = resolveCalls === 1;
        return {
          project: { project_id },
          api: {
            waitUntilReady: async () => {
              if (!firstConnection) refreshWaits += 1;
            },
            system: {
              exec: async (opts: any) => {
                execCalls.push({ connection: resolveCalls, opts });
                if (opts.async_call) {
                  return {
                    type: "async",
                    job_id: "job-1",
                    status: "running",
                    stdout: "started\n",
                    stderr: "",
                    exit_code: 0,
                    start: Date.now(),
                  };
                }
                assert.equal(opts.async_get, "job-1");
                if (firstConnection) {
                  throw new Error("socket has been disconnected");
                }
                return {
                  type: "async",
                  job_id: "job-1",
                  status: "completed",
                  stdout: "started\nreconnected\ndone\n",
                  stderr: "",
                  exit_code: 0,
                  start: Date.now(),
                };
              },
            },
          },
        };
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
    ]);

    assert.equal(harness.captured.steps[0].exit_code, 0);
    assert.equal(
      harness.captured.steps[0].stdout,
      "started\nreconnected\ndone\n",
    );
    assert.equal(resolveCalls, 2);
    assert.equal(refreshWaits, 1);
    assert.ok(
      execCalls.some(
        (call) => call.connection === 2 && call.opts.async_get === "job-1",
      ),
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
