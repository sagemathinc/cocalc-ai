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

type CapturedRun = {
  command: string;
  args: string[];
};

function makeDeps({
  localStore,
  runs,
  cwd = "/repo",
}: {
  localStore: string;
  runs?: CapturedRun[];
  cwd?: string;
}): SoftwareCommandDeps {
  return {
    cwd,
    env: { COCALC_SOFTWARE_LOCAL_STORE: localStore },
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
      let bundle = args.at(-1);
      if (args.includes("@cocalc/project-host")) {
        bundle = join(
          cwd,
          "src",
          "packages",
          "project-host",
          "build",
          "bundle-linux.tar.xz",
        );
      } else if (
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
  };
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
