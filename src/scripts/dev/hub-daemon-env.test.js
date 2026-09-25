const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Exercise the actual function without sourcing the daemon's command dispatcher.
const source = fs.readFileSync(path.join(__dirname, "hub-daemon.sh"), "utf8");
const refresh = source.match(/^refresh_hub_env\(\) \{\n[\s\S]*?^\}/m)?.[0];
assert.ok(refresh, "refresh_hub_env must exist");
const configureSecret = source.match(
  /^configure_cluster_shared_secret\(\) \{\n[\s\S]*?^\}/m,
)?.[0];
assert.ok(configureSecret, "configure_cluster_shared_secret must exist");

test("hub env uses pnpm's supported silent reporter and evaluates exports", () => {
  const result = spawnSync(
    "bash",
    [
      "-c",
      `
set -euo pipefail
pnpm() {
  [ "$*" = "--reporter=silent run dev:hub:env" ] || return 42
  printf '%s\n' 'export COCALC_ENV_TEST=loaded'
}
${refresh}
refresh_hub_env
[ "$COCALC_ENV_TEST" = loaded ]
`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("failed env generation propagates failure without evaluating partial output", () => {
  const result = spawnSync(
    "bash",
    [
      "-c",
      `
set -euo pipefail
pnpm() {
  printf '%s\n' 'echo PARTIAL_OUTPUT_EVALUATED'
  return 23
}
${refresh}
refresh_hub_env
echo UPGRADE_WOULD_RUN
`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 23);
  assert.equal(result.stdout, "");
});

test("multi-bay dev clusters reuse a private shared signing secret", () => {
  const stateDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "hub-secret-"));
  try {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
set -euo pipefail
${configureSecret}
configure_cluster_shared_secret
first="$COCALC_CLUSTER_SHARED_SECRET"
unset COCALC_CLUSTER_SHARED_SECRET
configure_cluster_shared_secret
[ "$first" = "$COCALC_CLUSTER_SHARED_SECRET" ]
[ "\$(stat -c %a "$STATE_DIR/cluster-shared-secret")" = 600 ]
[ "\${#first}" = 64 ]
`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          STATE_DIR: stateDir,
          HUB_CLUSTER_BAY_COUNT: "3",
          COCALC_CLUSTER_SHARED_SECRET: "",
          COCALC_HOME_BAY_RETRY_TOKEN_SECRET: "",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("single-bay and explicitly configured clusters do not generate a secret", () => {
  const stateDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "hub-secret-"));
  try {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
set -euo pipefail
${configureSecret}
HUB_CLUSTER_BAY_COUNT=1
configure_cluster_shared_secret
[ ! -e "$STATE_DIR/cluster-shared-secret" ]
HUB_CLUSTER_BAY_COUNT=3
COCALC_CLUSTER_SHARED_SECRET=configured
configure_cluster_shared_secret
[ "$COCALC_CLUSTER_SHARED_SECRET" = configured ]
[ ! -e "$STATE_DIR/cluster-shared-secret" ]
`,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, STATE_DIR: stateDir },
      },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
