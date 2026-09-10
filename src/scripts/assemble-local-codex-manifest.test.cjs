const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { assemble } = require("./assemble-local-codex-manifest.cjs");

function fixture(t, override = {}) {
  const dir = mkdtempSync(join(tmpdir(), "codex-manifest-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const arch of ["x64", "arm64"]) {
    mkdirSync(join(dir, `linux-${arch}`));
    for (const binary of ["codex", "codex-code-mode-host"]) {
      writeFileSync(join(dir, `linux-${arch}`, binary), `${arch}-${binary}`);
    }
    writeFileSync(
      join(dir, `manifest-linux-${arch}.json`),
      JSON.stringify({
        version: "0.153.4",
        tag: "rust-v0.153.4",
        upstream_head: "pinned-commit",
        patches: ["tcp-timeout.patch", "lock-version.patch"],
        linux_libc: "musl",
        rust_toolchain: "1.95.0",
        build_platform: `linux-${arch}`,
        ...(arch === "arm64" ? override : {}),
      }),
    );
  }
  return dir;
}

test("combines matching native builds and fingerprints all four artifacts", (t) => {
  const dir = fixture(t);
  const result = assemble(dir);
  assert.equal(result.build_platform, "all");
  assert.equal(result.arm64_binary, join(dir, "linux-arm64", "codex"));
  assert.equal(Object.keys(result.binary_sha256).length, 4);
  assert.notEqual(
    result.binary_sha256.x64_binary,
    result.binary_sha256.arm64_binary,
  );
});

for (const override of [
  { upstream_head: "different-source" },
  { patches: [] },
  { linux_libc: "gnu" },
  { build_platform: "linux-x64" },
]) {
  test(`rejects incompatible native build: ${JSON.stringify(override)}`, (t) => {
    assert.throws(() => assemble(fixture(t, override)));
  });
}
