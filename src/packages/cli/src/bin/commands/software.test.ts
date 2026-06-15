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

function makeDeps({
  localStore,
  runs,
  cwd = "/repo",
  env,
  r2Client,
}: {
  localStore: string;
  runs?: CapturedRun[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  r2Client?: SoftwareR2Client;
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
    runCommand: async (command, args) => {
      runs?.push({ command, args });
      let bundle = command === "pnpm" ? args.at(-1) : undefined;
      if (command === "pnpm" && args.includes("@cocalc/project-host")) {
        bundle = join(
          cwd,
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
          cwd,
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
        const toolsArch = process.arch === "arm64" ? "arm64" : "amd64";
        bundle = join(
          cwd,
          "src",
          "packages",
          "project",
          "build",
          `tools-linux-${toolsArch}.tar.xz`,
        );
      }
      if (bundle) {
        mkdirSync(join(bundle, ".."), { recursive: true });
        writeFileSync(bundle, "built bundle");
      }
      return 0;
    },
    r2Client,
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
  assert.match(build.helpInformation(), /static\|hub\|project-host/);
  assert.match(list.helpInformation(), /cli\|launchpad\|plus\|star/);
  assert.match(deploy.helpInformation(), /hub-conat-router/);
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

test("software build hub runs the Rocket bay runtime builder", async () => {
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
  assert.equal(runs[0].args.includes("build:bay-bundle"), true);
  const artifactName = `cocalc-bay-runtime-linux-${
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
  const toolsArch = process.arch === "arm64" ? "arm64" : "amd64";
  const artifactName = `tools-linux-${toolsArch}.tar.xz`;

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
  assert.equal(
    existsSync(
      join(
        localStore,
        "tools",
        "20260614T235912Z-e882d124-tools-test",
        "files",
        artifactName,
      ),
    ),
    true,
  );
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

  assert.equal(runs.length, 1);
  const run = runs[0];
  assert.equal(run.command, process.execPath);
  const rocketIndex = run.args.indexOf("rocket");
  assert.notEqual(rocketIndex, -1);
  assert.deepEqual(run.args.slice(rocketIndex), [
    "rocket",
    "deploy",
    "staging",
    "--scope",
    "static",
    "--bundle",
    join(
      localStore,
      "static",
      "20260614T235912Z-e882d124-deploy-test",
      "files",
      "static.tar.xz",
    ),
    "--yes",
  ]);
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
  assert.deepEqual(runs[0].args.slice(rocketIndex), [
    "rocket",
    "deploy",
    "prod",
    "--scope",
    "bay",
    "--bundle",
    join(
      localStore,
      "hub",
      "20260614T235912Z-e882d124-local-deploy",
      "files",
      "hub.tar.xz",
    ),
    "--yes",
  ]);
});

test("software deploy rejects unwired explicit conat components", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-deploy-unwired-"));
  const program = createProgram(makeDeps({ localStore: join(dir, "store") }));

  await assert.rejects(
    async () =>
      await program.parseAsync([
        "node",
        "test",
        "software",
        "deploy",
        "hub-conat-router",
        "tag",
        "prod",
      ]),
    /software deploy hub-conat-router is not wired yet/,
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
