import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

function testSeaSuffix(): { machine: string; os: string } {
  return {
    machine:
      process.arch === "x64"
        ? "x86_64"
        : process.arch === "arm64" && process.platform === "linux"
          ? "aarch64"
          : process.arch,
    os: process.platform,
  };
}

function makeRepoRoot(prefix = "software-repo-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeDeps({
  localStore,
  runs,
  cwd,
  repoRoot,
  env,
  r2Client,
  loadAuthConfig,
  fetch,
  outputRuns,
  now,
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
  now?: () => Date;
}): SoftwareCommandDeps {
  const resolvedRepoRoot = repoRoot ?? makeRepoRoot();
  const resolvedCwd = cwd ?? resolvedRepoRoot;
  return {
    cwd: resolvedCwd,
    env: { COCALC_SOFTWARE_LOCAL_STORE: localStore, ...env },
    now: now ?? (() => new Date("2026-06-14T23:59:12.345Z")),
    gitMetadata: () => ({
      commit: "e882d124c7abcdef",
      short: "e882d124c7ab",
      branch: "lite4",
      dirty: false,
      status_porcelain: "",
    }),
    repoRoot: () => resolvedRepoRoot,
    runCommand: async (command, args, options) => {
      runs?.push({ command, args });
      let bundle = command === "pnpm" ? args.at(-1) : undefined;
      const artifactId =
        options?.env?.COCALC_SOFTWARE_ARTIFACT_ID ??
        env?.COCALC_SOFTWARE_ARTIFACT_ID;
      const { machine, os } = testSeaSuffix();
      if (command === "pnpm" && args.includes("@cocalc/project-host")) {
        bundle = join(
          resolvedRepoRoot,
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
          resolvedRepoRoot,
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
            resolvedRepoRoot,
            "src",
            "packages",
            "project",
            "build",
            `tools-linux-${arch}.tar.xz`,
          );
          mkdirSync(join(toolsBundle, ".."), { recursive: true });
          writeFileSync(toolsBundle, `built tools bundle ${arch}`);
        }
      } else if (
        command === "pnpm" &&
        args.includes("@cocalc/project") &&
        args.includes("build:tools-minimal")
      ) {
        bundle = undefined;
        for (const [os, arch] of [
          ["linux", "amd64"],
          ["linux", "arm64"],
          ["darwin", "arm64"],
        ] as const) {
          const toolsBundle = join(
            resolvedRepoRoot,
            "src",
            "packages",
            "project",
            "build",
            `tools-minimal-${os}-${arch}.tar.xz`,
          );
          mkdirSync(join(toolsBundle, ".."), { recursive: true });
          writeFileSync(
            toolsBundle,
            `built tools-minimal bundle ${os} ${arch}`,
          );
        }
      } else if (
        command === "pnpm" &&
        args.includes("@cocalc/cli") &&
        artifactId
      ) {
        bundle = join(
          resolvedRepoRoot,
          "src",
          "packages",
          "cli",
          "build",
          "sea",
          `cocalc-cli-${artifactId}-${machine}-${os}`,
        );
      } else if (
        command === "pnpm" &&
        args.includes("@cocalc/launchpad") &&
        artifactId
      ) {
        bundle = join(
          resolvedRepoRoot,
          "src",
          "packages",
          "launchpad",
          "build",
          "sea",
          `cocalc-launchpad-${artifactId}-${machine}-${os}.tar.xz`,
        );
      } else if (
        command === "pnpm" &&
        args.includes("@cocalc/plus") &&
        artifactId
      ) {
        bundle = join(
          resolvedRepoRoot,
          "src",
          "packages",
          "plus",
          "build",
          "sea",
          `cocalc-plus-${artifactId}-${machine}-${os}`,
        );
      } else if (command.endsWith("build-github-release-assets.sh")) {
        const outDir = args[0];
        mkdirSync(outDir, { recursive: true });
        for (const name of [
          "install-cocalc-star.sh",
          "install-cocalc-star-local-lima.sh",
          "cocalc-star-runtime-linux-x64.tar.gz",
          "cocalc-star-runtime-linux-arm64.tar.gz",
          "SHA256SUMS",
          "release-notes.md",
        ]) {
          writeFileSync(join(outDir, name), `star ${name}`);
        }
        return 0;
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

function arrayBufferForBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

function createProgram(deps: SoftwareCommandDeps): Command {
  const program = new Command();
  program.exitOverride();
  program.option("--json", "output machine-readable JSON");
  program.option("--output <format>", "output format", "table");
  program.option("-q, --quiet", "suppress human-formatted success output");
  registerSoftwareCommand(program, deps);
  return program;
}

function deploymentHistoryObjects({
  component,
  profileOrChannel,
  artifactId,
  tag = "rollback-target",
  status = "succeeded",
  details,
}: {
  component: string;
  profileOrChannel: string;
  artifactId: string;
  tag?: string;
  status?: "started" | "succeeded" | "failed";
  details?: Record<string, unknown>;
}): Map<string, Buffer> {
  const deploymentId = `20260615T000000Z-${artifactId}`;
  const recordKey = `software/deployments/${profileOrChannel}/${component}/${deploymentId}.json`;
  const record = {
    schema: "cocalc-software-deployment-v1",
    deployment_id: deploymentId,
    component,
    artifact_component: component === "bay-conat-router" ? "bay" : component,
    profile_or_channel: profileOrChannel,
    started_at: "2026-06-15T00:00:00.000Z",
    updated_at: "2026-06-15T00:00:01.000Z",
    finished_at: status === "started" ? undefined : "2026-06-15T00:00:01.000Z",
    artifact_id: artifactId,
    tag,
    git: { commit: "abcdef123456", short: "abcdef12", dirty: false },
    deployed_by: { user: "operator" },
    target: {
      kind:
        component === "cli" || component === "plus"
          ? "release-channel"
          : "rocket-bay",
      ...(component === "cli" || component === "plus"
        ? { channel: profileOrChannel }
        : { profile: profileOrChannel }),
    },
    status,
    duration_ms: status === "started" ? undefined : 1000,
    details,
  };
  const entry = {
    deployment_id: deploymentId,
    component,
    artifact_component: record.artifact_component,
    profile_or_channel: profileOrChannel,
    started_at: record.started_at,
    updated_at: record.updated_at,
    finished_at: record.finished_at,
    artifact_id: artifactId,
    tag,
    git: record.git,
    deployed_by: record.deployed_by,
    target: record.target,
    status,
    duration_ms: record.duration_ms,
    record_key: recordKey,
    record_url: `https://software.example.test/${recordKey}`,
  };
  return new Map([
    [recordKey, Buffer.from(JSON.stringify(record), "utf8")],
    [
      `software/deployments/${profileOrChannel}/${component}/index.json`,
      Buffer.from(
        JSON.stringify({
          schema: "cocalc-software-deployment-index-v1",
          component,
          profile_or_channel: profileOrChannel,
          generated_at: "2026-06-15T00:00:02.000Z",
          deployments: [entry],
        }),
        "utf8",
      ),
    ],
  ]);
}

test("software help lists supported components", () => {
  const program = createProgram(makeDeps({ localStore: "/tmp/software-help" }));
  const software = program.commands.find(
    (command) => command.name() === "software",
  );
  assert.ok(software);
  const build = software.commands.find((command) => command.name() === "build");
  const info = software.commands.find((command) => command.name() === "info");
  const list = software.commands.find((command) => command.name() === "list");
  const deploy = software.commands.find(
    (command) => command.name() === "deploy",
  );
  assert.ok(build);
  assert.ok(info);
  assert.ok(list);
  assert.ok(deploy);
  assert.match(info.helpInformation(), /tools-minimal/);
  assert.match(build.helpInformation(), /static\|hub\|bay\|project-host/);
  assert.match(list.helpInformation(), /cli\|launchpad\|plus\|star/);
  assert.match(deploy.helpInformation(), /bay-conat-router/);
  assert.match(deploy.helpInformation(), /--build/);
  assert.match(
    deploy.helpInformation(),
    /site profile \(see cocalc auth list\) or release\s+channel \(dev, candidate or stable\)/,
  );
  assert.doesNotMatch(deploy.helpInformation(), /hub-conat-router/);
});

test("software info prints an overview for humans", async () => {
  const program = createProgram(makeDeps({ localStore: "/tmp/software-info" }));
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    logs.push(String(value ?? ""));
  };
  try {
    await program.parseAsync(["node", "test", "software", "info"]);
  } finally {
    console.log = originalLog;
  }

  const output = logs.join("\n");
  assert.match(output, /# cocalc software info/);
  assert.match(output, /Build\/list\/push components:/);
  assert.match(output, /tools-minimal/);
  assert.match(output, /rollback/);
});

test("software info prints component docs for humans", async () => {
  const program = createProgram(makeDeps({ localStore: "/tmp/software-info" }));
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    logs.push(String(value ?? ""));
  };
  try {
    await program.parseAsync(["node", "test", "software", "info", "plus"]);
  } finally {
    console.log = originalLog;
  }

  const output = logs.join("\n");
  assert.match(output, /# cocalc software info plus/);
  assert.match(output, /CoCalc Plus - .*tools-minimal/);
  assert.match(output, /tools-minimal/);
  assert.match(output, /--tools-minimal/);
  assert.match(output, /cocalc-plus/);
});

test("software info emits agent-oriented json", async () => {
  const program = createProgram(makeDeps({ localStore: "/tmp/software-info" }));
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
      "info",
      "plus",
    ]);
  } finally {
    console.log = originalLog;
  }

  const payload = JSON.parse(logs.at(-1) ?? "{}");
  assert.equal(payload.ok, true);
  assert.equal(payload.command, "software info");
  assert.equal(payload.data.schema, "cocalc-software-info-v1");
  assert.equal(payload.data.audience, "agent");
  assert.equal(payload.data.component.component, "plus");
  assert.equal(payload.data.component.target_kind, "release-channel");
  assert.match(payload.data.component.description, /tools-minimal/);
  assert.deepEqual(payload.data.component.related_components, [
    "tools-minimal",
  ]);
  assert.match(payload.data.component.agent_notes.join("\n"), /tools-minimal/);
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
  const repoRoot = makeRepoRoot("software-hub-repo-");
  const runs: CapturedRun[] = [];
  const program = createProgram(makeDeps({ localStore, repoRoot, runs }));

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "hub:runtime-test",
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].command, "pnpm");
  assert.deepEqual(runs[0].args.slice(0, 4), [
    "-C",
    join(repoRoot, "src", "packages"),
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
  const repoRoot = makeRepoRoot("software-subdir-repo-");
  const runs: CapturedRun[] = [];
  const program = createProgram(
    makeDeps({
      localStore,
      runs,
      cwd: join(repoRoot, "src", "packages", "cli"),
      repoRoot,
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
    join(repoRoot, "src", "packages"),
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
  assert.equal(manifest.source.repo_root, repoRoot);
  assert.equal(manifest.source.src_root, join(repoRoot, "src"));
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

test("software build tools-minimal runs the package minimal tools builder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-tools-minimal-build-"));
  const localStore = join(dir, "store");
  const runs: CapturedRun[] = [];
  const program = createProgram(makeDeps({ localStore, runs, cwd: dir }));

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "tools-minimal",
    "tools-minimal-test",
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].args.includes("@cocalc/project"), true);
  assert.equal(runs[0].args.includes("build:tools-minimal"), true);
  for (const [os, arch] of [
    ["linux", "amd64"],
    ["linux", "arm64"],
    ["darwin", "arm64"],
  ] as const) {
    assert.equal(
      existsSync(
        join(
          localStore,
          "tools-minimal",
          "20260614T235912Z-e882d124-tools-minimal-test",
          "files",
          `tools-minimal-${os}-${arch}.tar.xz`,
        ),
      ),
      true,
    );
  }
});

test("software build cli uses the software artifact id as the SEA version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-cli-build-"));
  const localStore = join(dir, "store");
  const runs: CapturedRun[] = [];
  const program = createProgram(makeDeps({ localStore, runs, cwd: dir }));
  const artifactId = "20260614T235912Z-e882d124-cli-test";
  const { machine, os } = testSeaSuffix();
  const artifactName = `cocalc-cli-${artifactId}-${machine}-${os}`;

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "cli",
    "cli-test",
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].args.includes("@cocalc/cli"), true);
  assert.equal(runs[0].args.includes("sea"), true);
  assert.equal(
    existsSync(join(localStore, "cli", artifactId, "files", artifactName)),
    true,
  );
});

test("software build launchpad uses the software artifact id as the SEA version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-launchpad-build-"));
  const localStore = join(dir, "store");
  const runs: CapturedRun[] = [];
  const program = createProgram(makeDeps({ localStore, runs, cwd: dir }));
  const artifactId = "20260614T235912Z-e882d124-launchpad-test";
  const { machine, os } = testSeaSuffix();
  const artifactName = `cocalc-launchpad-${artifactId}-${machine}-${os}.tar.xz`;

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "launchpad",
    "launchpad-test",
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].args.includes("@cocalc/launchpad"), true);
  assert.equal(
    existsSync(
      join(localStore, "launchpad", artifactId, "files", artifactName),
    ),
    true,
  );
});

test("software build plus uses the software artifact id as the SEA version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-plus-build-"));
  const localStore = join(dir, "store");
  const runs: CapturedRun[] = [];
  const program = createProgram(makeDeps({ localStore, runs, cwd: dir }));
  const artifactId = "20260614T235912Z-e882d124-plus-test";
  const { machine, os } = testSeaSuffix();
  const artifactName = `cocalc-plus-${artifactId}-${machine}-${os}`;

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "plus",
    "plus-test",
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].args.includes("@cocalc/plus"), true);
  assert.equal(
    existsSync(join(localStore, "plus", artifactId, "files", artifactName)),
    true,
  );
});

test("software build star records GitHub release assets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-star-build-"));
  const localStore = join(dir, "store");
  const runs: CapturedRun[] = [];
  const program = createProgram(makeDeps({ localStore, runs, cwd: dir }));
  const artifactId = "20260614T235912Z-e882d124-star-test";

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "star",
    "star-test",
  ]);

  assert.equal(runs.length, 1);
  assert.equal(
    runs[0].command.endsWith("build-github-release-assets.sh"),
    true,
  );
  for (const name of [
    "install-cocalc-star.sh",
    "install-cocalc-star-local-lima.sh",
    "cocalc-star-runtime-linux-x64.tar.gz",
    "cocalc-star-runtime-linux-arm64.tar.gz",
    "SHA256SUMS",
    "release-notes.md",
  ]) {
    assert.equal(
      existsSync(join(localStore, "star", artifactId, "files", name)),
      true,
    );
  }
});

test("software build allows duplicate explicit local tags", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-duplicate-"));
  const localStore = join(dir, "store");
  const source = join(dir, "artifact.tar.xz");
  writeFileSync(source, "artifact contents");
  let nowCalls = 0;
  const program = createProgram(
    makeDeps({
      localStore,
      now: () => new Date(1781481552345 + nowCalls++ * 60_000),
    }),
  );

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

  const manifests = JSON.parse(
    readFileSync(
      join(
        localStore,
        "hub",
        "20260615T000112Z-e882d124-fix-bug",
        "manifest.json",
      ),
      "utf8",
    ),
  );
  assert.equal(manifests.tag, "fix-bug");
  assert.equal(
    existsSync(
      join(
        localStore,
        "hub",
        "20260614T235912Z-e882d124-fix-bug",
        "manifest.json",
      ),
    ),
    true,
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
      "hub:push-test",
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

test("software deploy static accepts comma-separated profiles", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-deploy-static-multi-"));
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
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    logs.push(String(value ?? ""));
  };

  try {
    await program.parseAsync([
      "node",
      "test",
      "--quiet",
      "software",
      "build",
      "static:multi-deploy",
      "--from-file",
      source,
    ]);
    await program.parseAsync([
      "node",
      "test",
      "--json",
      "software",
      "deploy",
      "static:multi-deploy",
      "staging,prod",
      "--env-file",
      join(dir, "missing.env"),
    ]);
  } finally {
    console.log = originalLog;
    process.argv[1] = originalArgv1;
  }

  assert.equal(runs.length, 2);
  const firstRocket = runs[0].args.slice(runs[0].args.indexOf("rocket"));
  const secondRocket = runs[1].args.slice(runs[1].args.indexOf("rocket"));
  assert.equal(firstRocket[2], "staging");
  assert.deepEqual(
    firstRocket.slice(
      firstRocket.indexOf("--remote"),
      firstRocket.indexOf("--remote") + 2,
    ),
    ["--remote", "ubuntu@10.206.0.27"],
  );
  assert.equal(secondRocket[2], "prod");
  assert.deepEqual(
    secondRocket.slice(
      secondRocket.indexOf("--remote"),
      secondRocket.indexOf("--remote") + 2,
    ),
    ["--remote", "ubuntu@10.206.0.38"],
  );
  const payload = JSON.parse(logs.at(-1) ?? "{}");
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.data.targets, ["staging", "prod"]);
  assert.equal(payload.data.deployments.length, 2);
  assert.equal(payload.data.deployments[0].profile, "staging");
  assert.equal(payload.data.deployments[1].profile, "prod");
  const stagingHistory = JSON.parse(
    r2.objects
      .get("software/deployments/staging/static/index.json")!
      .toString("utf8"),
  );
  const prodHistory = JSON.parse(
    r2.objects
      .get("software/deployments/prod/static/index.json")!
      .toString("utf8"),
  );
  assert.equal(
    stagingHistory.deployments[0].artifact_id,
    payload.data.artifact_id,
  );
  assert.equal(
    prodHistory.deployments[0].artifact_id,
    payload.data.artifact_id,
  );
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

test("software rollback redeploys a successful historical artifact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-rollback-static-"));
  const artifactId = "20260614T235912Z-e882d124-old-static";
  const r2 = makeR2Client(
    deploymentHistoryObjects({
      component: "static",
      profileOrChannel: "staging",
      artifactId,
      tag: "old-static",
    }),
  );
  const runs: CapturedRun[] = [];
  const program = createProgram(
    makeDeps({
      localStore: join(dir, "store"),
      runs,
      env: r2Env,
      r2Client: r2.client,
    }),
  );

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "rollback",
    "static",
    "staging",
    artifactId,
    "--env-file",
    join(dir, "missing.env"),
  ]);

  assert.equal(runs.length, 1);
  const softwareIndex = runs[0].args.indexOf("software");
  assert.notEqual(softwareIndex, -1);
  assert.deepEqual(runs[0].args.slice(softwareIndex), [
    "software",
    "deploy",
    "static",
    artifactId,
    "staging",
    "--env-file",
    join(dir, "missing.env"),
  ]);
  assert.equal(runs[0].args.includes("--quiet"), true);
});

test("software rollback plus reuses historical tools-minimal artifact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-rollback-plus-"));
  const artifactId = "20260614T235912Z-e882d124-old-plus";
  const toolsArtifactId = "20260614T235912Z-e882d124-old-tools-minimal";
  const r2 = makeR2Client(
    deploymentHistoryObjects({
      component: "plus",
      profileOrChannel: "candidate",
      artifactId,
      tag: "old-plus",
      details: {
        tools_minimal: {
          artifact_id: toolsArtifactId,
        },
      },
    }),
  );
  const runs: CapturedRun[] = [];
  const program = createProgram(
    makeDeps({
      localStore: join(dir, "store"),
      runs,
      env: r2Env,
      r2Client: r2.client,
    }),
  );

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "rollback",
    "plus",
    "candidate",
    artifactId,
    "--env-file",
    join(dir, "missing.env"),
  ]);

  const softwareIndex = runs[0].args.indexOf("software");
  assert.deepEqual(runs[0].args.slice(softwareIndex), [
    "software",
    "deploy",
    "plus",
    artifactId,
    "candidate",
    "--env-file",
    join(dir, "missing.env"),
    "--tools-minimal",
    toolsArtifactId,
  ]);
});

test("software rollback rejects artifacts without successful history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-rollback-no-success-"));
  const artifactId = "20260614T235912Z-e882d124-failed-static";
  const r2 = makeR2Client(
    deploymentHistoryObjects({
      component: "static",
      profileOrChannel: "staging",
      artifactId,
      status: "failed",
    }),
  );
  const runs: CapturedRun[] = [];
  const program = createProgram(
    makeDeps({
      localStore: join(dir, "store"),
      runs,
      env: r2Env,
      r2Client: r2.client,
    }),
  );

  await assert.rejects(
    async () =>
      await program.parseAsync([
        "node",
        "test",
        "--quiet",
        "software",
        "rollback",
        "static",
        "staging",
        artifactId,
        "--env-file",
        join(dir, "missing.env"),
      ]),
    /has no succeeded deployment/,
  );
  assert.equal(runs.length, 0);
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

test("software deploy component tag chooses the newest duplicate remote tag", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-deploy-dup-tag-"));
  const localStore = join(dir, "store");
  const runs: CapturedRun[] = [];
  const oldFileKey =
    "software/artifacts/static/20260614T000000Z-abcdef12-dup/files/static-old.tar.xz";
  const newFileKey =
    "software/artifacts/static/20260615T000000Z-abcdef12-dup/files/static-new.tar.xz";
  const remoteIndex = {
    schema: "cocalc-software-index-v1",
    component: "static",
    generated_at: "2026-06-15T00:00:00.000Z",
    artifacts: [
      {
        artifact_id: "20260614T000000Z-abcdef12-dup",
        tag: "dup",
        tag_generated: false,
        timestamp: "2026-06-14T00:00:00.000Z",
        git: { commit: "abcdef123456", short: "abcdef123456", dirty: false },
        manifest_key:
          "software/artifacts/static/20260614T000000Z-abcdef12-dup/manifest.json",
        manifest_url:
          "https://software.example.test/software/artifacts/static/20260614T000000Z-abcdef12-dup/manifest.json",
        files: [
          {
            name: "static-old.tar.xz",
            size_bytes: "old static bundle".length,
            sha256: "old",
            key: oldFileKey,
            url: `https://software.example.test/${oldFileKey}`,
          },
        ],
      },
      {
        artifact_id: "20260615T000000Z-abcdef12-dup",
        tag: "dup",
        tag_generated: false,
        timestamp: "2026-06-15T00:00:00.000Z",
        git: { commit: "abcdef123456", short: "abcdef123456", dirty: false },
        manifest_key:
          "software/artifacts/static/20260615T000000Z-abcdef12-dup/manifest.json",
        manifest_url:
          "https://software.example.test/software/artifacts/static/20260615T000000Z-abcdef12-dup/manifest.json",
        files: [
          {
            name: "static-new.tar.xz",
            size_bytes: "new static bundle".length,
            sha256: "new",
            key: newFileKey,
            url: `https://software.example.test/${newFileKey}`,
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
      [oldFileKey, Buffer.from("old static bundle", "utf8")],
      [newFileKey, Buffer.from("new static bundle", "utf8")],
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
    "deploy",
    "static:dup",
    "staging",
    "--env-file",
    join(dir, "missing.env"),
  ]);

  const rocketIndex = runs[0].args.indexOf("rocket");
  assert.notEqual(rocketIndex, -1);
  const rocketArgs = runs[0].args.slice(rocketIndex);
  assert.equal(rocketArgs[6], `https://software.example.test/${newFileKey}`);
  assert.equal(rocketArgs[8], "new");
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

test("software deploy --build builds the artifact tag before deploying", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-deploy-build-hub-"));
  const localStore = join(dir, "store");
  const repoRoot = makeRepoRoot("software-deploy-build-repo-");
  const runs: CapturedRun[] = [];
  const r2 = makeR2Client();
  const program = createProgram(
    makeDeps({
      localStore,
      repoRoot,
      runs,
      env: r2Env,
      r2Client: r2.client,
    }),
  );
  const originalArgv1 = process.argv[1];
  process.argv[1] = join(dir, "cocalc-bin");
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
      "deploy",
      "--build",
      "hub:build-deploy",
      "prod",
      "--env-file",
      join(dir, "missing.env"),
    ]);
  } finally {
    console.log = originalLog;
    process.argv[1] = originalArgv1;
  }

  assert.equal(runs.length, 2);
  assert.equal(runs[0].command, "pnpm");
  assert.equal(runs[0].args.includes("build:bay-hub-bundle"), true);
  assert.equal(runs[1].command, join(dir, "cocalc-bin"));
  const rocketIndex = runs[1].args.indexOf("rocket");
  assert.notEqual(rocketIndex, -1);
  assert.deepEqual(runs[1].args.slice(rocketIndex, rocketIndex + 5), [
    "rocket",
    "deploy",
    "prod",
    "--scope",
    "hub",
  ]);
  const index = JSON.parse(
    r2.objects.get("software/indexes/hub.json")!.toString("utf8"),
  );
  assert.equal(index.artifacts[0].tag, "build-deploy");
  const payload = JSON.parse(logs.at(-1) ?? "{}");
  assert.equal(payload.ok, true);
  assert.equal(payload.command, "software deploy");
  assert.equal(payload.data.component, "hub");
  assert.equal(payload.data.tag, "build-deploy");
  assert.equal(payload.data.built, true);
  assert.equal(payload.data.built_component, "hub");
  assert.equal(payload.data.built_artifact_id, payload.data.artifact_id);
  assert.equal(payload.data.source, "local+pushed");
});

test("software deploy --build builds once for comma-separated profiles", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-deploy-build-multi-"));
  const localStore = join(dir, "store");
  const repoRoot = makeRepoRoot("software-deploy-build-multi-repo-");
  const runs: CapturedRun[] = [];
  const r2 = makeR2Client();
  const program = createProgram(
    makeDeps({
      localStore,
      repoRoot,
      runs,
      env: r2Env,
      r2Client: r2.client,
    }),
  );
  const originalArgv1 = process.argv[1];
  process.argv[1] = join(dir, "cocalc-bin");
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
      "deploy",
      "--build",
      "hub:build-multi",
      "staging,prod",
      "--env-file",
      join(dir, "missing.env"),
    ]);
  } finally {
    console.log = originalLog;
    process.argv[1] = originalArgv1;
  }

  assert.equal(runs.length, 3);
  assert.equal(runs[0].command, "pnpm");
  assert.equal(runs[0].args.includes("build:bay-hub-bundle"), true);
  assert.equal(runs[1].command, join(dir, "cocalc-bin"));
  assert.equal(runs[2].command, join(dir, "cocalc-bin"));
  const payload = JSON.parse(logs.at(-1) ?? "{}");
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.data.targets, ["staging", "prod"]);
  assert.equal(payload.data.deployments.length, 2);
  assert.equal(
    payload.data.deployments[0].built_artifact_id,
    payload.data.artifact_id,
  );
  assert.equal(
    payload.data.deployments[1].built_artifact_id,
    payload.data.artifact_id,
  );
  assert.equal(
    payload.data.deployments[0].artifact_id,
    payload.data.deployments[1].artifact_id,
  );
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

test("software deploy cli promotes an immutable artifact to a release channel", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-deploy-cli-channel-"));
  const localStore = join(dir, "store");
  const source = join(dir, "cocalc-cli-bin");
  writeFileSync(source, "cli binary");
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
    "cli",
    "cli-channel",
    "--from-file",
    source,
    "--artifact-name",
    "cocalc-cli-20260614T235912Z-e882d124-cli-channel-x86_64-linux",
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
      "deploy",
      "cli",
      "cli-channel",
      "candidate",
      "--env-file",
      join(dir, "missing.env"),
    ]);
  } finally {
    console.log = originalLog;
  }

  const manifest = JSON.parse(
    r2.objects
      .get("software/cocalc/candidate-linux-amd64.json")!
      .toString("utf8"),
  );
  assert.equal(manifest.schema, "cocalc-software-release-channel-v1");
  assert.equal(manifest.product, "cocalc");
  assert.equal(manifest.component, "cli");
  assert.equal(manifest.channel, "candidate");
  assert.equal(manifest.artifact_id, "20260614T235912Z-e882d124-cli-channel");
  assert.equal(manifest.version, manifest.artifact_id);
  assert.match(
    manifest.url,
    /software\/artifacts\/cli\/.*\/files\/cocalc-cli-/,
  );
  assert.equal(
    r2.objects.has("software/cocalc/latest-linux-amd64.json"),
    false,
  );
  const history = JSON.parse(
    r2.objects
      .get("software/deployments/candidate/cli/index.json")!
      .toString("utf8"),
  );
  assert.equal(history.deployments[0].status, "succeeded");
  assert.equal(history.deployments[0].target.kind, "release-channel");
  assert.equal(history.deployments[0].target.channel, "candidate");
  const record = JSON.parse(
    r2.objects
      .get(
        `software/deployments/candidate/cli/${history.deployments[0].deployment_id}.json`,
      )!
      .toString("utf8"),
  );
  assert.deepEqual(record.details.channel_manifests, [
    "https://software.example.test/software/cocalc/candidate-linux-amd64.json",
  ]);
  const payload = JSON.parse(logs.at(-1) ?? "{}");
  assert.equal(payload.data.size_bytes, 10);
  assert.equal(payload.data.size, "10 bytes");
  assert.equal(
    payload.data.install_url,
    "https://software.example.test/software/cocalc/install.sh",
  );
  assert.equal(
    payload.data.install_channel_env,
    "COCALC_CLI_CHANNEL=candidate",
  );
  assert.equal(
    payload.data.install_command,
    "curl -fsSL https://software.example.test/software/cocalc/install.sh | COCALC_CLI_CHANNEL=candidate bash",
  );
  assert.deepEqual(payload.data.available_channels, [
    "dev",
    "candidate",
    "stable",
  ]);
});

test("software deploy plus stable also updates the legacy latest manifest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-deploy-plus-channel-"));
  const localStore = join(dir, "store");
  const source = join(dir, "cocalc-plus-bin");
  writeFileSync(source, "plus binary");
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
    "plus",
    "plus-stable",
    "--from-file",
    source,
    "--artifact-name",
    "cocalc-plus-20260614T235912Z-e882d124-plus-stable-x86_64-linux",
  ]);
  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "tools-minimal",
    "plus-stable",
  ]);
  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "deploy",
    "plus",
    "plus-stable",
    "stable",
    "--env-file",
    join(dir, "missing.env"),
  ]);

  const stable = JSON.parse(
    r2.objects
      .get("software/cocalc-plus/stable-linux-amd64.json")!
      .toString("utf8"),
  );
  const latest = JSON.parse(
    r2.objects
      .get("software/cocalc-plus/latest-linux-amd64.json")!
      .toString("utf8"),
  );
  assert.equal(stable.artifact_id, "20260614T235912Z-e882d124-plus-stable");
  assert.equal(latest.artifact_id, stable.artifact_id);
  assert.equal(latest.channel, "latest");
  const toolsStable = JSON.parse(
    r2.objects
      .get("software/tools-minimal/stable-linux-amd64.json")!
      .toString("utf8"),
  );
  const toolsLatest = JSON.parse(
    r2.objects
      .get("software/tools-minimal/latest-linux-amd64.json")!
      .toString("utf8"),
  );
  assert.equal(toolsStable.product, "tools-minimal");
  assert.equal(toolsStable.component, "tools-minimal");
  assert.equal(
    toolsStable.artifact_id,
    "20260614T235912Z-e882d124-plus-stable",
  );
  assert.match(toolsStable.url, /tools-minimal-linux-amd64\.tar\.xz$/);
  assert.equal(toolsLatest.artifact_id, toolsStable.artifact_id);
  assert.equal(toolsLatest.channel, "latest");
  const history = JSON.parse(
    r2.objects
      .get("software/deployments/stable/plus/index.json")!
      .toString("utf8"),
  );
  assert.equal(history.deployments[0].target.kind, "release-channel");
  assert.equal(history.deployments[0].target.channel, "stable");
  const record = JSON.parse(
    r2.objects
      .get(
        `software/deployments/stable/plus/${history.deployments[0].deployment_id}.json`,
      )!
      .toString("utf8"),
  );
  assert.deepEqual(record.details.tools_minimal_channel_manifests, [
    "https://software.example.test/software/tools-minimal/stable-linux-amd64.json",
    "https://software.example.test/software/tools-minimal/stable-linux-arm64.json",
    "https://software.example.test/software/tools-minimal/stable-darwin-arm64.json",
    "https://software.example.test/software/tools-minimal/latest-linux-amd64.json",
    "https://software.example.test/software/tools-minimal/latest-linux-arm64.json",
    "https://software.example.test/software/tools-minimal/latest-darwin-arm64.json",
  ]);
});

test("software deploy plus requires a coordinated tools-minimal artifact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-deploy-plus-no-tools-"));
  const localStore = join(dir, "store");
  const source = join(dir, "cocalc-plus-bin");
  writeFileSync(source, "plus binary");
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
    "plus",
    "plus-only",
    "--from-file",
    source,
    "--artifact-name",
    "cocalc-plus-20260614T235912Z-e882d124-plus-only-x86_64-linux",
  ]);
  await assert.rejects(
    async () =>
      await program.parseAsync([
        "node",
        "test",
        "--quiet",
        "software",
        "deploy",
        "plus",
        "plus-only",
        "candidate",
        "--env-file",
        join(dir, "missing.env"),
      ]),
    /requires a matching tools-minimal artifact/,
  );

  assert.equal(
    r2.objects.has("software/cocalc-plus/candidate-linux-amd64.json"),
    false,
  );
});

test("software deploy release channels reject comma-separated targets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-deploy-release-multi-"));
  const localStore = join(dir, "store");
  const program = createProgram(makeDeps({ localStore, env: r2Env }));

  await assert.rejects(
    async () =>
      await program.parseAsync([
        "node",
        "test",
        "--quiet",
        "software",
        "deploy",
        "cli:release-test",
        "candidate,stable",
        "--env-file",
        join(dir, "missing.env"),
      ]),
    /software deploy cli accepts exactly one release channel/,
  );
});

test("software deploy star promotes an immutable GitHub release channel", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-deploy-star-channel-"));
  const localStore = join(dir, "store");
  const runs: CapturedRun[] = [];
  const r2 = makeR2Client();
  const program = createProgram(
    makeDeps({ localStore, runs, env: r2Env, r2Client: r2.client, cwd: dir }),
  );

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "star",
    "star-channel",
  ]);
  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "deploy",
    "star",
    "star-channel",
    "candidate",
    "--env-file",
    join(dir, "missing.env"),
  ]);

  const artifactId = "20260614T235912Z-e882d124-star-channel";
  assert.equal(runs.length, 3);
  assert.equal(
    runs[0].command.endsWith("build-github-release-assets.sh"),
    true,
  );
  assert.deepEqual(runs[1], {
    command: "gh",
    args: ["release", "view", artifactId, "--repo", "sagemathinc/cocalc-ai"],
  });
  assert.equal(
    runs[2].command.endsWith("promote-github-release-channel.sh"),
    true,
  );
  assert.deepEqual(runs[2].args, ["--upload", artifactId, "candidate"]);

  const history = JSON.parse(
    r2.objects
      .get("software/deployments/candidate/star/index.json")!
      .toString("utf8"),
  );
  assert.equal(history.deployments[0].status, "succeeded");
  assert.equal(history.deployments[0].target.kind, "release-channel");
  assert.equal(history.deployments[0].target.channel, "candidate");
  const record = JSON.parse(
    r2.objects
      .get(
        `software/deployments/candidate/star/${history.deployments[0].deployment_id}.json`,
      )!
      .toString("utf8"),
  );
  assert.equal(record.details.release_product, "cocalc-star");
  assert.equal(record.details.github_release, artifactId);
  assert.equal(record.details.github_repo, "sagemathinc/cocalc-ai");
  assert.equal(record.details.channel_tag, "cocalc-star-candidate");
  assert.equal(
    record.details.install_url,
    "https://github.com/sagemathinc/cocalc-ai/releases/download/cocalc-star-candidate/install-cocalc-star.sh",
  );
});

test("software deploy star fails before promotion when immutable release is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-deploy-star-missing-"));
  const localStore = join(dir, "store");
  const runs: CapturedRun[] = [];
  const r2 = makeR2Client();
  const deps = makeDeps({
    localStore,
    runs,
    env: r2Env,
    r2Client: r2.client,
    cwd: dir,
  });
  deps.runCommand = async (command, args, options) => {
    runs.push({ command, args });
    if (command.endsWith("build-github-release-assets.sh")) {
      const outDir = args[0];
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "install-cocalc-star.sh"), "star install");
      writeFileSync(join(outDir, "SHA256SUMS"), "star sums");
      writeFileSync(join(outDir, "release-notes.md"), "star notes");
      return 0;
    }
    if (command === "gh" && args.includes("view")) {
      return 1;
    }
    return options?.env ? 0 : 0;
  };
  const program = createProgram(deps);

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "build",
    "star",
    "missing-release",
  ]);
  await assert.rejects(
    async () =>
      await program.parseAsync([
        "node",
        "test",
        "--quiet",
        "software",
        "deploy",
        "star",
        "missing-release",
        "stable",
        "--env-file",
        join(dir, "missing.env"),
      ]),
    /immutable Star GitHub release .* was not found/,
  );

  assert.equal(
    runs.some((run) =>
      run.command.endsWith("promote-github-release-channel.sh"),
    ),
    false,
  );
  const history = JSON.parse(
    r2.objects
      .get("software/deployments/stable/star/index.json")!
      .toString("utf8"),
  );
  assert.equal(history.deployments[0].status, "failed");
  assert.match(history.deployments[0].error, /immutable Star GitHub release/);
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
  const latest = JSON.parse(
    r2.objects.get("software/project-host/latest-linux.json")!.toString("utf8"),
  );
  assert.equal(latest.version, artifactId);
  assert.equal(
    latest.url,
    `https://software.example.test/software/project-host/${artifactId}/bundle-linux.tar.xz`,
  );
  const versions = JSON.parse(
    r2.objects
      .get("software/project-host/versions-latest-linux.json")!
      .toString("utf8"),
  );
  assert.equal(versions.versions[0].version, artifactId);
  assert.equal(runs.length, 2);
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
  assert.deepEqual(runs[1].args, [
    "--profile",
    "staging",
    "host",
    "deploy",
    "set",
    "--global",
    "--artifact",
    "project-host",
    "--desired-version",
    artifactId,
    "--reason",
    "software-deploy-project-host",
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
  for (const arch of ["amd64", "arm64"]) {
    const latest = JSON.parse(
      r2.objects
        .get(`software/tools/latest-linux-${arch}.json`)!
        .toString("utf8"),
    );
    assert.equal(latest.version, artifactId);
    assert.equal(latest.arch, arch);
    assert.equal(
      latest.url,
      `https://software.example.test/software/tools/${artifactId}/tools-linux-${arch}.tar.xz`,
    );
    const versions = JSON.parse(
      r2.objects
        .get(`software/tools/versions-latest-linux-${arch}.json`)!
        .toString("utf8"),
    );
    assert.equal(versions.versions[0].version, artifactId);
  }
  assert.equal(runs.length, 3);
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
  assert.deepEqual(runs[2].args, [
    "--profile",
    "staging",
    "host",
    "deploy",
    "set",
    "--global",
    "--artifact",
    "tools",
    "--desired-version",
    artifactId,
    "--reason",
    "software-deploy-tools",
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
  const source = join(dir, "bundle-linux.tar.xz");
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

  assert.equal(runs.length, 4);
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
  assert.deepEqual(runs[1].args.slice(-12), [
    "--profile",
    "staging",
    "host",
    "deploy",
    "set",
    "--global",
    "--artifact",
    "project-host",
    "--desired-version",
    artifactId,
    "--reason",
    "software-deploy-host-conat-router",
  ]);
  assert.deepEqual(runs[2].args.slice(-14), [
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
  assert.deepEqual(runs[3].args.slice(-11), [
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

test("software smoke cli validates public release channel artifact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-smoke-cli-channel-"));
  const artifactId = "20260615T000000Z-abcdef12-cli";
  const artifact = Buffer.from("#!/usr/bin/env bash\n");
  const artifactSha256 = createHash("sha256").update(artifact).digest("hex");
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const machine = process.arch === "arm64" ? "aarch64" : "x86_64";
  const manifestUrl = `https://software.example.test/software/cocalc/candidate-${os}-${arch}.json`;
  const artifactUrl = `https://software.example.test/software/artifacts/cli/20260615T000000Z-abcdef12-cli/files/cocalc-cli-20260615T000000Z-abcdef12-cli-${machine}-${os}`;
  const versionRun: CapturedOutputRun = {
    command: "",
    args: [],
    stdout: `${artifactId} (published 2026-06-15T00:00:00.000Z, git abcdef12)\n`,
    stderr: "",
  };
  const outputRuns: CapturedOutputRun[] = [versionRun];
  const fetched: string[] = [];
  const program = createProgram(
    makeDeps({
      localStore: join(dir, "store"),
      outputRuns,
      env: {
        COCALC_SOFTWARE_PUBLIC_BASE_URL: "https://software.example.test",
      },
      fetch: async (input) => {
        const url = `${input}`;
        fetched.push(url);
        if (url === manifestUrl) {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () =>
              arrayBufferForBuffer(
                Buffer.from(
                  JSON.stringify({
                    schema: "cocalc-software-release-channel-v1",
                    product: "cocalc",
                    component: "cli",
                    channel: "candidate",
                    artifact_id: artifactId,
                    tag: "cli",
                    created_at: "2026-06-15T00:00:00.000Z",
                    published_at: "2026-06-15T00:00:00.000Z",
                    git: {
                      commit: "abcdef123456",
                      short: "abcdef12",
                      dirty: false,
                    },
                    os,
                    arch,
                    filename: `cocalc-cli-20260615T000000Z-abcdef12-cli-${machine}-${os}`,
                    size_bytes: artifact.length,
                    sha256: artifactSha256,
                    url: artifactUrl,
                    version: artifactId,
                  }),
                ),
              ),
          } as Response;
        }
        if (url === artifactUrl) {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => arrayBufferForBuffer(artifact),
          } as Response;
        }
        return {
          ok: false,
          status: 404,
          arrayBuffer: async () => new ArrayBuffer(0),
        } as Response;
      },
    }),
  );

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "smoke",
    "cli",
    "candidate",
  ]);

  assert.deepEqual(fetched, [manifestUrl, artifactUrl]);
  assert.equal(versionRun.args[0], "--version");
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

test("software smoke star runs the Star smoke script for a release channel", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-smoke-star-"));
  const repoRoot = makeRepoRoot("software-smoke-star-repo-");
  const runs: CapturedRun[] = [];
  let smokeEnv: NodeJS.ProcessEnv | undefined;
  const deps = makeDeps({ localStore: join(dir, "store"), repoRoot, runs });
  deps.runCommand = async (command, args, options) => {
    runs.push({ command, args });
    smokeEnv = options?.env;
    return 0;
  };
  const program = createProgram(deps);

  await program.parseAsync([
    "node",
    "test",
    "--quiet",
    "software",
    "smoke",
    "star",
    "candidate",
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].command.endsWith("scripts/star/smoke-star.sh"), true);
  assert.deepEqual(runs[0].args, []);
  assert.equal(smokeEnv?.SRC_ROOT, join(repoRoot, "src"));
  assert.equal(smokeEnv?.COCALC_STAR_CHANNEL, "candidate");
  assert.equal(smokeEnv?.COCALC_STAR_RELEASE_CHANNEL, "candidate");
});

test("software smoke star reports script failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-smoke-star-fail-"));
  const deps = makeDeps({ localStore: join(dir, "store") });
  deps.runCommand = async () => 9;
  const program = createProgram(deps);

  await assert.rejects(
    async () =>
      await program.parseAsync([
        "node",
        "test",
        "--quiet",
        "software",
        "smoke",
        "star",
        "dev",
      ]),
    /star smoke script failed with exit status 9/,
  );
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
    /unsupported software release channel 'staging'/,
  );
});

test("software push allows remote duplicate tags", async () => {
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

  const index = JSON.parse(
    r2.objects.get("software/indexes/hub.json")!.toString("utf8"),
  );
  assert.equal(index.artifacts.length, 2);
  assert.equal(index.artifacts[0].tag, "push-test");
  assert.equal(
    index.artifacts[0].artifact_id,
    "20260614T235912Z-e882d124-push-test",
  );
  assert.equal(index.artifacts[1].tag, "push-test");
  assert.equal(index.artifacts[1].artifact_id, "old");
});
