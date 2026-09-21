const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { test, after } = require("node:test");

// Match the documented portable probe build, without installing a harness.
const frontendRequire = createRequire(
  resolve(__dirname, "../../../frontend/package.json"),
);
const directory = mkdtempSync(join(tmpdir(), "acp-probe-cli-"));
after(() => rmSync(directory, { recursive: true, force: true }));
const bundle = join(directory, "probe.cjs");
frontendRequire("esbuild").buildSync({
  entryPoints: [join(__dirname, "harness-provider-smoke.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
});

for (const [args, error] of [
  [["--provider-rejet"], /Unknown provider probe argument/],
  [["--require-loopback-onyl"], /Unknown provider probe argument/],
  [["pi", "--provider-rejet"], /Unknown provider probe argument/],
  [["opencode"], /Unknown provider probe argument/],
  [
    ["--provider-reject", "--provider-reject"],
    /Duplicate provider probe option/,
  ],
  [["--provider-reject", "--provider-retry"], /Choose one provider fault mode/],
]) {
  test(`probe rejects invalid arguments before launch: ${args.join(" ")}`, () => {
    const result = spawnSync(
      process.execPath,
      [bundle, "/not-installed/acp", ...args],
      {
        encoding: "utf8",
        timeout: 5000,
        env: {},
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /ENOENT|spawn/);
  });
}
