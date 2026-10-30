import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseSensorWake,
  sensorWatchScript,
} from "@cocalc/conat/agents/sensors";
import {
  agentWatch,
  exitWatcherArgs,
  scheduledRunWarnings,
  watchedPath,
} from "./sensor";

test("an exit watcher's command reports its output and exit code, and the watcher wakes on it", () => {
  const home = mkdtempSync(join(tmpdir(), "sensor-exit-"));
  const id = "6f1c8a52-3b1e-4c43-9d2a-1f0e5b7c9a10";
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  let args: string[];
  try {
    // Quotes and $ in the command are the command's own business.
    args = exitWatcherArgs(`echo "it's done: $((1 + 1))"; exit 3`, id);
  } finally {
    process.env.HOME = previousHome;
  }
  const env = { ...process.env, HOME: home };
  const ran = spawnSync("bash", args, { env, encoding: "utf8" });
  assert.match(ran.stdout, /it's done: 2/);
  assert.match(ran.stdout, /\[exit 3\]/);
  const dir = join(home, ".local/share/cocalc/sensors/exits");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")), {
    exit_code: 3,
  });
  const script = sensorWatchScript({ type: "exit", id, command: "make" })!;
  const out = execFileSync("python3", ["-c", script], {
    cwd: home,
    env,
    encoding: "utf8",
  });
  const wake = parseSensorWake(out)!;
  assert.equal(wake.summary, '"make" exited with code 3');
  assert.equal((wake.data as any).exit_code, 3);
  assert.match((wake.data as any).output_tail, /it's done: 2/);
});

test("a file watcher's relative path means where the agent ran the command", () => {
  assert.equal(
    watchedPath("build.log", "/home/user/proj"),
    "/home/user/proj/build.log",
  );
  assert.equal(watchedPath("../out/x", "/home/user/proj"), "/home/user/out/x");
  assert.equal(
    watchedPath("~/sensor-test.txt", "/home/user/proj"),
    "~/sensor-test.txt",
  );
  assert.equal(watchedPath("/tmp/x", "/home/user/proj"), "/tmp/x");
});

test("an agent watcher names a peer as agent send does, from its last turn on", () => {
  const endpoint = {
    project_id: "11111111-1111-4111-8111-111111111111",
    agent_id: "22222222-2222-4222-8222-222222222222",
  };
  const network = {
    agent_network_id: "88888888-8888-4888-8888-888888888888",
    title: "team",
    delivery_mode: "live",
  };
  const directory: any = {
    peers: [
      {
        member: {
          kind: "registered",
          member_id: endpoint.agent_id,
          name: "worker",
          endpoint,
          available: true,
          status: {
            version: 1,
            running: 1,
            queued: 0,
            last: { state: "completed", at: 1234 },
            at: Date.now(),
          },
        },
        networks: [network],
      },
      {
        member: {
          kind: "external",
          member_id: "33333333-3333-4333-8333-333333333333",
          label: "ops0 on alpha",
          source: {
            kind: "external",
            member_id: "33333333-3333-4333-8333-333333333333",
          },
          available: true,
        },
        networks: [network],
      },
    ],
  };
  assert.deepEqual(agentWatch("@worker", "failed", directory), {
    watch: {
      type: "agent",
      target: endpoint,
      until: "failed",
      since: 1234,
      name: "worker",
    },
    now: "busy",
  });
  // No status yet: every turn it reports counts.
  const quiet = structuredClone(directory);
  delete quiet.peers[0].member.status;
  assert.deepEqual(agentWatch("worker", "idle", quiet).watch, {
    type: "agent",
    target: endpoint,
    until: "idle",
    since: 0,
    name: "worker",
  });
  assert.throws(() => agentWatch("worker", "soon", directory), /--until/);
  assert.throws(
    () => agentWatch("nobody", "ended", directory),
    /No approved destination/,
  );
  assert.throws(
    () => agentWatch("ops0 on alpha", "ended", directory),
    /external agent/,
  );
});

test("a test warns about what a scheduled run won't have", () => {
  const secrets = scheduledRunWarnings(
    'key=$(cat /run/secrets/cocalc/STRIPE_KEY)\ncurl -H "Authorization: $key" https://example.com',
  );
  assert.equal(secrets.length, 1);
  assert.match(secrets[0], /Scheduled runs don't have the project's secrets/);
  const tmp = scheduledRunWarnings("cat /tmp/last-seen.txt");
  assert.equal(tmp.length, 1);
  assert.match(tmp[0], /empty \/tmp/);
  assert.equal(
    scheduledRunWarnings(
      "cat ~/.local/share/cocalc/runtime/x.json; ls /run/secrets",
    ).length,
    2,
  );
  // The directory itself, in a shell and quoted in other languages.
  for (const script of [
    "ls /tmp",
    "TMPDIR=/tmp make check",
    'import os; print(os.listdir("/tmp"))',
    "from pathlib import Path; Path('/tmp').glob('*')",
    "find /tmp -name x",
  ]) {
    assert.equal(scheduledRunWarnings(script).length, 1, script);
  }
  // Not /tmp: a tmp directory elsewhere, or a longer name.
  for (const script of [
    "ls ~/proj/tmp",
    "ls $HOME/tmp/x",
    "ls /tmpfiles",
    "cat /tmp.d/x",
  ]) {
    assert.deepEqual(scheduledRunWarnings(script), [], script);
  }
  // An ordinary script: nothing to warn about.
  assert.deepEqual(
    scheduledRunWarnings(
      'gh pr checks 12 --repo a/b | grep -q fail && echo \'{"wake":true}\'; echo "$COCALC_SENSOR_STATE" ~/proj/tmp/x',
    ),
    [],
  );
});
