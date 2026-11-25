import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseSensorWake,
  SENSOR_LIMITS,
  sensorWatchScript,
} from "@cocalc/conat/agents/sensors";
import { Command } from "commander";
import {
  agentWatch,
  exitTerminalId,
  exitWatcherArgs,
  registerSensorCommand,
  scheduledRunWarnings,
  watchedPath,
} from "./sensor";

test("an exit watcher's check can start its command again: the arguments it passes parse", async () => {
  const id = "6f1c8a52-3b1e-4c43-9d2a-1f0e5b7c9a10";
  assert.equal(exitTerminalId(id), "sensor-exit-6f1c8a52");
  assert.equal(exitTerminalId(id, 2), "sensor-exit-6f1c8a52-r2");
  assert.throws(() => exitTerminalId("../x", 1));
  const seen: any[] = [];
  const program = new Command().exitOverride();
  registerSensorCommand(program, {
    withContext: (async (cmd: Command, name: string) => {
      seen.push({ name, opts: cmd.opts(), args: cmd.args });
    }) as any,
    emitSuccess: (() => undefined) as any,
    globalsFrom: (() => ({})) as any,
    resolveProjectFromArgOrContext: (async () => {
      throw new Error("unused");
    }) as any,
    resolveProjectConatClient: (async () => {
      throw new Error("unused");
    }) as any,
  });
  // As sensorWatchScript runs it (after the global --json).
  const command = "./wait-ci.sh 'a b' --hours 3";
  await program.parseAsync(
    [
      "sensor",
      "exit-restart",
      "--id",
      id,
      "--attempt",
      "1",
      "--cwd",
      "my dir",
      "--",
      command,
    ],
    { from: "user" },
  );
  assert.deepEqual(seen, [
    {
      name: "sensor exit-restart",
      opts: { id, attempt: "1", cwd: "my dir" },
      args: [command],
    },
  ]);
});

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
  // With the default 30 s heartbeat: it returns as soon as the command
  // exits (the heartbeat's sleep must not hold the output pipe open).
  const started = Date.now();
  const ran = spawnSync("bash", args, {
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.ok(
    Date.now() - started < 10_000,
    `returned after ${Date.now() - started} ms`,
  );
  assert.match(ran.stdout, /it's done: 2/);
  assert.match(ran.stdout, /\[exit 3\]/);
  const dir = join(home, ".local/share/cocalc/sensors/exits");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")), {
    exit_code: 3,
  });
  assert.ok(existsSync(join(dir, `${id}.beat`)), "it had a heartbeat");
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

test("killed before its command exits, it stops its heartbeat, and the watcher wakes saying so", async () => {
  const home = mkdtempSync(join(tmpdir(), "sensor-exit-killed-"));
  const id = "0b7d2e4f-8a61-4c3e-b2d9-5e7f1a3c6b80";
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  let args: string[];
  try {
    args = exitWatcherArgs("echo started; sleep 60", id, 1);
  } finally {
    process.env.HOME = previousHome;
  }
  const env = { ...process.env, HOME: home };
  const dir = join(home, ".local/share/cocalc/sensors/exits");
  const beat = join(dir, `${id}.beat`);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Its own process group, so the test can clean up the command after.
  const child = spawn("bash", args, { env, detached: true, stdio: "ignore" });
  try {
    for (let i = 0; i < 50 && !existsSync(beat); i++) await sleep(100);
    assert.ok(existsSync(beat), "the wrapper touches its heartbeat");
    // Only the wrapper is killed (an OOM kill, say): the heartbeat loop must
    // notice and stop, or a lost command would look alive forever.
    process.kill(child.pid!, "SIGKILL");
    await sleep(2500);
    const before = statSync(beat).mtimeMs;
    await sleep(2500);
    assert.equal(statSync(beat).mtimeMs, before, "the heartbeat stopped");
  } finally {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {}
  }
  assert.equal(existsSync(join(dir, `${id}.json`)), false);
  const old = Date.now() / 1000 - SENSOR_LIMITS.exitLostAfterSeconds - 10;
  utimesSync(beat, old, old);
  const script = sensorWatchScript({ type: "exit", id, command: "make" })!;
  const wake = parseSensorWake(
    execFileSync("python3", ["-c", script], {
      cwd: home,
      env,
      encoding: "utf8",
    }),
  )!;
  assert.match(wake.summary, /has no exit code/);
  assert.equal((wake.data as any).exit_code, null);
  assert.equal((wake.data as any).reason, "terminal-ended");
  assert.equal((wake.data as any).state, "unknown");
  assert.match((wake.data as any).output_tail, /started/);
});

// The watcher's check cannot see the project's processes, and a stale
// heartbeat does not prove the command stopped: a restart runs it only once
// it sees, in the project, that the earlier run's process group is gone.
async function startExitWatcher(home: string, id: string, command: string) {
  const env = { ...process.env, HOME: home };
  const args = withHome(home, () => exitWatcherArgs(command, id, 1));
  const dir = join(home, ".local/share/cocalc/sensors/exits");
  // A session and process group of its own, as in a project terminal.
  const child = spawn("bash", args, { env, detached: true, stdio: "ignore" });
  for (let i = 0; i < 50 && !existsSync(join(dir, `${id}.group`)); i++)
    await sleep(100);
  assert.ok(existsSync(join(dir, `${id}.group`)), "it records its group");
  return { child, dir, env };
}

function withHome<T>(home: string, f: () => T): T {
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return f();
  } finally {
    process.env.HOME = previousHome;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function restartAttempt(home: string, id: string, command: string) {
  const args = withHome(home, () =>
    exitWatcherArgs(command, id, 1, /* guard */ true),
  );
  return spawnSync("bash", args, {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
    timeout: 20_000,
  });
}

test("wrapper SIGKILLed, child still alive: a restart does not launch a second copy", async () => {
  const home = mkdtempSync(join(tmpdir(), "sensor-exit-alive-"));
  const id = "3c9e1f70-5d2a-4b8e-9f61-7a0c2e4b8d15";
  const runs = join(home, "runs");
  const command = `echo run >> ${JSON.stringify(runs)}; sleep 60`;
  const { child, dir, env } = await startExitWatcher(home, id, command);
  try {
    for (let i = 0; i < 50 && !existsSync(runs); i++) await sleep(100);
    assert.equal(readFileSync(runs, "utf8"), "run\n");
    // Only the wrapper is killed: its command (sleep) keeps running.
    process.kill(child.pid!, "SIGKILL");
    await sleep(500);
    assert.ok(groupAlive(child.pid!), "the command is still running");
    const again = restartAttempt(home, id, command);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /not started again/);
    assert.equal(readFileSync(runs, "utf8"), "run\n", "no second launch");
    assert.ok(existsSync(join(dir, `${id}.unknown`)));
    // The watcher then wakes, state unknown, and asks for no restart.
    const bin = mkdtempSync(join(tmpdir(), "sensor-exit-bin-"));
    const calls = join(bin, "calls");
    writeFileSync(
      join(bin, "cocalc"),
      `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\n`,
      { mode: 0o755 },
    );
    const old = Date.now() / 1000 - SENSOR_LIMITS.exitLostAfterSeconds - 10;
    utimesSync(join(dir, `${id}.beat`), old, old);
    const script = sensorWatchScript({
      type: "exit",
      id,
      command,
      restart: true,
    })!;
    const wake = parseSensorWake(
      execFileSync("python3", ["-c", script], {
        cwd: home,
        env: { ...env, PATH: `${bin}:/usr/bin:/bin` },
        encoding: "utf8",
      }),
    )!;
    assert.equal((wake.data as any).state, "unknown");
    assert.match(wake.summary, /not started again/);
    assert.equal(existsSync(calls), false);
    assert.equal(readFileSync(runs, "utf8"), "run\n");
  } finally {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {}
  }
});

test("the earlier run's whole group gone: a restart runs the command again", async () => {
  const home = mkdtempSync(join(tmpdir(), "sensor-exit-gone-"));
  const id = "8a4d2c61-0f3b-4e7a-b5c9-1d6e8f2a3b47";
  const runs = join(home, "runs");
  const { child, dir } = await startExitWatcher(
    home,
    id,
    `echo run >> ${JSON.stringify(runs)}; sleep 60`,
  );
  for (let i = 0; i < 50 && !existsSync(runs); i++) await sleep(100);
  // Everything in it ends, as when the project restarts.
  process.kill(-child.pid!, "SIGKILL");
  for (let i = 0; i < 50 && groupAlive(child.pid!); i++) await sleep(100);
  assert.equal(groupAlive(child.pid!), false);
  const again = restartAttempt(home, id, `echo run >> ${JSON.stringify(runs)}`);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /\[exit 0\]/);
  assert.equal(readFileSync(runs, "utf8"), "run\nrun\n");
  assert.equal(existsSync(join(dir, `${id}.unknown`)), false);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")), {
    exit_code: 0,
  });
});

test("a restart with no record of the earlier run does not run it", () => {
  const home = mkdtempSync(join(tmpdir(), "sensor-exit-norecord-"));
  const id = "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f";
  const runs = join(home, "runs");
  const again = restartAttempt(home, id, `echo run >> ${JSON.stringify(runs)}`);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /not started again/);
  assert.equal(existsSync(runs), false);
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
  assert.match(secrets[0], /Scheduled runs don't have them/);
  const tmp = scheduledRunWarnings("cat /tmp/last-seen.txt");
  assert.equal(tmp.length, 1);
  assert.match(tmp[0], /empty \/tmp/);
  assert.equal(
    scheduledRunWarnings(
      "cat ~/.local/share/cocalc/runtime/x.json; ls /run/secrets",
    ).length,
    2,
  );
  // Through $COCALC_SECRETS, as the docs show, in a shell and in Python.
  for (const script of [
    'curl -H "Authorization: $(cat "$COCALC_SECRETS/TOKEN")" https://x',
    'token = (Path(os.environ["COCALC_SECRETS"]) / "MY_API_TOKEN").read_text()',
  ]) {
    const warnings = scheduledRunWarnings(script);
    assert.equal(warnings.length, 1, script);
    assert.match(warnings[0], /Scheduled runs don't have them/);
  }
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
