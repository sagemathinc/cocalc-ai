const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Exercise the actual function without sourcing the daemon's command dispatcher.
const source = fs.readFileSync(path.join(__dirname, "hub-daemon.sh"), "utf8");
const refresh = source.match(/^refresh_hub_env\(\) \{\n[\s\S]*?^\}/m)?.[0];
assert.ok(refresh, "refresh_hub_env must exist");

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
