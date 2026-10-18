import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Command } from "commander";

import {
  __test__,
  registerRocketCommand,
  type RocketCommandDeps,
} from "./rocket";

type CapturedRun = {
  command: string;
  args: string[];
};

const releaseArch = process.arch === "arm64" ? "arm64" : "x64";

test("rocket invokes generated JavaScript CLIs through Node", () => {
  assert.deepEqual(__test__.cliInvocation("/tmp/cocalc.js", ["host", "list"]), {
    command: process.execPath,
    args: ["/tmp/cocalc.js", "host", "list"],
  });
  assert.deepEqual(__test__.cliInvocation("/opt/cocalc/bin/cocalc", ["host"]), {
    command: "/opt/cocalc/bin/cocalc",
    args: ["host"],
  });
});

test("rocket safely formats missing child-process output", () => {
  assert.equal(__test__.trimCommandOutput(undefined), "");
  assert.equal(__test__.trimCommandOutput("first\nsecond\n"), "first\nsecond");
});

test("rocket redacts cookie headers, pairs and values", () => {
  const auth = "remember_me=sha512$0123456789abcdef$1000$session-secret-value";
  const affinity = "cocalc_bay_frontdoor_worker=1.affinity-secret-value";
  const value = "sha512$0123456789abcdef$1000$session-secret-value";
  const text = `--cookie ${auth}; ${affinity} | value ${value} | ${affinity}`;
  const redacted = __test__.redactSecrets(text, [
    `${auth}; ${affinity}`,
    auth,
    affinity,
  ]);
  assert.doesNotMatch(redacted, /session-secret-value|affinity-secret-value/);
  assert.match(redacted, /--cookie <redacted>/);
  // A short value is not treated as a secret everywhere it appears.
  assert.equal(__test__.redactSecrets("worker 1 ok", ["w=1"]), "worker 1 ok");
});

test("rocket host route probe never reports the auth cookie", async () => {
  // A CLI that echoes its arguments and fails, the way a timed-out or failing
  // probe does: Node then reports "Command failed: <command line>".
  const dir = mkdtempSync(join(tmpdir(), "rocket-probe-"));
  const cliPath = join(dir, "fake-cli.js");
  writeFileSync(
    cliPath,
    "process.stderr.write(process.argv.slice(2).join(' ')); process.exit(1);\n",
  );
  const authCookie =
    "remember_me=sha512$0123456789abcdef$1000$session-secret-value";
  const affinityCookie = "cocalc_bay_frontdoor_worker=1.affinity-secret-value";
  const probe = await __test__.runHostRouteProbe({
    cliPath,
    api: "https://example.invalid",
    authCookie,
    affinityCookie,
    workerId: 1,
    host: { host_id: "00000000-0000-4000-8000-000000000000", name: "h" },
    rpcTimeout: "5s",
    requestTimeoutMs: 10_000,
  });
  assert.equal(probe.ok, false);
  assert.match(probe.error ?? "", /Command failed/);
  assert.match(probe.error ?? "", /<redacted>/);
  assert.doesNotMatch(
    probe.error ?? "",
    /session-secret-value|affinity-secret-value|remember_me=/,
  );
});

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
  const bundle = join(dir, `cocalc-bay-runtime-linux-${releaseArch}.tar.xz`);
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

test("rocket release build --kind bay-hub builds a control-plane artifact", async () => {
  const runs: CapturedRun[] = [];
  const dir = mkdtempSync(join(tmpdir(), "rocket-hub-build-"));
  const outDir = join(dir, "bay-hub");
  const bundle = join(dir, `cocalc-bay-hub-linux-${releaseArch}.tar.xz`);
  const manifest = join(outDir, "bay-hub-manifest.json");
  const program = createProgram({
    runs,
    onRun: async () => {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(bundle, "hub artifact");
      writeFileSync(
        manifest,
        JSON.stringify({
          kind: "cocalc-bay-hub",
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
    "bay-hub",
    "--out-dir",
    outDir,
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].args.includes("build:bay-hub-bundle"), true);
  assert.deepEqual(runs[0].args.slice(-2), [outDir, bundle]);
});

test("rocket release build --kind project-host-software builds separate host payload", async () => {
  const runs: CapturedRun[] = [];
  const dir = mkdtempSync(join(tmpdir(), "rocket-host-software-build-"));
  const outDir = join(dir, "project-host-software");
  const bundle = join(
    dir,
    `cocalc-project-host-software-linux-${releaseArch}.tar.xz`,
  );
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
  assert.equal(runs[0].args.includes("--worker-count"), false);
  assert.equal(runs[0].args.includes("--restart-shared-services"), false);
});

test("rocket deploy can request bay shared service restarts explicitly", async () => {
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
    "--restart-shared-services",
    "--yes",
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].args.includes("--restart-shared-services"), true);
  assert.equal(runs[0].args.includes("--skip-host-upgrade"), true);
});

test("rocket deploy can request a cloudflared restart explicitly", async () => {
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
    "--restart-cloudflared",
    "--yes",
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].args.includes("--restart-cloudflared"), true);
  assert.equal(runs[0].args.includes("--skip-host-upgrade"), true);
});

test("rocket deploy --scope hub wraps upgrade-bay-release as hub-only", async () => {
  const runs: CapturedRun[] = [];
  const program = createProgram({ runs });

  await program.parseAsync([
    "node",
    "test",
    "rocket",
    "deploy",
    "--scope",
    "hub",
    "--build",
    "--remote",
    "ubuntu@10.206.0.38",
    "--api",
    "https://cocalc.ai",
    "--yes",
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].args.includes("--build-bundle"), true);
  assert.equal(runs[0].args.includes("--hub-only"), true);
  assert.equal(runs[0].args.includes("--skip-host-upgrade"), false);
  assert.equal(runs[0].args.includes("--static-only"), false);
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
    "--restart-hub-workers",
    "--yes",
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].args.includes("--static-only"), true);
  assert.equal(runs[0].args.includes("--restart-hub-workers"), true);
  assert.equal(runs[0].args.includes("--skip-host-upgrade"), false);
});

test("rocket deploy can ask target VM to download bundle by URL", async () => {
  const runs: CapturedRun[] = [];
  const program = createProgram({ runs });

  await program.parseAsync([
    "node",
    "test",
    "rocket",
    "deploy",
    "--scope",
    "static",
    "--bundle-url",
    "https://software.example.test/software/artifacts/static/build/files/static.tar.xz",
    "--bundle-sha256",
    "abc123",
    "--remote",
    "ubuntu@10.206.0.38",
    "--api",
    "https://cocalc.ai",
    "--yes",
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].args.includes("--static-only"), true);
  assert.deepEqual(
    runs[0].args.slice(
      runs[0].args.indexOf("--bundle-url"),
      runs[0].args.indexOf("--bundle-url") + 4,
    ),
    [
      "--bundle-url",
      "https://software.example.test/software/artifacts/static/build/files/static.tar.xz",
      "--bundle-sha256",
      "abc123",
    ],
  );
});

test("rocket deploy passes precise bay service restart to script", async () => {
  const runs: CapturedRun[] = [];
  const program = createProgram({ runs });

  await program.parseAsync([
    "node",
    "test",
    "rocket",
    "deploy",
    "--scope",
    "bay",
    "--bundle-url",
    "https://software.example.test/software/artifacts/bay/build/files/bay.tar.xz",
    "--remote",
    "ubuntu@10.206.0.38",
    "--api",
    "https://cocalc.ai",
    "--bay-service",
    "frontdoor",
    "--yes",
  ]);

  assert.equal(runs.length, 1);
  assert.deepEqual(
    runs[0].args.slice(
      runs[0].args.indexOf("--restart-bay-service"),
      runs[0].args.indexOf("--restart-bay-service") + 2,
    ),
    ["--restart-bay-service", "frontdoor"],
  );
});

test("rocket deploy passes scaffold-only to script", async () => {
  const runs: CapturedRun[] = [];
  const program = createProgram({ runs });

  await program.parseAsync([
    "node",
    "test",
    "rocket",
    "deploy",
    "--scope",
    "bay",
    "--bundle-url",
    "https://software.example.test/software/artifacts/bay/build/files/bay.tar.xz",
    "--remote",
    "ubuntu@10.206.0.38",
    "--api",
    "https://cocalc.ai",
    "--scaffold-only",
    "--yes",
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].args.includes("--scaffold-only"), true);
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
  assert.deepEqual(
    runs[0].args.slice(
      runs[0].args.indexOf("--worker-count"),
      runs[0].args.indexOf("--worker-count") + 2,
    ),
    ["--worker-count", "4"],
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
        "--yes",
      ]),
    /dirty git worktree/,
  );
  assert.equal(runs.length, 0);
});
