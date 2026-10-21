/*
The recovery runner against a fake launcher and a fake cgroup tree: a
temporary directory stands in for /sys/fs/cgroup and /proc/self, and the
fake launcher (a small Node program) creates the job's leaf, then runs the
real child code (recovery-child.ts, transpiled) in its own process, as the
current user. Root, the wrapper and real cgroup limits are not exercised here
(the isolation plan's real-host tests); everything the runner decides is.
*/

import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import { DataEncoding, encode } from "@cocalc/conat/core/codec";
import {
  RECOVERY_VALUE_CAP,
  decodeFrameBody,
  encodeFrame,
  type JobRecord,
} from "@cocalc/conat/board-recovery/frame";
import { BOARD_HISTORY_LIMITS } from "@cocalc/conat/persist/board-history";
import { legacyPatchId } from "@cocalc/sync/patchflow";
import { from_str } from "@cocalc/sync/editor/immer-db/doc";
import {
  BOARD_PRIMARY_KEYS,
  BOARD_STRING_COLS,
} from "@cocalc/util/board/names";
import {
  RecoveryRunner,
  verifyHello,
  type RecoveryLauncher,
  type RecoveryLimits,
  type StopReport,
} from "./recovery";

const MEMORY_MAX = "1073741824";
let root: string;
let childModule: string;
let launcherScript: string;

// The fake launcher: argv is the job id; FAKE_BEHAVIOR says how to misbehave.
const LAUNCHER = String.raw`
const fs = require("fs");
const path = require("path");
const { Writable } = require("stream");
const jobId = process.argv[2];
const root = process.env.FAKE_ROOT;
const behavior = process.env.FAKE_BEHAVIOR || "ok";
const leaf = path.join(root, "cgroup", "cocalc-board-recovery", "job-" + jobId);
const deny = (reason) => {
  process.stderr.write("denied: " + reason + "\n");
  process.exit(3);
};
if (behavior === "deny") deny("recovery-busy");
if (behavior === "garbage-then-deny") {
  // An over-cap hello header, then a denial.
  process.stdout.write(Buffer.from([0xff, 0xff, 0xff, 0xff]), () =>
    deny("recovery-busy"),
  );
  return;
}
if (fs.existsSync(path.join(root, "tomb-" + jobId))) deny("recovery-cancelled");
if (behavior === "hang") {
  // Stuck before its leaf, until its own setup alarm (the real helper's
  // alarm(8)) ends it.
  setTimeout(() => process.exit(1), Number(process.env.FAKE_ALARM_MS));
  return;
}
fs.mkdirSync(leaf, { recursive: true });
const files = {
  "memory.max": process.env.FAKE_MEMORY_MAX,
  "memory.swap.max": "0",
  "memory.events.local": "oom_kill 0\n",
  "cpu.stat": "usage_usec " + (behavior === "cpu" ? "999999999999" : "1000") + "\n",
  "cgroup.procs": String(process.pid),
};
for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(leaf, name), text);
const proc = path.join(root, "proc-" + jobId);
fs.mkdirSync(proc, { recursive: true });
const uid = behavior === "wrong-uid" ? 0 : Number(process.env.FAKE_UID);
const gid = Number(process.env.FAKE_GID);
fs.writeFileSync(path.join(proc, "status"), [
  "Name:\tnode",
  "Uid:\t" + [uid, uid, uid, uid].join("\t"),
  "Gid:\t" + [gid, gid, gid, gid].join("\t"),
  "Groups:\t",
  "NoNewPrivs:\t1",
  "CapPrm:\t0000000000000000",
  "CapEff:\t0000000000000000",
  "",
].join("\n"));
fs.writeFileSync(path.join(proc, "cgroup"), "0::/cocalc-board-recovery/job-" + jobId + "\n");
if (behavior === "extra-fd") fs.openSync(path.join(proc, "status"), "r");
let writes = 0;
const frame = require("@cocalc/conat/board-recovery/frame");
const output = new Writable({
  write(chunk, _enc, cb) {
    writes += 1;
    if (writes === 2 && (behavior === "wrong-hash" || behavior === "wrong-job")) {
      // Rewrite the result (one frame per write).
      const result = frame.decodeFrameBody("result", chunk.subarray(4));
      if (behavior === "wrong-hash") result.input_sha256 = "0".repeat(64);
      if (behavior === "wrong-job") result.job_id = "e".repeat(32);
      chunk = Buffer.from(frame.encodeFrame(result));
    }
    if (writes === 2 && behavior === "hold-stdout") {
      // A descendant keeps the output open after the launcher exits.
      const holder = require("child_process").spawn("sleep", ["30"], {
        stdio: ["ignore", "inherit", "ignore"],
        detached: true,
      });
      fs.writeFileSync(path.join(root, "holder-" + jobId), String(holder.pid));
      holder.unref();
    }
    if (writes === 2 && behavior === "trailing-same-chunk") {
      chunk = Buffer.concat([chunk, Buffer.from([0])]);
    }
    process.stdout.write(chunk, () => {
      if (writes === 1) {
        // The hello is out.
        if (behavior === "crash") process.exit(5);
        if (behavior === "oom") {
          fs.writeFileSync(path.join(leaf, "memory.events.local"), "oom_kill 1\n");
          process.exit(137);
        }
        if (behavior === "garbage") {
          process.stdout.write(Buffer.from([0xff, 0xff, 0xff, 0xff]));
        }
        if (behavior === "stall" || behavior === "cpu") {
          setInterval(() => {}, 1000);
          return;
        }
      }
      cb();
    });
  },
  final(cb) {
    if (behavior === "trailing") process.stdout.write(Buffer.from([0]));
    // (Not ending its output: the descendant holding it keeps it open.
    // stdio is a socketpair, so ending it would shut it for every holder.)
    if (behavior === "hold-stdout") return cb();
    process.stdout.end(cb);
  },
});
process.stdin.once("data", () =>
  fs.writeFileSync(path.join(root, "job-received-" + jobId), ""),
);
if (behavior === "stall" || behavior === "cpu") process.stdin.pause();
require(process.env.FAKE_CHILD)
  .runChild({
    input: process.stdin,
    output,
    paths: {
      status: path.join(proc, "status"),
      cgroup: path.join(proc, "cgroup"),
      fdDir: "/proc/self/fd",
      cgroupRoot: path.join(root, "cgroup"),
    },
  })
  .then(
    (code) => {
      return setTimeout(() => process.exit(behavior === "exit-after-result" ? 4 : code), 10);
    },
    (err) => {
      process.stderr.write(String(err) + "\n");
      process.exit(1);
    },
  );
`;

class FakeLauncher implements RecoveryLauncher {
  behavior = "ok";
  stopBusy = false;
  readonly spawned: ChildProcess[] = [];

  constructor() {
    launchers.push(this);
  }

  leaf(jobId: string) {
    return join(root, "cgroup", "cocalc-board-recovery", `job-${jobId}`);
  }

  spawn(jobId: string): ChildProcess {
    const child = spawn(process.execPath, [launcherScript, jobId], {
      env: {
        PATH: process.env.PATH,
        NODE_PATH: join(__dirname, "..", "node_modules"),
        FAKE_ROOT: root,
        FAKE_CHILD: childModule,
        FAKE_BEHAVIOR: this.behavior,
        FAKE_UID: String(process.getuid!()),
        FAKE_GID: String(process.getgid!()),
        FAKE_MEMORY_MAX: MEMORY_MAX,
        FAKE_ALARM_MS: "800",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.spawned.push(child);
    return child;
  }

  async stop(jobId: string, budgetMs: number): Promise<StopReport> {
    const leaf = this.leaf(jobId);
    if (!existsSync(leaf)) {
      writeFileSync(join(root, `tomb-${jobId}`), "");
      return { state: "cancelled" };
    }
    if (this.stopBusy) return { state: "busy" };
    const pid = Number(readFileSync(join(leaf, "cgroup.procs"), "utf8"));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      process.kill(pid, "SIGKILL"); // (the fake's stand-in for cgroup.kill)
    } catch {}
    const until = Date.now() + Math.min(budgetMs, 5000);
    while (alive() && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (alive()) return { state: "busy" };
    const read = (name: string) => readFileSync(join(leaf, name), "utf8");
    const report: StopReport = {
      state: "removed",
      oom_kill: Number(/oom_kill (\d+)/.exec(read("memory.events.local"))![1]),
      usage_usec: Number(/usage_usec (\d+)/.exec(read("cpu.stat"))![1]),
      memory_peak: 0,
      pids_peak: 1,
    };
    rmSync(leaf, { recursive: true });
    return report;
  }

  async cpuUsageUsec(jobId: string): Promise<number | undefined> {
    try {
      const text = readFileSync(join(this.leaf(jobId), "cpu.stat"), "utf8");
      return Number(/usage_usec (\d+)/.exec(text)![1]);
    } catch {
      return undefined;
    }
  }
}

const FAST: Partial<RecoveryLimits> = {
  setupMs: 4_000,
  wallMs: 8_000,
  firstStopMinMs: 500,
  stopWaitMs: 300,
  stopRetryGapMs: 50,
  cpuPollMs: 50,
};

function runner(launcher: FakeLauncher, limits: Partial<RecoveryLimits> = {}) {
  return new RecoveryRunner({
    launcher,
    identity: {
      uid: process.getuid!(),
      gid: process.getgid!(),
      memoryMax: MEMORY_MAX,
      pool: "/cocalc-board-recovery",
    },
    limits: { ...FAST, ...limits },
  });
}

const empty = () => from_str("", BOARD_PRIMARY_KEYS, BOARD_STRING_COLS);
const id = (n: number) => legacyPatchId(1_700_000_000_000 + n);

function board(items: number): { records: JobRecord[]; value: string } {
  let doc = empty();
  const mesgs: any[] = [];
  for (let n = 0; n < items; n++) {
    const next = doc.set({
      type: "item",
      page: "p",
      id: `i${n}`,
      text: `item ${n} `.repeat(20),
    });
    mesgs.push({
      time: id(n),
      wall: 1_700_000_000_000 + n,
      user_id: 0,
      parents: n === 0 ? [] : [id(n - 1)],
      patch: JSON.stringify(doc.make_patch(next)),
      is_snapshot: false,
    });
    doc = next;
  }
  return {
    records: mesgs.map((mesg) => ({
      encoding: DataEncoding.MsgPack,
      raw: encode({ encoding: DataEncoding.MsgPack, mesg }),
    })),
    value: doc.to_str(),
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "board-recovery-"));
  const source = readFileSync(join(__dirname, "recovery-child.ts"), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  childModule = join(root, "recovery-child.js");
  writeFileSync(childModule, js);
  launcherScript = join(root, "fake-launcher.js");
  writeFileSync(launcherScript, LAUNCHER);
  mkdirSync(join(root, "cgroup", "cocalc-board-recovery"), { recursive: true });
});

const launchers: FakeLauncher[] = [];
afterAll(() => {
  for (const launcher of launchers) {
    for (const child of launcher.spawned) child.kill("SIGKILL");
  }
  rmSync(root, { recursive: true, force: true });
});

const leaves = () =>
  require("node:fs").readdirSync(join(root, "cgroup", "cocalc-board-recovery"));

test("complete: the board's value, its leaf removed, its slot released", async () => {
  const launcher = new FakeLauncher();
  const r = runner(launcher);
  const { records, value } = board(20);
  const out = await r.run(() => records);
  expect(out).toMatchObject({
    state: "complete",
    verdict: "clean",
    value,
    report: { state: "removed", oom_kill: 0 },
  });
  expect(out.state === "complete" && out.identifiers).toHaveLength(20);
  expect(leaves()).toEqual([]);
  expect(r.counts).toEqual({ active: 0, held: 0, waiting: 0 });
}, 30_000);

test("the host's event loop stays responsive (no task of 50 ms or more)", async () => {
  const launcher = new FakeLauncher();
  let last = performance.now();
  let worst = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 5);
  const { records } = board(400);
  // (Building the board above is outside the measurement.)
  last = performance.now();
  worst = 0;
  const out = await runner(launcher).run(() => records);
  clearInterval(ticker);
  expect(out.state).toBe("complete");
  expect(worst).toBeLessThan(50);
}, 60_000);

test("refused: the launcher denies, and nothing runs", async () => {
  const launcher = new FakeLauncher();
  launcher.behavior = "deny";
  const out = await runner(launcher).run(() => board(2).records);
  expect(out).toMatchObject({ state: "refused", reason: "recovery-busy" });
}, 30_000);

test.each([
  ["wrong-uid", /runs as 0:/],
  ["extra-fd", /fd \d+ open on/],
])(
  "refused: a hello that doesn't verify (%s), and no history sent",
  async (behavior, reason) => {
    const launcher = new FakeLauncher();
    launcher.behavior = behavior;
    const out = await runner(launcher).run(() => board(2).records);
    expect(out.state).toBe("refused");
    expect(out.state !== "complete" && out.reason).toMatch(
      /isolation-unverified/,
    );
    expect(out.state !== "complete" && out.reason).toMatch(reason);
    expect(existsSync(join(root, `job-received-${out.jobId}`))).toBe(false);
    expect(leaves()).toEqual([]);
  },
  30_000,
);

test("timeout: setup (no hello), cancelled through stop", async () => {
  const launcher = new FakeLauncher();
  launcher.behavior = "hang";
  const out = await runner(launcher, { setupMs: 500 }).run(
    () => board(2).records,
  );
  expect(out).toMatchObject({
    state: "timeout",
    reason: "setup",
    report: { state: "cancelled" },
    // Its launcher exited (at its alarm): the slot is released.
    held: false,
  });
  // The launch was tombstoned: it can't create its leaf later.
  expect(existsSync(join(root, `tomb-${out.jobId}`))).toBe(true);
}, 30_000);

test("timeout: the CPU budget", async () => {
  const launcher = new FakeLauncher();
  launcher.behavior = "cpu";
  const out = await runner(launcher).run(() => board(2).records);
  expect(out).toMatchObject({ state: "timeout", reason: "cpu" });
  expect(leaves()).toEqual([]);
}, 30_000);

test("timeout: the wall clock, for a stalled child", async () => {
  const launcher = new FakeLauncher();
  launcher.behavior = "stall";
  const start = performance.now();
  const out = await runner(launcher, { wallMs: 1_500 }).run(
    () => board(2).records,
  );
  expect(out).toMatchObject({ state: "timeout", reason: "wall" });
  expect(performance.now() - start).toBeLessThan(1_500 + 500 + 1_000);
}, 30_000);

test("oom only when oom_kill advanced; a plain non-zero exit is a crash", async () => {
  const launcher = new FakeLauncher();
  launcher.behavior = "oom";
  expect(await runner(launcher).run(() => board(2).records)).toMatchObject({
    state: "oom",
  });
  launcher.behavior = "crash";
  expect(await runner(launcher).run(() => board(2).records)).toMatchObject({
    state: "crash",
  });
}, 30_000);

test("a result followed by a non-zero exit is a crash, never complete", async () => {
  const launcher = new FakeLauncher();
  launcher.behavior = "exit-after-result";
  const out = await runner(launcher).run(() => board(2).records);
  expect(out.state).toBe("crash");
}, 30_000);

test.each([
  ["garbage", /over its cap/],
  ["trailing", /after the last frame/],
  ["wrong-hash", /another input/],
  ["wrong-job", /another job/],
])(
  "protocol-error: %s",
  async (behavior, reason) => {
    const launcher = new FakeLauncher();
    launcher.behavior = behavior;
    const out = await runner(launcher).run(() => board(2).records);
    expect(out.state).toBe("protocol-error");
    expect(out.state !== "complete" && out.reason).toMatch(reason);
  },
  30_000,
);

test("busy: beyond the active slots and the queue, refused at once", async () => {
  const launcher = new FakeLauncher();
  launcher.behavior = "stall";
  const r = runner(launcher, { maxActive: 1, maxQueue: 0, wallMs: 1_500 });
  const first = r.run(() => board(2).records);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(await r.run(() => board(2).records)).toEqual({
    state: "refused",
    reason: "busy",
  });
  expect((await first).state).toBe("timeout");
}, 30_000);

test("a slot whose cleanup is never confirmed stays held", async () => {
  const launcher = new FakeLauncher();
  launcher.behavior = "stall";
  launcher.stopBusy = true;
  const r = runner(launcher, {
    maxActive: 1,
    maxQueue: 0,
    wallMs: 1_000,
    firstStopMinMs: 300,
  });
  const out = await r.run(() => board(2).records);
  expect(out).toMatchObject({ state: "timeout", held: true });
  expect(r.counts.held).toBe(1);
  expect(await r.run(() => board(2).records)).toMatchObject({
    state: "refused",
    reason: "busy",
  });
}, 30_000);

test("a late launch after its cancellation creates nothing", async () => {
  const launcher = new FakeLauncher();
  const jobId = "f".repeat(32);
  expect(await launcher.stop(jobId, 1000)).toEqual({ state: "cancelled" });
  const child = launcher.spawn(jobId);
  const code = await new Promise((resolve) => child.on("exit", resolve));
  expect(code).toBe(3);
  expect(existsSync(launcher.leaf(jobId))).toBe(false);
}, 30_000);

describe("daybreak2's benchmark: the parent's work on maximal frames", () => {
  test("a maximal 64 MiB job is sent without a 50 ms task on the host's loop", async () => {
    const L = BOARD_HISTORY_LIMITS;
    const each = Math.floor((L.totalBytes - L.recordBytes) / (L.records - 1));
    const raw = new Uint8Array(each);
    // (Not board records: the child finds them invalid at once. The point
    // is the parent's sending.)
    const records: JobRecord[] = [
      { encoding: DataEncoding.JsonCodec, raw: new Uint8Array(L.recordBytes) },
      ...Array.from({ length: L.records - 1 }, () => ({
        encoding: DataEncoding.JsonCodec,
        raw,
      })),
    ];
    let last = performance.now();
    let worst = 0;
    const ticker = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 5);
    const out = await runner(new FakeLauncher(), { wallMs: 60_000 }).run(
      () => records,
    );
    clearInterval(ticker);
    expect(out).toMatchObject({ state: "complete", verdict: "invalid" });
    console.log(`maximal job: the host's longest task ${worst.toFixed(1)} ms`);
    expect(worst).toBeLessThan(50);
  }, 120_000);

  test("decoding a maximal result frame in the parent takes under 50 ms", () => {
    const id = "x".repeat(BOARD_HISTORY_LIMITS.idChars);
    const body = encodeFrame({
      v: 1,
      type: "result",
      job_id: "0".repeat(32),
      input_sha256: "a".repeat(64),
      verdict: "clean",
      value: "v".repeat(RECOVERY_VALUE_CAP),
      identifiers: Array(BOARD_HISTORY_LIMITS.records).fill(id),
    }).subarray(4);
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      decodeFrameBody("result", body);
      times.push(performance.now() - start);
    }
    console.log(
      `maximal result decode: ${times.map((t) => t.toFixed(1)).join(", ")} ms`,
    );
    expect(Math.min(...times)).toBeLessThan(50);
  });
});

describe("astra's #1240 review (CORR-DFC-2..5) and the lazy queue", () => {
  test("CORR-DFC-5: the hello must name exactly <pool>/job-<id>", () => {
    const jobId = "a".repeat(32);
    const identity = {
      uid: 1,
      gid: 1,
      memoryMax: MEMORY_MAX,
      pool: "/cocalc-board-recovery",
    };
    const hello = (cgroup: string) => ({
      v: 1 as const,
      type: "hello" as const,
      job_id: jobId,
      uid: 1,
      gid: 1,
      groups: [],
      no_new_privs: 1,
      cap_eff: "0",
      cap_prm: "0",
      fds: [],
      cgroup,
      limits: { memory_max: MEMORY_MAX, swap_max: "0" },
    });
    expect(
      verifyHello(
        hello(`/cocalc-board-recovery/job-${jobId}`),
        jobId,
        identity,
      ),
    ).toBeUndefined();
    for (const wrong of [
      `/wrong-pool/job-${jobId}`,
      `/x/cocalc-board-recovery/job-${jobId}`,
      `/cocalc-board-recovery/../cocalc-board-recovery/job-${jobId}`,
      `/cocalc-board-recovery/job-${jobId}/`,
      `/cocalc-board-recovery/sub/job-${jobId}`,
      `cocalc-board-recovery/job-${jobId}`,
    ]) {
      expect(verifyHello(hello(wrong), jobId, identity)).toMatch(
        /not its job's leaf/,
      );
    }
  });

  test("CORR-DFC-2: a trailing byte in the result's own chunk is a protocol error", async () => {
    const launcher = new FakeLauncher();
    launcher.behavior = "trailing-same-chunk";
    const out = await runner(launcher).run(() => board(2).records);
    expect(out).toMatchObject({ state: "protocol-error" });
    expect(out.state !== "complete" && out.reason).toMatch(
      /after the last frame/,
    );
  }, 30_000);

  test("CORR-DFC-2: an exit whose output a descendant keeps open is never complete", async () => {
    const launcher = new FakeLauncher();
    launcher.behavior = "hold-stdout";
    const start = performance.now();
    const out = await runner(launcher, { wallMs: 1_500 }).run(
      () => board(2).records,
    );
    try {
      // Never complete: the wait for the output's end runs into the wall
      // deadline (timeout outranks protocol-error).
      expect(out).toMatchObject({ state: "timeout", reason: "wall" });
      // Within the envelope.
      expect(performance.now() - start).toBeLessThan(1_500 + 500 + 1_000);
    } finally {
      const holder = join(root, `holder-${out.jobId}`);
      if (existsSync(holder)) {
        try {
          process.kill(Number(readFileSync(holder, "utf8")), "SIGKILL");
        } catch {}
      }
    }
  }, 30_000);

  test("CORR-DFC-3: a stop that never answers: the job still reports in time, its slot held", async () => {
    const launcher = new FakeLauncher();
    launcher.behavior = "deny";
    launcher.stop = () => new Promise<StopReport>(() => {});
    const r = runner(launcher, {
      wallMs: 300,
      firstStopMinMs: 500,
      maxActive: 1,
      maxQueue: 0,
    });
    const start = performance.now();
    const out = await r.run(() => board(2).records);
    expect(performance.now() - start).toBeLessThan(300 + 500 + 500);
    expect(out).toMatchObject({ held: true, report: { state: "failed" } });
    expect(r.counts.held).toBe(1);
  }, 30_000);

  test("CORR-DFC-3: a stop that answers after its deadline changes nothing", async () => {
    const launcher = new FakeLauncher();
    launcher.behavior = "deny";
    let answer: (r: StopReport) => void = () => {};
    launcher.stop = () =>
      new Promise<StopReport>((resolve) => (answer = resolve));
    const r = runner(launcher, {
      wallMs: 200,
      firstStopMinMs: 300,
      maxActive: 1,
      maxQueue: 0,
    });
    const out = await r.run(() => board(2).records);
    expect(out).toMatchObject({ held: true });
    answer({ state: "removed", oom_kill: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Still held: a late confirmation releases nothing.
    expect(r.counts.held).toBe(1);
    expect(out).toMatchObject({ held: true, report: { state: "failed" } });
  }, 30_000);

  test("CORR-DFC-4: a denial that arrives after the setup deadline is timeout(setup)", async () => {
    const launcher = new FakeLauncher();
    launcher.behavior = "deny";
    const r = runner(launcher, { setupMs: 50 });
    const running = r.run(() => board(2).records);
    // (The launch starts on a later tick, after the history is loaded.)
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The host's loop is busy past the setup deadline while the denial
    // arrives: it is late, whichever event runs first.
    const until = performance.now() + 400;
    while (performance.now() < until) {}
    expect(await running).toMatchObject({ state: "timeout", reason: "setup" });
  }, 30_000);

  test("CORR-DFC-4: an over-cap hello header followed by a denial is a protocol error", async () => {
    const launcher = new FakeLauncher();
    launcher.behavior = "garbage-then-deny";
    const out = await runner(launcher).run(() => board(2).records);
    expect(out.state).toBe("protocol-error");
    expect(out.state !== "complete" && out.reason).toMatch(/over its cap/);
  }, 30_000);

  test("the queue holds no history: a queued job's history is read only once it has a slot", async () => {
    const launcher = new FakeLauncher();
    launcher.behavior = "stall";
    const r = runner(launcher, { maxActive: 1, maxQueue: 1, wallMs: 1_000 });
    const first = r.run(() => board(2).records);
    const load = jest.fn(() => board(2).records);
    await new Promise((resolve) => setTimeout(resolve, 100));
    launcher.behavior = "ok";
    const second = r.run(load);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(r.counts.waiting).toBe(1);
    expect(load).not.toHaveBeenCalled();
    expect((await first).state).toBe("timeout");
    expect((await second).state).toBe("complete");
    expect(load).toHaveBeenCalledTimes(1);
  }, 30_000);
});

// A stand-in child process: the runner's whole lifecycle, driven exactly.
describe("astra's round-2 re-review (CORR-DFC-2/3/4), with a stand-in child", () => {
  const { EventEmitter } = require("node:events");
  const { PassThrough } = require("node:stream");
  const { createHash } = require("node:crypto");

  class StandIn implements RecoveryLauncher {
    procs: any[] = [];
    ids: string[] = [];
    stopImpl: (jobId: string, budget: number) => Promise<StopReport> =
      async () => ({ state: "removed", oom_kill: 0 });
    spawn(jobId: string): ChildProcess {
      const proc: any = new EventEmitter();
      proc.stdin = new PassThrough();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      this.procs.push(proc);
      this.ids.push(jobId);
      return proc;
    }
    stop(jobId: string, budget: number) {
      return this.stopImpl(jobId, budget);
    }
    async cpuUsageUsec() {
      return 0;
    }
  }

  const hello = (jobId: string, uid = process.getuid!()) =>
    encodeFrame({
      v: 1,
      type: "hello",
      job_id: jobId,
      uid,
      gid: process.getgid!(),
      groups: [],
      no_new_privs: 1,
      cap_eff: "0",
      cap_prm: "0",
      fds: [],
      cgroup: `/cocalc-board-recovery/job-${jobId}`,
      limits: { memory_max: MEMORY_MAX, swap_max: "0" },
    });

  // Reads the job the runner sends, and answers with a valid result.
  async function answer(proc: any, jobId: string) {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve) => {
      proc.stdin.on("data", (b: Buffer) => chunks.push(b));
      proc.stdin.on("end", resolve);
    });
    const body = Buffer.concat(chunks).subarray(4);
    proc.stdout.write(
      encodeFrame({
        v: 1,
        type: "result",
        job_id: jobId,
        input_sha256: createHash("sha256").update(body).digest("hex"),
        verdict: "clean",
        value: "{}",
        identifiers: [],
      }),
    );
  }

  async function started(launcher: StandIn) {
    while (launcher.procs.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    return { proc: launcher.procs[0], jobId: launcher.ids[0] };
  }

  test("CORR-DFC-2: output destroyed without an end is never complete", async () => {
    const launcher = new StandIn();
    const running = runner(launcher as any).run(() => []);
    const { proc, jobId } = await started(launcher);
    proc.stdout.write(hello(jobId));
    await answer(proc, jobId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    proc.stdout.destroy();
    proc.emit("exit", 0, null);
    const out = await running;
    expect(out).toMatchObject({
      state: "protocol-error",
      reason: "the child's output closed without an end",
    });
  });

  test("CORR-DFC-2: an output error is a protocol error", async () => {
    const launcher = new StandIn();
    const running = runner(launcher as any).run(() => []);
    const { proc, jobId } = await started(launcher);
    proc.stdout.write(hello(jobId));
    await answer(proc, jobId);
    proc.stdout.destroy(new Error("EPIPE"));
    proc.emit("exit", 0, null);
    expect(await running).toMatchObject({ state: "protocol-error" });
  });

  test("CORR-DFC-2: a clean end after a valid result is complete", async () => {
    const launcher = new StandIn();
    const running = runner(launcher as any).run(() => []);
    const { proc, jobId } = await started(launcher);
    proc.stdout.write(hello(jobId));
    await answer(proc, jobId);
    proc.stdout.end();
    proc.emit("exit", 0, null);
    expect(await running).toMatchObject({ state: "complete", value: "{}" });
  });

  test.each([
    [
      "a synchronous throw",
      () => {
        throw new Error("sync stop EIO");
      },
    ],
    ["a rejected promise", async () => Promise.reject(new Error("stop EIO"))],
  ])(
    "CORR-DFC-3: a stop that fails with %s: a terminal state, the slot held",
    async (_name, stop) => {
      const launcher = new StandIn();
      launcher.stopImpl = stop as any;
      const r = runner(launcher as any, { maxActive: 1, maxQueue: 0 });
      const running = r.run(() => []);
      const { proc, jobId } = await started(launcher);
      proc.stdout.write(hello(jobId));
      await answer(proc, jobId);
      proc.stdout.end();
      proc.emit("exit", 0, null);
      const out = await running;
      expect(out).toMatchObject({
        state: "crash",
        reason: "cleanup unconfirmed",
        held: true,
        report: { state: "failed", message: expect.stringContaining("EIO") },
      });
      expect(r.counts).toMatchObject({ active: 0, held: 1 });
    },
  );

  test("CORR-DFC-3: output held open and a stop that hangs: reported by wall + one margin", async () => {
    const launcher = new StandIn();
    launcher.stopImpl = () => new Promise<StopReport>(() => {});
    const r = runner(launcher as any, {
      wallMs: 300,
      firstStopMinMs: 200,
      setupMs: 250,
    });
    const start = performance.now();
    const running = r.run(() => []);
    const { proc, jobId } = await started(launcher);
    proc.stdout.write(hello(jobId));
    await answer(proc, jobId);
    // Exit, with the output never ended.
    proc.emit("exit", 0, null);
    const out = await running;
    const took = performance.now() - start;
    expect(out).toMatchObject({ state: "timeout", reason: "wall", held: true });
    // One envelope (wall 300 + margin 200), not the margin twice (700).
    expect(took).toBeLessThan(600);
    expect(took).toBeGreaterThanOrEqual(490);
  });

  test.each([
    ["a wrong-UID hello", (jobId: string) => hello(jobId, 0)],
    ["a malformed hello", () => Uint8Array.from([0, 0, 0, 2, 0xc1, 0xc1])],
  ])(
    "CORR-DFC-4: %s after a blocked setup deadline is timeout(setup)",
    async (_name, frame) => {
      const launcher = new StandIn();
      const running = runner(launcher as any, { setupMs: 5 }).run(() => []);
      const { proc, jobId } = await started(launcher);
      // The loop is held past the setup deadline; then the hello arrives,
      // before the setup timer's callback can run.
      const until = performance.now() + 20;
      while (performance.now() < until) {}
      proc.stdout.write(frame(jobId));
      proc.stdout.end();
      proc.emit("exit", 0, null);
      expect(await running).toMatchObject({
        state: "timeout",
        reason: "setup",
      });
    },
  );
});
