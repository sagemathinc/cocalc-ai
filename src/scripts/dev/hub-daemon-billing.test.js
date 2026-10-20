const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Exercise the daemon's billing worker functions without its dispatcher.
const source = fs.readFileSync(path.join(__dirname, "hub-daemon.sh"), "utf8");
function fn(name) {
  const body = source.match(
    new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "m"),
  )?.[0];
  assert.ok(body, `${name} must exist`);
  return body;
}
const functions = [
  "rotate_log_file",
  "local_hub_url",
  "billing_authority_enabled",
  "pid_live",
  "billing_worker_running",
  "start_billing_worker",
  "stop_billing_worker",
]
  .map(fn)
  .join("\n");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-daemon-billing-"));
  const bin = path.join(dir, "bin");
  const hubBin = path.join(dir, "packages", "hub", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(hubBin, { recursive: true });
  // The seed hub answers at once.
  fs.writeFileSync(path.join(bin, "curl"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  // Stands in for start.sh: record what the worker was started with.
  fs.writeFileSync(
    path.join(hubBin, "start.sh"),
    `#!/bin/sh
env | grep -E '^(COCALC_BILLING_SINGLETON_LOCKED|COCALC_HUB_BILLING_WORKER|COCALC_BILLING_WORKER_CONAT_SERVER)=' | sort > "${dir}/worker.env"
exec sleep 60
`,
    { mode: 0o755 },
  );
  return { dir, bin, startSh: path.join(hubBin, "start.sh") };
}

function run({ dir, bin, startSh }, env, script) {
  return spawnSync(
    "bash",
    [
      "-c",
      `
set -uo pipefail
STATE_DIR='${dir}'
BILLING_PID_FILE="$STATE_DIR/billing-worker.pid"
BILLING_LOG="$STATE_DIR/billing-worker.log"
BILLING_LOCK="$STATE_DIR/billing-executor.lock"
HUB_CMD='${startSh} postgres'
HUB_BIND_HOST=localhost
HUB_PORT=9100
${functions}
${script}
`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
    },
  );
}

async function waitFor(check) {
  for (let i = 0; i < 50; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("timed out");
}

test("no billing worker unless billing authority is enabled on the seed", () => {
  const ctx = setup();
  for (const env of [
    { COCALC_BILLING_AUTHORITY_ENABLED: "0", COCALC_CLUSTER_ROLE: "seed" },
    { COCALC_BILLING_AUTHORITY_ENABLED: "1", COCALC_CLUSTER_ROLE: "attached" },
  ]) {
    const result = run(ctx, env, "start_billing_worker");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fs.existsSync(path.join(ctx.dir, "billing-worker.pid")),
      false,
    );
  }
});

test("the seed starts one locked billing worker and stops it", async () => {
  const ctx = setup();
  const env = {
    COCALC_BILLING_AUTHORITY_ENABLED: "yes",
    COCALC_CLUSTER_ROLE: "seed",
  };
  let result = run(ctx, env, "start_billing_worker");
  assert.equal(result.status, 0, result.stderr);
  const pidFile = path.join(ctx.dir, "billing-worker.pid");
  const pid = fs.readFileSync(pidFile, "utf8").trim();
  await waitFor(() => fs.existsSync(path.join(ctx.dir, "worker.env")));
  assert.equal(
    fs.readFileSync(path.join(ctx.dir, "worker.env"), "utf8"),
    [
      "COCALC_BILLING_SINGLETON_LOCKED=1",
      "COCALC_BILLING_WORKER_CONAT_SERVER=http://localhost:9100",
      "COCALC_HUB_BILLING_WORKER=1",
      "",
    ].join("\n"),
  );
  // Already running: not started twice.
  result = run(ctx, env, "start_billing_worker");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(pidFile, "utf8").trim(), pid);

  result = run(ctx, env, "stop_billing_worker");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /billing worker stopped/);
  assert.equal(fs.existsSync(pidFile), false);
  assert.equal(live(pid), false);
});

// Gone, or exited and waiting to be reaped (where PID 1 does not reap).
function live(pid) {
  try {
    process.kill(Number(pid), 0);
  } catch {
    return false;
  }
  const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
  }).stdout.trim();
  return !stat.startsWith("Z");
}

test("an exited but unreaped process is not live", () => {
  const ctx = setup();
  // The shell becomes a sleep that never reaps its exited child.
  const result = run(
    ctx,
    {},
    `sleep 0.2 & child=$!; (sleep 0.6; if pid_live "$child"; then echo live; else echo gone; fi; kill -0 "$child" && echo signalable) & exec sleep 1`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /gone/);
  // kill -0 alone would have called it running.
  assert.match(result.stdout, /signalable/);
});
