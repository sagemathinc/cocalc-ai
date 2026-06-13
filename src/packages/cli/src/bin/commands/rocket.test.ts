import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Command } from "commander";

import { registerRocketCommand, type RocketCommandDeps } from "./rocket";

type CapturedRun = {
  command: string;
  args: string[];
};

function createProgram({
  runs,
  gitStatus = "",
  onRun,
}: {
  runs: CapturedRun[];
  gitStatus?: string;
  onRun?: (command: string, args: string[]) => void | Promise<void>;
}): Command {
  const program = new Command();
  program.exitOverride();
  registerRocketCommand(program, {
    cwd: join(__dirname, "../../../../../.."),
    env: {},
    commandExists: (command) => command === "bash" || command === "pnpm",
    gitStatus: () => gitStatus,
    runCommand: async (command, args) => {
      runs.push({ command, args });
      await onRun?.(command, args);
      return 0;
    },
  } satisfies RocketCommandDeps);
  return program;
}

test("rocket release build --kind bay-static builds and reports a local artifact", async () => {
  const runs: CapturedRun[] = [];
  const dir = mkdtempSync(join(tmpdir(), "rocket-release-build-"));
  const outDir = join(dir, "bay-static");
  const bundle = join(dir, "cocalc-bay-static-linux-x64.tar.xz");
  const manifest = join(outDir, "bay-static-manifest.json");
  const program = createProgram({
    runs,
    onRun: async () => {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(bundle, "static artifact");
      writeFileSync(
        manifest,
        JSON.stringify({
          kind: "cocalc-bay-static",
          created: "2026-06-12T00:00:00.000Z",
          git: {
            commit: "abc123",
            branch: "lite4",
            dirty: false,
          },
        }),
      );
    },
  });

  await program.parseAsync([
    "node",
    "test",
    "rocket",
    "release",
    "build",
    "--kind",
    "bay-static",
    "--out-dir",
    outDir,
    "--bundle",
    bundle,
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].command, "pnpm");
  assert.equal(runs[0].args[0], "-C");
  assert.equal(runs[0].args[1].endsWith("/src/packages"), true);
  assert.deepEqual(runs[0].args.slice(2, 4), ["--filter", "@cocalc/rocket"]);
  assert.equal(runs[0].args.includes("build:bay-static-bundle"), true);
  assert.deepEqual(runs[0].args.slice(-2), [outDir, bundle]);
});

test("rocket release build --out-dir keeps the default tarball beside that directory", async () => {
  const runs: CapturedRun[] = [];
  const dir = mkdtempSync(join(tmpdir(), "rocket-release-out-dir-"));
  const outDir = join(dir, "runtime");
  const bundle = join(dir, "cocalc-bay-runtime-linux-x64.tar.xz");
  const manifest = join(outDir, "bay-runtime-manifest.json");
  const program = createProgram({
    runs,
    onRun: async () => {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(bundle, "runtime artifact");
      writeFileSync(
        manifest,
        JSON.stringify({
          kind: "cocalc-bay-runtime",
          git: { commit: "abc123" },
        }),
      );
    },
  });

  await program.parseAsync([
    "node",
    "test",
    "rocket",
    "release",
    "build",
    "--kind",
    "bay-runtime",
    "--out-dir",
    outDir,
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].args.includes("--"), false);
  assert.deepEqual(runs[0].args.slice(-2), [outDir, bundle]);
});

test("rocket release build --kind project-host-software builds separate host payload", async () => {
  const runs: CapturedRun[] = [];
  const dir = mkdtempSync(join(tmpdir(), "rocket-host-software-build-"));
  const outDir = join(dir, "project-host-software");
  const bundle = join(dir, "cocalc-project-host-software-linux-x64.tar.xz");
  const manifest = join(outDir, "project-host-software-manifest.json");
  const program = createProgram({
    runs,
    onRun: async () => {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(bundle, "host software artifact");
      writeFileSync(
        manifest,
        JSON.stringify({
          kind: "cocalc-project-host-software",
          git: { commit: "abc123" },
        }),
      );
    },
  });

  await program.parseAsync([
    "node",
    "test",
    "rocket",
    "release",
    "build",
    "--kind",
    "project-host-software",
    "--out-dir",
    outDir,
  ]);

  assert.equal(runs.length, 1);
  assert.equal(
    runs[0].args.includes("build:project-host-software-bundle"),
    true,
  );
  assert.deepEqual(runs[0].args.slice(-2), [outDir, bundle]);
});

test("rocket release build dry-run does not execute the build", async () => {
  const runs: CapturedRun[] = [];
  const program = createProgram({ runs });

  await program.parseAsync([
    "node",
    "test",
    "rocket",
    "release",
    "build",
    "--kind",
    "bay-runtime",
    "--dry-run",
  ]);

  assert.equal(runs.length, 0);
});

test("rocket release build refuses dirty worktree by default", async () => {
  const runs: CapturedRun[] = [];
  const program = createProgram({
    runs,
    gitStatus: " M packages/cli/src/x.ts",
  });

  await assert.rejects(
    () =>
      program.parseAsync([
        "node",
        "test",
        "rocket",
        "release",
        "build",
        "--kind",
        "bay-static",
      ]),
    /dirty git worktree/,
  );
  assert.equal(runs.length, 0);
});

test("rocket deploy --scope bay wraps upgrade-bay-release with host upgrade skipped", async () => {
  const runs: CapturedRun[] = [];
  const program = createProgram({ runs });

  await program.parseAsync([
    "node",
    "test",
    "rocket",
    "deploy",
    "--scope",
    "bay",
    "--build",
    "--remote",
    "ubuntu@10.206.0.38",
    "--api",
    "https://cocalc.ai",
    "--worker-count",
    "4",
    "--retain-releases",
    "5",
    "--yes",
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].command, "bash");
  assert.equal(runs[0].args.includes("--build-bundle"), true);
  assert.equal(runs[0].args.includes("--skip-host-upgrade"), true);
  assert.equal(runs[0].args.includes("--static-only"), false);
  assert.deepEqual(
    runs[0].args.slice(
      runs[0].args.indexOf("--remote"),
      runs[0].args.indexOf("--remote") + 2,
    ),
    ["--remote", "ubuntu@10.206.0.38"],
  );
  assert.deepEqual(
    runs[0].args.slice(
      runs[0].args.indexOf("--worker-count"),
      runs[0].args.indexOf("--worker-count") + 2,
    ),
    ["--worker-count", "4"],
  );
});

test("rocket deploy --static-only keeps compatibility with static deploys", async () => {
  const runs: CapturedRun[] = [];
  const program = createProgram({ runs });

  await program.parseAsync([
    "node",
    "test",
    "rocket",
    "deploy",
    "--static-only",
    "--build",
    "--remote",
    "ubuntu@10.206.0.38",
    "--api",
    "https://cocalc.ai",
    "--worker-count",
    "4",
    "--restart-hub-workers",
    "--yes",
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].args.includes("--static-only"), true);
  assert.equal(runs[0].args.includes("--restart-hub-workers"), true);
  assert.equal(runs[0].args.includes("--skip-host-upgrade"), false);
});

test("rocket deploy --scope all builds bay and host software separately", async () => {
  const runs: CapturedRun[] = [];
  const program = createProgram({ runs });

  await program.parseAsync([
    "node",
    "test",
    "rocket",
    "deploy",
    "--scope",
    "all",
    "--build",
    "--remote",
    "ubuntu@10.206.0.38",
    "--api",
    "https://cocalc.ai",
    "--worker-count",
    "4",
    "--admin-email",
    "admin@example.com",
    "--yes",
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].args.includes("--build-bundle"), true);
  assert.equal(runs[0].args.includes("--build-host-software-bundle"), true);
  assert.equal(runs[0].args.includes("--skip-host-upgrade"), false);
});

test("rocket deploy --scope all accepts explicit host software bundle", async () => {
  const runs: CapturedRun[] = [];
  const program = createProgram({ runs });
  const dir = mkdtempSync(join(tmpdir(), "rocket-host-software-deploy-"));
  const hostSoftwareBundle = join(
    dir,
    "cocalc-project-host-software-linux-x64.tar.xz",
  );
  writeFileSync(hostSoftwareBundle, "host software artifact");

  await program.parseAsync([
    "node",
    "test",
    "rocket",
    "deploy",
    "--scope",
    "all",
    "--bundle",
    "/tmp/cocalc-bay-runtime-linux-x64.tar.xz",
    "--host-software-bundle",
    hostSoftwareBundle,
    "--remote",
    "ubuntu@10.206.0.38",
    "--api",
    "https://cocalc.ai",
    "--worker-count",
    "4",
    "--admin-email",
    "admin@example.com",
    "--yes",
  ]);

  assert.equal(runs.length, 1);
  assert.deepEqual(
    runs[0].args.slice(
      runs[0].args.indexOf("--host-software-bundle"),
      runs[0].args.indexOf("--host-software-bundle") + 2,
    ),
    ["--host-software-bundle", hostSoftwareBundle],
  );
});

test("rocket deploy --scope hosts maps to host upgrade without bay script", async () => {
  const runs: CapturedRun[] = [];
  const program = createProgram({ runs });

  await program.parseAsync([
    "node",
    "test",
    "rocket",
    "deploy",
    "--scope",
    "hosts",
    "--api",
    "https://cocalc.ai",
    "--cli",
    "/bin/echo",
    "--cookie",
    "remember_me=secret",
    "--channel",
    "candidate",
    "--yes",
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].command, "/bin/echo");
  assert.deepEqual(runs[0].args.slice(0, 5), [
    "--api",
    "https://cocalc.ai",
    "--cookie",
    "remember_me=secret",
    "host",
  ]);
  assert.equal(runs[0].args.includes("--all-online"), true);
  assert.equal(runs[0].args.includes("--align-runtime-stack"), true);
  assert.equal(runs[0].args.includes("--wait"), true);
  assert.deepEqual(
    runs[0].args.slice(
      runs[0].args.indexOf("--channel"),
      runs[0].args.indexOf("--channel") + 2,
    ),
    ["--channel", "staging"],
  );
});

test("rocket deploy loads documented yaml cluster config", async () => {
  const runs: CapturedRun[] = [];
  const program = createProgram({ runs });
  const dir = mkdtempSync(join(tmpdir(), "rocket-config-"));
  const config = join(dir, "config.yaml");
  writeFileSync(
    config,
    [
      "clusters:",
      "  prod:",
      "    hub_url: https://cocalc.ai",
      "    ssh:",
      "      remote: ubuntu@10.206.0.38",
      "    bay:",
      "      id: bay-0",
      "      worker_count: 4",
      "      public_url: https://cocalc.ai",
      "      retain_releases: 5",
    ].join("\n"),
  );

  await program.parseAsync([
    "node",
    "test",
    "rocket",
    "deploy",
    "--config",
    config,
    "--cluster",
    "prod",
    "--scope",
    "bay",
    "--build",
    "--yes",
  ]);

  assert.equal(runs.length, 1);
  assert.deepEqual(
    runs[0].args.slice(
      runs[0].args.indexOf("--api"),
      runs[0].args.indexOf("--api") + 2,
    ),
    ["--api", "https://cocalc.ai"],
  );
  assert.deepEqual(
    runs[0].args.slice(
      runs[0].args.indexOf("--remote"),
      runs[0].args.indexOf("--remote") + 2,
    ),
    ["--remote", "ubuntu@10.206.0.38"],
  );
  assert.deepEqual(
    runs[0].args.slice(
      runs[0].args.indexOf("--retain-releases"),
      runs[0].args.indexOf("--retain-releases") + 2,
    ),
    ["--retain-releases", "5"],
  );
});

test("rocket deploy requires an explicit scope", async () => {
  const runs: CapturedRun[] = [];
  const program = createProgram({ runs });

  await assert.rejects(
    () =>
      program.parseAsync([
        "node",
        "test",
        "rocket",
        "deploy",
        "--build",
        "--remote",
        "ubuntu@10.206.0.38",
        "--api",
        "https://cocalc.ai",
        "--worker-count",
        "4",
        "--yes",
      ]),
    /explicit --scope/,
  );
  assert.equal(runs.length, 0);
});

test("rocket deploy refuses dirty worktree builds by default", async () => {
  const runs: CapturedRun[] = [];
  const program = createProgram({
    runs,
    gitStatus: " M packages/cli/src/x.ts",
  });

  await assert.rejects(
    () =>
      program.parseAsync([
        "node",
        "test",
        "rocket",
        "deploy",
        "--scope",
        "bay",
        "--build",
        "--remote",
        "ubuntu@10.206.0.38",
        "--api",
        "https://cocalc.ai",
        "--worker-count",
        "4",
        "--yes",
      ]),
    /dirty git worktree/,
  );
  assert.equal(runs.length, 0);
});
