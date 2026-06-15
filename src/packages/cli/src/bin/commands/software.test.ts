import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Command } from "commander";

import { registerSoftwareCommand, type SoftwareCommandDeps } from "./software";
import type { SoftwareR2Client } from "../core/software/remote-store";

type CapturedRun = {
  command: string;
  args: string[];
};

type CapturedOutputRun = CapturedRun & {
  stdout: string;
  stderr: string;
};

const testAuthConfig = {
  current_profile: "staging",
  profiles: {
    staging: {
      api: "https://staging.cocalc.ai",
      account_id: "test-staging-account",
      email_address: "operator@example.test",
    },
    prod: {
      api: "https://cocalc.ai",
      account_id: "test-prod-account",
      email_address: "operator@example.test",
    },
  },
};

function makeDeps({
  localStore,
  runs,
  cwd = "/repo",
  repoRoot = "/repo",
  env,
  r2Client,
  loadAuthConfig,
  fetch,
  outputRuns,
}: {
  localStore: string;
  runs?: CapturedRun[];
  outputRuns?: CapturedOutputRun[];
  cwd?: string;
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  r2Client?: SoftwareR2Client;
  loadAuthConfig?: SoftwareCommandDeps["loadAuthConfig"];
  fetch?: SoftwareCommandDeps["fetch"];
}): SoftwareCommandDeps {
  return {
    cwd,
    env: { COCALC_SOFTWARE_LOCAL_STORE: localStore, ...env },
    now: () => new Date("2026-06-14T23:59:12.345Z"),
    gitMetadata: () => ({
      commit: "e882d124c7abcdef",
      short: "e882d124c7ab",
      branch: "lite4",
      dirty: false,
      status_porcelain: "",
    }),
    repoRoot: () => repoRoot,
    runCommand: async (command, args) => {
      runs?.push({ command, args });
      let bundle = command === "pnpm" ? args.at(-1) : undefined;
      if (command === "pnpm" && args.includes("@cocalc/project-host")) {
        bundle = join(
          repoRoot,
          "src",
          "packages",
          "project-host",
          "build",
          "bundle-linux.tar.xz",
        );
      } else if (
        command === "pnpm" &&
        args.includes("@cocalc/project") &&
        args.includes("build:bundle")
      ) {
        bundle = join(
          repoRoot,
          "src",
          "packages",
          "project",
          "build",
          "bundle-linux.tar.xz",
        );
      } else if (
        command === "pnpm" &&
        args.includes("@cocalc/project") &&
        args.includes("build:tools")
      ) {
        bundle = undefined;
        for (const arch of ["amd64", "arm64"]) {
          const toolsBundle = join(
            repoRoot,
            "src",
            "packages",
            "project",
            "build",
            `tools-linux-${arch}.tar.xz`,
          );
          mkdirSync(join(toolsBundle, ".."), { recursive: true });
          writeFileSync(toolsBundle, `built tools bundle ${arch}`);
        }
      }
      if (bundle) {
        mkdirSync(join(bundle, ".."), { recursive: true });
        writeFileSync(bundle, "built bundle");
      }
      return 0;
    },
    runCommandOutput: async (command, args) => {
      const next = outputRuns?.shift();
      if (next) {
        next.command = command;
        next.args = args;
        return { code: 0, stdout: next.stdout, stderr: next.stderr };
      }
      return { code: 1, stdout: "", stderr: "unexpected command" };
    },
    r2Client,
    loadAuthConfig: loadAuthConfig ?? (() => testAuthConfig),
    fetch,
  };
}

function makeR2Client(objects = new Map<string, Buffer>()): {
  client: SoftwareR2Client;
  objects: Map<string, Buffer>;
} {
  return {
    objects,
    client: {
      putR2ObjectFromFile: async ({ key, filePath }) => {
        objects.set(key, readFileSync(filePath));
      },
      putR2ObjectFromBuffer: async ({ key, body }) => {
        objects.set(key, Buffer.from(body));
      },
      getR2ObjectBuffer: async ({ key }) => {
        const value = objects.get(key);
        if (!value) {
          const err: any = new Error(`404 not found: ${key}`);
          err.statusCode = 404;
          throw err;
        }
        return value;
      },
      copyR2Object: async ({ sourceKey, destKey }) => {
        const value = objects.get(sourceKey);
        if (!value) {
          const err: any = new Error(`404 not found: ${sourceKey}`);
          err.statusCode = 404;
          throw err;
        }
        objects.set(destKey, Buffer.from(value));
      },
    },
  };
}

const r2Env = {
  COCALC_R2_ACCOUNT_ID: "account",
  COCALC_R2_ACCESS_KEY_ID: "access",
  COCALC_R2_SECRET_ACCESS_KEY: "secret",
  COCALC_R2_BUCKET: "bucket",
  COCALC_R2_PUBLIC_BASE_URL: "https://software.example.test",
};

function createProgram(deps: SoftwareCommandDeps): Command {
  const program = new Command();
  program.exitOverride();
  program.option("--json", "output machine-readable JSON");
  program.option("--output <format>", "output format", "table");
  program.option("-q, --quiet", "suppress human-formatted success output");
  registerSoftwareCommand(program, deps);
  return program;
}

test("software help lists supported components", () => {
  const program = createProgram(makeDeps({ localStore: "/tmp/software-help" }));
  const software = program.commands.find(
    (command) => command.name() === "software",
  );
  assert.ok(software);
  const build = software.commands.find((command) => command.name() === "build");
  const list = software.commands.find((command) => command.name() === "list");
  const deploy = software.commands.find(
    (command) => command.name() === "deploy",
  );
  assert.ok(build);
  assert.ok(list);
  assert.ok(deploy);
  assert.match(build.helpInformation(), /static\|hub\|bay\|project-host/);
  assert.match(list.helpInformation(), /cli\|launchpad\|plus\|star/);
  assert.match(deploy.helpInformation(), /bay-conat-router/);
  assert.doesNotMatch(deploy.helpInformation(), /hub-conat-router/);
});

test("software build records an existing file with a generated tag", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-build-"));
  const localStore = join(dir, "store");
  const source = join(dir, "artifact.tar.xz");
  writeFileSync(source, "artifact contents");
  const program = createProgram(makeDeps({ localStore }));

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "hub",
    "--from-file",
    source,
  ]);

  const manifestPath = join(
    localStore,
    "hub",
    "20260614T235912Z-e882d124-20260614T2359Z",
    "manifest.json",
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.component, "hub");
  assert.equal(manifest.tag, "20260614T2359Z");
  assert.equal(manifest.tag_generated, true);
  assert.equal(manifest.files[0].name, "artifact.tar.xz");
  assert.equal(manifest.files[0].size_bytes, "artifact contents".length);
});

test("software build hub runs the Rocket bay hub builder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-hub-build-"));
  const localStore = join(dir, "store");
  const runs: CapturedRun[] = [];
  const program = createProgram(makeDeps({ localStore, runs }));

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "hub",
    "runtime-test",
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].command, "pnpm");
  assert.deepEqual(runs[0].args.slice(0, 4), [
    "-C",
    "/repo/src/packages",
    "--filter",
    "@cocalc/rocket",
  ]);
  assert.equal(runs[0].args.includes("build:bay-hub-bundle"), true);
  const artifactName = `cocalc-bay-hub-linux-${
    process.arch === "arm64" ? "arm64" : "x64"
  }.tar.xz`;
  const artifactDir = join(
    localStore,
    "hub",
    "20260614T235912Z-e882d124-runtime-test",
  );
  assert.equal(existsSync(join(artifactDir, "files", artifactName)), true);
  const manifest = JSON.parse(
    readFileSync(join(artifactDir, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.files[0].name, artifactName);
  assert.match(manifest.build.command, /build:bay-hub-bundle/);
});

test("software build resolves the cocalc-ai repo root from subdirectories", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-subdir-build-"));
  const localStore = join(dir, "store");
  const runs: CapturedRun[] = [];
  const program = createProgram(
    makeDeps({
      localStore,
      runs,
      cwd: "/repo/src/packages/cli",
      repoRoot: "/repo",
    }),
  );

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "hub",
    "subdir-test",
  ]);

  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].args.slice(0, 4), [
    "-C",
    "/repo/src/packages",
    "--filter",
    "@cocalc/rocket",
  ]);
  const manifest = JSON.parse(
    readFileSync(
      join(
        localStore,
        "hub",
        "20260614T235912Z-e882d124-subdir-test",
        "manifest.json",
      ),
      "utf8",
    ),
  );
  assert.equal(manifest.source.repo_root, "/repo");
  assert.equal(manifest.source.src_root, "/repo/src");
});

test("software build bay runs the full Rocket bay runtime builder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-bay-build-"));
  const localStore = join(dir, "store");
  const runs: CapturedRun[] = [];
  const program = createProgram(makeDeps({ localStore, runs }));

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "bay",
    "full-runtime-test",
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].args.includes("build:bay-bundle"), true);
  const artifactName = `cocalc-bay-runtime-linux-${
    process.arch === "arm64" ? "arm64" : "x64"
  }.tar.xz`;
  const artifactDir = join(
    localStore,
    "bay",
    "20260614T235912Z-e882d124-full-runtime-test",
  );
  assert.equal(existsSync(join(artifactDir, "files", artifactName)), true);
  const manifest = JSON.parse(
    readFileSync(join(artifactDir, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.files[0].name, artifactName);
  assert.match(manifest.build.command, /build:bay-bundle/);
});

test("software build static runs the Rocket bay static builder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-static-build-"));
  const localStore = join(dir, "store");
  const runs: CapturedRun[] = [];
  const program = createProgram(makeDeps({ localStore, runs }));

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "static",
    "static-test",
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].args.includes("build:bay-static-bundle"), true);
  const artifactName = `cocalc-bay-static-linux-${
    process.arch === "arm64" ? "arm64" : "x64"
  }.tar.xz`;
  assert.equal(
    existsSync(
      join(
        localStore,
        "static",
        "20260614T235912Z-e882d124-static-test",
        "files",
        artifactName,
      ),
    ),
    true,
  );
});

test("software build project-host runs the package bundle builder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-project-host-build-"));
  const localStore = join(dir, "store");
  const runs: CapturedRun[] = [];
  const program = createProgram(makeDeps({ localStore, runs, cwd: dir }));

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "project-host",
    "host-test",
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].args.includes("@cocalc/project-host"), true);
  assert.equal(runs[0].args.includes("build:bundle"), true);
  assert.equal(
    existsSync(
      join(
        localStore,
        "project-host",
        "20260614T235912Z-e882d124-host-test",
        "files",
        "bundle-linux.tar.xz",
      ),
    ),
    true,
  );
});

test("software build project runs the package bundle builder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-project-build-"));
  const localStore = join(dir, "store");
  const runs: CapturedRun[] = [];
  const program = createProgram(makeDeps({ localStore, runs, cwd: dir }));

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "project",
    "project-test",
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].args.includes("@cocalc/project"), true);
  assert.equal(runs[0].args.includes("build:bundle"), true);
  assert.equal(
    existsSync(
      join(
        localStore,
        "project",
        "20260614T235912Z-e882d124-project-test",
        "files",
        "bundle-linux.tar.xz",
      ),
    ),
    true,
  );
});

test("software build tools runs the package tools builder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-tools-build-"));
  const localStore = join(dir, "store");
  const runs: CapturedRun[] = [];
  const program = createProgram(makeDeps({ localStore, runs, cwd: dir }));

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "tools",
    "tools-test",
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].args.includes("@cocalc/project"), true);
  assert.equal(runs[0].args.includes("build:tools"), true);
  for (const arch of ["amd64", "arm64"]) {
    assert.equal(
      existsSync(
        join(
          localStore,
          "tools",
          "20260614T235912Z-e882d124-tools-test",
          "files",
          `tools-linux-${arch}.tar.xz`,
        ),
      ),
      true,
    );
  }
});

test("software build rejects duplicate explicit local tags", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-duplicate-"));
  const localStore = join(dir, "store");
  const source = join(dir, "artifact.tar.xz");
  writeFileSync(source, "artifact contents");
  const program = createProgram(makeDeps({ localStore }));

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "hub",
    "fix-bug",
    "--from-file",
    source,
  ]);

  await assert.rejects(
    async () =>
      await program.parseAsync([
        "node",
        "test",
        "--quiet",
        "software",
        "build",
        "hub",
        "fix-bug",
        "--from-file",
        source,
      ]),
    /software tag already exists locally/,
  );
});

test("software list emits local artifacts as json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-list-"));
  const localStore = join(dir, "store");
  const source = join(dir, "artifact.tar.xz");
  writeFileSync(source, "artifact contents");
  const program = createProgram(makeDeps({ localStore }));

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "hub",
    "fix-bug",
    "--from-file",
    source,
  ]);

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    logs.push(String(value ?? ""));
  };
  try {
    await program.parseAsync([
      "node",
      "test",
      "--json",
      "software",
      "list",
      "hub",
      "--no-remote",
    ]);
  } finally {
    console.log = originalLog;
  }
  const payload = JSON.parse(logs.at(-1) ?? "{}");
  assert.equal(payload.ok, true);
  assert.equal(payload.command, "software list");
  assert.equal(payload.data.artifacts[0].tag, "fix-bug");
  assert.equal(payload.data.artifacts[0].source, "local");
});

test("software push uploads files manifest and component index", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-push-"));
  const localStore = join(dir, "store");
  const source = join(dir, "artifact.tar.xz");
  writeFileSync(source, "artifact contents");
  const r2 = makeR2Client();
  const program = createProgram(
    makeDeps({ localStore, env: r2Env, r2Client: r2.client }),
  );

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "hub",
    "push-test",
    "--from-file",
    source,
  ]);

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    logs.push(String(value ?? ""));
  };
  try {
    await program.parseAsync([
      "node",
      "test",
      "--json",
      "software",
      "push",
      "hub",
      "push-test",
      "--env-file",
      join(dir, "missing.env"),
    ]);
  } finally {
    console.log = originalLog;
  }

  const artifactId = "20260614T235912Z-e882d124-push-test";
  const prefix = `software/artifacts/hub/${artifactId}`;
  assert.equal(r2.objects.has(`${prefix}/files/artifact.tar.xz`), true);
  assert.equal(r2.objects.has(`${prefix}/files/artifact.tar.xz.sha256`), true);
  assert.equal(r2.objects.has(`${prefix}/manifest.json`), true);
  assert.equal(r2.objects.has("software/indexes/hub.json"), true);
  const index = JSON.parse(
    r2.objects.get("software/indexes/hub.json")!.toString("utf8"),
  );
  assert.equal(index.schema, "cocalc-software-index-v1");
  assert.equal(index.artifacts[0].tag, "push-test");
  assert.equal(
    index.artifacts[0].manifest_url,
    `https://software.example.test/${prefix}/manifest.json`,
  );
  const payload = JSON.parse(logs.at(-1) ?? "{}");
  assert.equal(payload.ok, true);
  assert.equal(payload.command, "software push");
  assert.equal(payload.data.tag, "push-test");
  assert.equal(payload.data.duration, "0ms");
});

test("software list merges local and remote artifacts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-list-remote-"));
  const localStore = join(dir, "store");
  const source = join(dir, "artifact.tar.xz");
  writeFileSync(source, "artifact contents");
  const r2 = makeR2Client();
  const program = createProgram(
    makeDeps({ localStore, env: r2Env, r2Client: r2.client }),
  );

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "hub",
    "push-test",
    "--from-file",
    source,
  ]);

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "push",
    "hub",
    "push-test",
    "--env-file",
    join(dir, "missing.env"),
  ]);

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    logs.push(String(value ?? ""));
  };
  try {
    await program.parseAsync([
      "node",
      "test",
      "--json",
      "software",
      "list",
      "hub",
      "--env-file",
      join(dir, "missing.env"),
    ]);
  } finally {
    console.log = originalLog;
  }

  const payload = JSON.parse(logs.at(-1) ?? "{}");
  const artifact = payload.data.artifacts[0];
  assert.equal(artifact.tag, "push-test");
  assert.equal(artifact.source, "local+remote");
  assert.match(
    artifact.remote,
    /^https:\/\/software\.example\.test\/software\/artifacts\/hub\/20260614T235912Z-e882d124-push-test\/manifest\.json$/,
  );
  assert.match(artifact.local, /manifest\.json$/);
});

test("software list shows remote-only artifacts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-list-remote-only-"));
  const localStore = join(dir, "store");
  const index = {
    schema: "cocalc-software-index-v1",
    component: "static",
    generated_at: "2026-06-15T00:00:00.000Z",
    artifacts: [
      {
        artifact_id: "20260615T000000Z-abcdef12-remote-test",
        tag: "remote-test",
        tag_generated: false,
        timestamp: "2026-06-15T00:00:00.000Z",
        git: { commit: "abcdef123456", short: "abcdef123456", dirty: false },
        manifest_key:
          "software/artifacts/static/20260615T000000Z-abcdef12-remote-test/manifest.json",
        manifest_url:
          "https://software.example.test/software/artifacts/static/20260615T000000Z-abcdef12-remote-test/manifest.json",
        files: [
          {
            name: "cocalc-bay-static-linux-x64.tar.xz",
            size_bytes: 1234,
            sha256: "abc",
            key: "software/artifacts/static/20260615T000000Z-abcdef12-remote-test/files/cocalc-bay-static-linux-x64.tar.xz",
            url: "https://software.example.test/software/artifacts/static/20260615T000000Z-abcdef12-remote-test/files/cocalc-bay-static-linux-x64.tar.xz",
          },
        ],
      },
    ],
  };
  const r2 = makeR2Client(
    new Map([
      [
        "software/indexes/static.json",
        Buffer.from(JSON.stringify(index), "utf8"),
      ],
    ]),
  );
  const program = createProgram(
    makeDeps({ localStore, env: r2Env, r2Client: r2.client }),
  );

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    logs.push(String(value ?? ""));
  };
  try {
    await program.parseAsync([
      "node",
      "test",
      "--json",
      "software",
      "list",
      "static",
      "--env-file",
      join(dir, "missing.env"),
    ]);
  } finally {
    console.log = originalLog;
  }

  const payload = JSON.parse(logs.at(-1) ?? "{}");
  const artifact = payload.data.artifacts[0];
  assert.equal(artifact.tag, "remote-test");
  assert.equal(artifact.source, "remote");
  assert.equal(artifact.local, undefined);
  assert.match(artifact.remote, /remote-test\/manifest\.json$/);
});

test("software deploy static invokes Rocket with a local remote-backed bundle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-deploy-static-"));
  const localStore = join(dir, "store");
  const source = join(dir, "static.tar.xz");
  writeFileSync(source, "static bundle");
  const runs: CapturedRun[] = [];
  const r2 = makeR2Client();
  const program = createProgram(
    makeDeps({ localStore, runs, env: r2Env, r2Client: r2.client }),
  );
  const originalArgv1 = process.argv[1];
  process.argv[1] = join(dir, "cocalc-bin");

  try {
    await program.parseAsync([
      "node",
      "test",
      "--quiet",
      "software",
      "build",
      "static",
      "deploy-test",
      "--from-file",
      source,
    ]);
    await program.parseAsync([
      "node",
      "test",
      "--quiet",
      "software",
      "push",
      "static",
      "deploy-test",
      "--env-file",
      join(dir, "missing.env"),
    ]);
    await program.parseAsync([
      "node",
      "test",
      "--quiet",
      "software",
      "deploy",
      "static",
      "deploy-test",
      "staging",
      "--env-file",
      join(dir, "missing.env"),
    ]);
  } finally {
    process.argv[1] = originalArgv1;
  }

  assert.equal(runs.length, 1);
  const run = runs[0];
  assert.equal(run.command, join(dir, "cocalc-bin"));
  const rocketIndex = run.args.indexOf("rocket");
  assert.notEqual(rocketIndex, -1);
  const index = JSON.parse(
    r2.objects.get("software/indexes/static.json")!.toString("utf8"),
  );
  const file = index.artifacts[0].files[0];
  assert.deepEqual(run.args.slice(rocketIndex), [
    "rocket",
    "deploy",
    "staging",
    "--scope",
    "static",
    "--bundle-url",
    file.url,
    "--bundle-sha256",
    file.sha256,
    "--remote",
    "ubuntu@10.206.0.27",
    "--api",
    "https://staging.cocalc.ai",
    "--yes",
  ]);
  const history = JSON.parse(
    r2.objects
      .get("software/deployments/staging/static/index.json")!
      .toString("utf8"),
  );
  assert.equal(history.deployments[0].status, "succeeded");
  assert.equal(history.deployments[0].tag, "deploy-test");
  assert.equal(history.deployments[0].profile_or_channel, "staging");
});

test("software history shows unknown for unsealed started deployments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-history-started-"));
  const localStore = join(dir, "store");
  const deploymentIndex = {
    schema: "cocalc-software-deployment-index-v1",
    component: "hub",
    profile_or_channel: "staging",
    generated_at: "2026-06-15T00:00:00.000Z",
    deployments: [
      {
        deployment_id: "20260615T000000Z-artifact",
        component: "hub",
        artifact_component: "hub",
        profile_or_channel: "staging",
        started_at: "2026-06-15T00:00:00.000Z",
        updated_at: "2026-06-15T00:00:00.000Z",
        artifact_id: "artifact",
        tag: "tag",
        git: { commit: "abcdef", short: "abcdef", dirty: false },
        deployed_by: { user: "alice", host: "workstation" },
        target: { kind: "rocket-bay", profile: "staging" },
        status: "started",
        record_key: "software/deployments/staging/hub/record.json",
        record_url:
          "https://software.example.test/software/deployments/staging/hub/record.json",
      },
    ],
  };
  const r2 = makeR2Client(
    new Map([
      [
        "software/deployments/staging/hub/index.json",
        Buffer.from(JSON.stringify(deploymentIndex), "utf8"),
      ],
    ]),
  );
  const program = createProgram(
    makeDeps({ localStore, env: r2Env, r2Client: r2.client }),
  );
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    logs.push(String(value ?? ""));
  };
  try {
    await program.parseAsync([
      "node",
      "test",
      "--json",
      "software",
      "history",
      "hub",
      "staging",
      "--env-file",
      join(dir, "missing.env"),
    ]);
  } finally {
    console.log = originalLog;
  }
  const payload = JSON.parse(logs.at(-1) ?? "{}");
  assert.equal(payload.data.deployments[0].status, "unknown");
});

test("software deploy latest chooses the newest remote artifact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-deploy-latest-"));
  const localStore = join(dir, "store");
  const source = join(dir, "static-local.tar.xz");
  writeFileSync(source, "local static bundle");
  const runs: CapturedRun[] = [];
  const remoteFileKey =
    "software/artifacts/static/20260615T000000Z-abcdef12-remote-new/files/static-remote.tar.xz";
  const remoteIndex = {
    schema: "cocalc-software-index-v1",
    component: "static",
    generated_at: "2026-06-15T00:00:00.000Z",
    artifacts: [
      {
        artifact_id: "20260615T000000Z-abcdef12-remote-new",
        tag: "remote-new",
        tag_generated: false,
        timestamp: "2026-06-15T00:00:00.000Z",
        git: { commit: "abcdef123456", short: "abcdef123456", dirty: false },
        manifest_key:
          "software/artifacts/static/20260615T000000Z-abcdef12-remote-new/manifest.json",
        manifest_url:
          "https://software.example.test/software/artifacts/static/20260615T000000Z-abcdef12-remote-new/manifest.json",
        files: [
          {
            name: "static-remote.tar.xz",
            size_bytes: "remote static bundle".length,
            sha256: "abc",
            key: remoteFileKey,
            url: `https://software.example.test/${remoteFileKey}`,
          },
        ],
      },
    ],
  };
  const r2 = makeR2Client(
    new Map([
      [
        "software/indexes/static.json",
        Buffer.from(JSON.stringify(remoteIndex), "utf8"),
      ],
      [remoteFileKey, Buffer.from("remote static bundle", "utf8")],
    ]),
  );
  const program = createProgram(
    makeDeps({ localStore, runs, env: r2Env, r2Client: r2.client }),
  );

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "static",
    "local-old",
    "--from-file",
    source,
  ]);
  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "deploy",
    "static",
    "latest",
    "staging",
    "--env-file",
    join(dir, "missing.env"),
  ]);

  assert.equal(runs.length, 1);
  const rocketIndex = runs[0].args.indexOf("rocket");
  assert.notEqual(rocketIndex, -1);
  const rocketArgs = runs[0].args.slice(rocketIndex);
  assert.deepEqual(rocketArgs.slice(0, 6), [
    "rocket",
    "deploy",
    "staging",
    "--scope",
    "static",
    "--bundle-url",
  ]);
  assert.equal(rocketArgs[6], `https://software.example.test/${remoteFileKey}`);
  assert.equal(rocketArgs[7], "--bundle-sha256");
  assert.equal(rocketArgs[8], "abc");
  assert.deepEqual(rocketArgs.slice(9), [
    "--remote",
    "ubuntu@10.206.0.27",
    "--api",
    "https://staging.cocalc.ai",
    "--yes",
  ]);
});

test("software deploy resolves API from auth profile and infers known bay remote", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-deploy-profile-"));
  const localStore = join(dir, "store");
  const source = join(dir, "static.tar.xz");
  writeFileSync(source, "static bundle");
  const runs: CapturedRun[] = [];
  const r2 = makeR2Client();
  const program = createProgram(
    makeDeps({
      localStore,
      runs,
      env: r2Env,
      r2Client: r2.client,
      loadAuthConfig: () => ({
        current_profile: "default",
        profiles: {
          default: { api: "https://cocalc.ai" },
          "staging-load": { api: "https://staging.cocalc.ai" },
        },
      }),
    }),
  );

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "static",
    "profile-test",
    "--from-file",
    source,
  ]);
  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "push",
    "static",
    "profile-test",
    "--env-file",
    join(dir, "missing.env"),
  ]);
  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "deploy",
    "static",
    "profile-test",
    "staging-load",
    "--env-file",
    join(dir, "missing.env"),
  ]);

  assert.equal(runs.length, 1);
  const rocketIndex = runs[0].args.indexOf("rocket");
  assert.notEqual(rocketIndex, -1);
  const rocketArgs = runs[0].args.slice(rocketIndex);
  assert.deepEqual(
    rocketArgs.slice(
      rocketArgs.indexOf("--remote"),
      rocketArgs.indexOf("--remote") + 2,
    ),
    ["--remote", "ubuntu@10.206.0.27"],
  );
  assert.deepEqual(
    rocketArgs.slice(
      rocketArgs.indexOf("--api"),
      rocketArgs.indexOf("--api") + 2,
    ),
    ["--api", "https://staging.cocalc.ai"],
  );
});

test("software deploy hub pushes a local-only artifact before Rocket deploy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-deploy-hub-"));
  const localStore = join(dir, "store");
  const source = join(dir, "hub.tar.xz");
  writeFileSync(source, "hub bundle");
  const runs: CapturedRun[] = [];
  const r2 = makeR2Client();
  const program = createProgram(
    makeDeps({ localStore, runs, env: r2Env, r2Client: r2.client }),
  );

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "hub",
    "local-deploy",
    "--from-file",
    source,
  ]);
  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "deploy",
    "hub",
    "local-deploy",
    "prod",
    "--env-file",
    join(dir, "missing.env"),
  ]);

  assert.equal(r2.objects.has("software/indexes/hub.json"), true);
  assert.equal(runs.length, 1);
  const rocketIndex = runs[0].args.indexOf("rocket");
  assert.notEqual(rocketIndex, -1);
  const index = JSON.parse(
    r2.objects.get("software/indexes/hub.json")!.toString("utf8"),
  );
  const file = index.artifacts[0].files[0];
  assert.deepEqual(runs[0].args.slice(rocketIndex), [
    "rocket",
    "deploy",
    "prod",
    "--scope",
    "hub",
    "--bundle-url",
    file.url,
    "--bundle-sha256",
    file.sha256,
    "--remote",
    "ubuntu@10.206.0.38",
    "--api",
    "https://cocalc.ai",
    "--yes",
  ]);
});

test("software deploy records failed history when subprocess fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-deploy-failed-history-"));
  const localStore = join(dir, "store");
  const source = join(dir, "hub.tar.xz");
  writeFileSync(source, "hub bundle");
  const runs: CapturedRun[] = [];
  const r2 = makeR2Client();
  const deps = makeDeps({
    localStore,
    runs,
    env: r2Env,
    r2Client: r2.client,
  });
  deps.runCommand = async (command, args) => {
    runs.push({ command, args });
    if (args.includes("deploy")) {
      return 7;
    }
    const bundle = args.at(-1);
    if (bundle) {
      mkdirSync(join(bundle, ".."), { recursive: true });
      writeFileSync(bundle, "built bundle");
    }
    return 0;
  };
  const program = createProgram(deps);

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "hub",
    "fail-deploy",
    "--from-file",
    source,
  ]);
  await assert.rejects(
    async () =>
      await program.parseAsync([
        "node",
        "test",
        "--quiet",
        "software",
        "deploy",
        "hub",
        "fail-deploy",
        "prod",
        "--env-file",
        join(dir, "missing.env"),
      ]),
    /failed with exit status 7/,
  );

  const history = JSON.parse(
    r2.objects
      .get("software/deployments/prod/hub/index.json")!
      .toString("utf8"),
  );
  assert.equal(history.deployments[0].status, "failed");
  assert.match(history.deployments[0].error, /exit status 7/);
});

test("software deploy bay uses the full bay Rocket scope", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-deploy-bay-"));
  const localStore = join(dir, "store");
  const source = join(dir, "bay.tar.xz");
  writeFileSync(source, "bay bundle");
  const runs: CapturedRun[] = [];
  const r2 = makeR2Client();
  const program = createProgram(
    makeDeps({ localStore, runs, env: r2Env, r2Client: r2.client }),
  );

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "bay",
    "full-deploy",
    "--from-file",
    source,
  ]);
  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "deploy",
    "bay",
    "full-deploy",
    "prod",
    "--env-file",
    join(dir, "missing.env"),
  ]);

  assert.equal(runs.length, 1);
  const rocketIndex = runs[0].args.indexOf("rocket");
  assert.notEqual(rocketIndex, -1);
  const index = JSON.parse(
    r2.objects.get("software/indexes/bay.json")!.toString("utf8"),
  );
  const file = index.artifacts[0].files[0];
  assert.deepEqual(runs[0].args.slice(rocketIndex), [
    "rocket",
    "deploy",
    "prod",
    "--scope",
    "bay",
    "--bundle-url",
    file.url,
    "--bundle-sha256",
    file.sha256,
    "--remote",
    "ubuntu@10.206.0.38",
    "--api",
    "https://cocalc.ai",
    "--yes",
  ]);
});

test("software deploy project-host publishes compatibility object and runs host upgrade", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-deploy-project-host-"));
  const localStore = join(dir, "store");
  const source = join(dir, "bundle-linux.tar.xz");
  writeFileSync(source, "project host bundle");
  const runs: CapturedRun[] = [];
  const r2 = makeR2Client();
  const program = createProgram(
    makeDeps({ localStore, runs, env: r2Env, r2Client: r2.client }),
  );
  const originalArgv1 = process.argv[1];
  process.argv[1] = "software";

  try {
    await program.parseAsync([
      "node",
      "test",
      "--quiet",
      "software",
      "build",
      "project-host",
      "host-deploy",
      "--from-file",
      source,
      "--artifact-name",
      "bundle-linux.tar.xz",
    ]);
    await program.parseAsync([
      "node",
      "test",
      "--quiet",
      "software",
      "deploy",
      "project-host",
      "host-deploy",
      "staging",
      "--env-file",
      join(dir, "missing.env"),
    ]);
  } finally {
    process.argv[1] = originalArgv1;
  }

  const artifactId = "20260614T235912Z-e882d124-host-deploy";
  assert.equal(
    r2.objects.has(`software/project-host/${artifactId}/bundle-linux.tar.xz`),
    true,
  );
  assert.equal(
    r2.objects.has(
      `software/project-host/${artifactId}/bundle-linux.tar.xz.sha256`,
    ),
    true,
  );
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].args, [
    "--profile",
    "staging",
    "host",
    "upgrade",
    "--all-online",
    "--artifact",
    "project-host",
    "--artifact-version",
    artifactId,
    "--base-url",
    "https://software.example.test/software",
    "--wait",
  ]);
  const history = JSON.parse(
    r2.objects
      .get("software/deployments/staging/project-host/index.json")!
      .toString("utf8"),
  );
  assert.equal(history.deployments[0].status, "succeeded");
  assert.equal(history.deployments[0].artifact_id, artifactId);
});

test("software deploy tools publishes both architecture compatibility objects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-deploy-tools-"));
  const localStore = join(dir, "store");
  const runs: CapturedRun[] = [];
  const r2 = makeR2Client();
  const program = createProgram(
    makeDeps({ localStore, runs, cwd: dir, env: r2Env, r2Client: r2.client }),
  );
  const originalArgv1 = process.argv[1];
  process.argv[1] = "software";

  try {
    await program.parseAsync([
      "node",
      "test",
      "--quiet",
      "software",
      "build",
      "tools",
      "tools-deploy",
    ]);
    await program.parseAsync([
      "node",
      "test",
      "--quiet",
      "software",
      "deploy",
      "tools",
      "tools-deploy",
      "staging",
      "--env-file",
      join(dir, "missing.env"),
    ]);
  } finally {
    process.argv[1] = originalArgv1;
  }

  const artifactId = "20260614T235912Z-e882d124-tools-deploy";
  for (const arch of ["amd64", "arm64"]) {
    assert.equal(
      r2.objects.has(`software/tools/${artifactId}/tools-linux-${arch}.tar.xz`),
      true,
    );
    assert.equal(
      r2.objects.has(
        `software/tools/${artifactId}/tools-linux-${arch}.tar.xz.sha256`,
      ),
      true,
    );
  }
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[1].args, [
    "--profile",
    "staging",
    "host",
    "upgrade",
    "--all-online",
    "--artifact",
    "tools",
    "--artifact-version",
    artifactId,
    "--base-url",
    "https://software.example.test/software",
    "--wait",
  ]);
  const history = JSON.parse(
    r2.objects
      .get("software/deployments/staging/tools/index.json")!
      .toString("utf8"),
  );
  assert.equal(history.deployments[0].status, "succeeded");
  assert.equal(history.deployments[0].artifact_id, artifactId);
});

test("software deploy bay-conat-router uses bay artifact and one-service Rocket flag", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-deploy-bay-router-"));
  const localStore = join(dir, "store");
  const source = join(dir, "bay.tar.xz");
  writeFileSync(source, "bay bundle");
  const runs: CapturedRun[] = [];
  const r2 = makeR2Client();
  const program = createProgram(
    makeDeps({ localStore, runs, env: r2Env, r2Client: r2.client }),
  );

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "bay",
    "router-deploy",
    "--from-file",
    source,
  ]);
  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "deploy",
    "bay-conat-router",
    "router-deploy",
    "prod",
    "--env-file",
    join(dir, "missing.env"),
  ]);

  const rocketIndex = runs[0].args.indexOf("rocket");
  assert.notEqual(rocketIndex, -1);
  assert.deepEqual(runs[0].args.slice(-5), [
    "--api",
    "https://cocalc.ai",
    "--bay-service",
    "conat-router",
    "--yes",
  ]);
  const history = JSON.parse(
    r2.objects
      .get("software/deployments/prod/bay-conat-router/index.json")!
      .toString("utf8"),
  );
  assert.equal(history.deployments[0].artifact_component, "bay");
  assert.equal(history.deployments[0].target.kind, "rocket-bay");
});

test("software deploy bay-scaffold uses bay artifact and scaffold-only Rocket flag", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-deploy-bay-scaffold-"));
  const localStore = join(dir, "store");
  const source = join(dir, "bay.tar.xz");
  writeFileSync(source, "bay bundle");
  const runs: CapturedRun[] = [];
  const r2 = makeR2Client();
  const program = createProgram(
    makeDeps({ localStore, runs, env: r2Env, r2Client: r2.client }),
  );

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "bay",
    "scaffold-deploy",
    "--from-file",
    source,
  ]);
  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "deploy",
    "bay-scaffold",
    "scaffold-deploy",
    "staging",
    "--env-file",
    join(dir, "missing.env"),
  ]);

  assert.deepEqual(runs[0].args.slice(-4), [
    "--api",
    "https://staging.cocalc.ai",
    "--scaffold-only",
    "--yes",
  ]);
});

test("software deploy host-conat-router installs project-host artifact and reconciles one component", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-deploy-host-router-"));
  const localStore = join(dir, "store");
  const source = join(dir, "project-host.tar.xz");
  writeFileSync(source, "project host bundle");
  const runs: CapturedRun[] = [];
  const r2 = makeR2Client();
  const program = createProgram(
    makeDeps({ localStore, runs, env: r2Env, r2Client: r2.client }),
  );

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "project-host",
    "host-router-deploy",
    "--from-file",
    source,
  ]);
  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "deploy",
    "host-conat-router",
    "host-router-deploy",
    "staging",
    "--env-file",
    join(dir, "missing.env"),
  ]);

  const artifactId = JSON.parse(
    r2.objects.get("software/indexes/project-host.json")!.toString("utf8"),
  ).artifacts[0].artifact_id;

  assert.equal(runs.length, 3);
  assert.deepEqual(runs[0].args.slice(-12), [
    "--profile",
    "staging",
    "host",
    "upgrade",
    "--all-online",
    "--artifact",
    "project-host",
    "--artifact-version",
    artifactId,
    "--base-url",
    "https://software.example.test/software",
    "--wait",
  ]);
  assert.deepEqual(runs[1].args.slice(-14), [
    "--profile",
    "staging",
    "host",
    "deploy",
    "set",
    "--global",
    "--component",
    "conat-router",
    "--desired-version",
    artifactId,
    "--policy",
    "restart_now",
    "--reason",
    "software-deploy-host-conat-router",
  ]);
  assert.deepEqual(runs[2].args.slice(-11), [
    "--profile",
    "staging",
    "host",
    "deploy",
    "reconcile",
    "--all-online",
    "--component",
    "conat-router",
    "--reason",
    "software-deploy-host-conat-router",
    "--wait",
  ]);

  const history = JSON.parse(
    r2.objects
      .get("software/deployments/staging/host-conat-router/index.json")!
      .toString("utf8"),
  );
  assert.equal(history.deployments[0].artifact_component, "project-host");
  assert.equal(history.deployments[0].target.kind, "project-host-fleet");
});

test("software smoke static runs HTTP checks against the profile API", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-smoke-static-"));
  const urls: string[] = [];
  const program = createProgram(
    makeDeps({
      localStore: join(dir, "store"),
      fetch: async (input) => {
        urls.push(`${input}`);
        return { ok: true, status: 200 } as Response;
      },
    }),
  );

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "smoke",
    "static",
    "staging",
  ]);

  assert.deepEqual(urls, [
    "https://staging.cocalc.ai/",
    "https://staging.cocalc.ai/static/app.html",
    "https://staging.cocalc.ai/webapp/favicon.ico",
    "https://staging.cocalc.ai/api/v2/auth/bootstrap",
  ]);
});

test("software smoke hub also runs Rocket host route health", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-smoke-hub-"));
  const runs: CapturedRun[] = [];
  const program = createProgram(
    makeDeps({
      localStore: join(dir, "store"),
      runs,
      fetch: async () => ({ ok: true, status: 200 }) as Response,
    }),
  );

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "smoke",
    "hub",
    "prod",
  ]);

  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].args.slice(-7), [
    "--profile",
    "prod",
    "rocket",
    "health",
    "host-routes",
    "--api",
    "https://cocalc.ai",
  ]);
});

test("software smoke project-host validates representative host status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-smoke-project-host-"));
  const hostListRun: CapturedOutputRun = {
    command: "",
    args: [],
    stdout: JSON.stringify({
      ok: true,
      data: [
        {
          host_id: "host-1",
          name: "host one",
          status: "running",
        },
      ],
    }),
    stderr: "",
  };
  const deployStatusRun: CapturedOutputRun = {
    command: "",
    args: [],
    stdout: JSON.stringify({
      ok: true,
      data: {
        observed_artifacts: [
          {
            artifact: "project-host",
            current_version: "20260615T000000Z-test",
          },
        ],
        observed_components: [
          {
            component: "project-host",
            runtime_state: "running",
            version_state: "aligned",
          },
        ],
        observed_host_agent: {
          project_host: {
            rollout: { healthy: true },
          },
        },
      },
    }),
    stderr: "",
  };
  const rootfsRun: CapturedOutputRun = {
    command: "",
    args: [],
    stdout: JSON.stringify({
      ok: true,
      data: { summary: { total: 2 } },
    }),
    stderr: "",
  };
  const program = createProgram(
    makeDeps({
      localStore: join(dir, "store"),
      outputRuns: [hostListRun, deployStatusRun, rootfsRun],
    }),
  );

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "smoke",
    "project-host",
    "staging",
    "--host",
    "host-1",
  ]);

  assert.deepEqual(hostListRun.args.slice(-8), [
    "--profile",
    "staging",
    "--output",
    "json",
    "host",
    "list",
    "--limit",
    "500",
  ]);
  assert.deepEqual(deployStatusRun.args.slice(-8), [
    "--profile",
    "staging",
    "--output",
    "json",
    "host",
    "deploy",
    "status",
    "host-1",
  ]);
  assert.deepEqual(rootfsRun.args.slice(-7), [
    "--profile",
    "staging",
    "--output",
    "json",
    "host",
    "rootfs",
    "host-1",
  ]);
});

test("software smoke project validates project bundle artifact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-smoke-project-"));
  const outputRuns: CapturedOutputRun[] = [
    {
      command: "",
      args: [],
      stdout: JSON.stringify({
        ok: true,
        data: [{ host_id: "host-1", name: "host one", status: "running" }],
      }),
      stderr: "",
    },
    {
      command: "",
      args: [],
      stdout: JSON.stringify({
        ok: true,
        data: {
          observed_artifacts: [
            { artifact: "project-bundle", current_version: "1781500000000" },
          ],
        },
      }),
      stderr: "",
    },
    {
      command: "",
      args: [],
      stdout: JSON.stringify({ ok: true, data: { summary: { total: 0 } } }),
      stderr: "",
    },
  ];
  const program = createProgram(
    makeDeps({ localStore: join(dir, "store"), outputRuns }),
  );

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "smoke",
    "project",
    "staging",
  ]);
});

test("software smoke rejects components that are not wired yet", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-smoke-unwired-"));
  const program = createProgram(makeDeps({ localStore: join(dir, "store") }));

  await assert.rejects(
    async () =>
      await program.parseAsync([
        "node",
        "test",
        "software",
        "smoke",
        "cli",
        "staging",
      ]),
    /software smoke cli is not implemented yet/,
  );
});

test("software push rejects remote duplicate tags", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-push-duplicate-"));
  const localStore = join(dir, "store");
  const source = join(dir, "artifact.tar.xz");
  writeFileSync(source, "artifact contents");
  const existingIndex = {
    schema: "cocalc-software-index-v1",
    component: "hub",
    generated_at: "2026-06-14T00:00:00.000Z",
    artifacts: [
      {
        artifact_id: "old",
        tag: "push-test",
        tag_generated: false,
        timestamp: "2026-06-14T00:00:00.000Z",
        git: { commit: "old", short: "old", dirty: false },
        manifest_key: "old",
        manifest_url: "old",
        files: [],
      },
    ],
  };
  const r2 = makeR2Client(
    new Map([
      [
        "software/indexes/hub.json",
        Buffer.from(JSON.stringify(existingIndex), "utf8"),
      ],
    ]),
  );
  const program = createProgram(
    makeDeps({ localStore, env: r2Env, r2Client: r2.client }),
  );

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "hub",
    "push-test",
    "--from-file",
    source,
  ]);

  await assert.rejects(
    async () =>
      await program.parseAsync([
        "node",
        "test",
        "software",
        "push",
        "hub",
        "push-test",
        "--env-file",
        join(dir, "missing.env"),
      ]),
    /remote software artifact already exists/,
  );
});
