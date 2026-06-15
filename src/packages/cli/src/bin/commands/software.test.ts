import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Command } from "commander";

import { registerSoftwareCommand, type SoftwareCommandDeps } from "./software";

function makeDeps(localStore: string): SoftwareCommandDeps {
  return {
    cwd: "/repo",
    env: { COCALC_SOFTWARE_LOCAL_STORE: localStore },
    now: () => new Date("2026-06-14T23:59:12.345Z"),
    gitMetadata: () => ({
      commit: "e882d124c7abcdef",
      short: "e882d124c7ab",
      branch: "lite4",
      dirty: false,
      status_porcelain: "",
    }),
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
  const program = createProgram(makeDeps(localStore));

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

test("software build rejects duplicate explicit local tags", async () => {
  const dir = mkdtempSync(join(tmpdir(), "software-duplicate-"));
  const localStore = join(dir, "store");
  const source = join(dir, "artifact.tar.xz");
  writeFileSync(source, "artifact contents");
  const program = createProgram(makeDeps(localStore));

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
  const program = createProgram(makeDeps(localStore));

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
