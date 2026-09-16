const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

test("publisher rejects corrupt artifacts before authentication or upload", (t) => {
  const root = mkdtempSync(join(tmpdir(), "codex-invalid-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const version = join(root, "0.153.4");
  for (const arch of ["x64", "arm64"]) {
    const dir = join(version, `linux-${arch}`);
    mkdirSync(dir, { recursive: true });
    for (const name of ["codex", "codex-code-mode-host"]) {
      writeFileSync(join(dir, name), "truncated ELF");
    }
  }
  writeFileSync(join(version, "manifest.json"), "{}");
  const result = spawnSync(
    "bash",
    [join(__dirname, "publish-local-codex-binaries.sh")],
    {
      env: {
        ...process.env,
        COCALC_CODEX_LOCAL_BIN_DIR: root,
        CODEX_VERSION: "0.153.4",
      },
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid ELF release binary/);
});
