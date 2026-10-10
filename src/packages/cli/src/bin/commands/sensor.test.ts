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
import { exitWatcherArgs } from "./sensor";

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
