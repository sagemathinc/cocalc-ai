const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Exercise the actual functions without sourcing the daemon's dispatcher.
const source = fs.readFileSync(path.join(__dirname, "hub-daemon.sh"), "utf8");
const fn = (name) => {
  const body = source.match(
    new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "m"),
  )?.[0];
  assert.ok(body, `${name} must exist`);
  return body;
};

// A checkout whose bundles are built and whose tools are not.
function checkout() {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "hub-daemon-tools-"));
  for (const pkg of ["project-host", "project"]) {
    fs.mkdirSync(path.join(src, "packages", pkg, "build"), { recursive: true });
    fs.writeFileSync(
      path.join(src, "packages", pkg, "build", "bundle-linux.tar.xz"),
      "",
    );
  }
  return src;
}

function startupBuilds(toolsBaseUrl) {
  const src = checkout();
  const result = spawnSync(
    "bash",
    [
      "-c",
      `
set -euo pipefail
pnpm() { printf '%s\\n' "$*" >> "$SRC_DIR/pnpm-calls"; }
${fn("have_local_tools_bundle")}
${fn("ensure_local_software_artifacts")}
ensure_local_software_artifacts
cat "$SRC_DIR/pnpm-calls" 2>/dev/null || true
`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        SRC_DIR: src,
        HUB_SOFTWARE_PACKAGES_ROOT: path.join(src, "packages"),
        HUB_USE_LOCAL_SOFTWARE: "1",
        HUB_AUTO_BUILD_LOCAL_SOFTWARE: "1",
        HUB_TOOLS_SOFTWARE_BASE_URL: toolsBaseUrl,
      },
    },
  );
  fs.rmSync(src, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("startup builds missing tools when this hub serves them", () => {
  assert.match(startupBuilds(""), /build:tools/);
});

test("startup never builds tools served from a published endpoint", () => {
  assert.doesNotMatch(
    startupBuilds("https://software.cocalc.ai/software"),
    /build:tools/,
  );
});
