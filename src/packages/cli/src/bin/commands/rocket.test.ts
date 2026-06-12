import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
}: {
  runs: CapturedRun[];
  gitStatus?: string;
}): Command {
  const program = new Command();
  program.exitOverride();
  registerRocketCommand(program, {
    cwd: join(__dirname, "../../../../../.."),
    env: {},
    commandExists: (command) => command === "bash",
    gitStatus: () => gitStatus,
    runCommand: async (command, args) => {
      runs.push({ command, args });
      return 0;
    },
  } satisfies RocketCommandDeps);
  return program;
}

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
