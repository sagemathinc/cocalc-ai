import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  MANIFEST_SCHEMA,
  canonicalJson,
  currentPlatform,
} from "@cocalc/util/cli-distribution/schema";

import {
  type CliState,
  type FaultPoint,
  STATE_SCHEMA,
  claimSlot,
  installRelease,
  readActive,
  readState,
  recover,
  rollback,
  withLock,
} from "./local";

const ORIGIN = "https://cocalc.example";

// The compiled test runs from build/test/..., so look upward for dist-release.
function distRelease(): string {
  for (let dir = __dirname; dir !== "/"; dir = dirname(dir)) {
    if (existsSync(join(dir, "dist-release", "launcher.sh"))) {
      return join(dir, "dist-release");
    }
  }
  throw new Error("dist-release not found");
}
const LAUNCHER = join(distRelease(), "launcher.sh");
const BOOTSTRAP = join(distRelease(), "bootstrap.js");

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

// A fake origin: content-addressed files plus manifests built from them.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "cli-dist-test-"));
  const files = new Map<string, Buffer>();
  const add = (data: Buffer | string) => {
    const buffer = Buffer.from(data);
    files.set(sha256(buffer), buffer);
    return { sha256: sha256(buffer), size: buffer.length };
  };
  // A "Node" that runs the real node, so the bootstrap and bundle really run.
  const platform = currentPlatform() ?? "linux-x64";
  const nodeDir = `node-v26.0.0-${platform}`;
  const nodeScript = `#!/bin/sh\nexec ${process.execPath} "$@"\n`;
  mkdirSync(join(dir, "archive", nodeDir, "bin"), { recursive: true });
  writeFileSync(join(dir, "archive", nodeDir, "bin", "node"), nodeScript, {
    mode: 0o755,
  });
  writeFileSync(join(dir, "archive", nodeDir, "LICENSE"), "MIT\n");
  execFileSync("tar", [
    "-czf",
    join(dir, "node.tar.gz"),
    "-C",
    join(dir, "archive"),
    nodeDir,
  ]);
  const node = add(readFileSync(join(dir, "node.tar.gz")));
  const launcher = add(readFileSync(LAUNCHER));
  const bootstrap = add(readFileSync(BOOTSTRAP));
  const release = (n: number) => {
    const bundle = add(
      `console.log(JSON.stringify({release: ${n}, args: process.argv.slice(2), opts: process.env.NODE_OPTIONS ?? null}));\n`,
    );
    const text = canonicalJson(
      {
        schema: MANIFEST_SCHEMA,
        release: n,
        version: `1.0.${n}`,
        git: "abcdef1",
        built_at: "2026-10-13T00:00:00Z",
        launcher,
        bootstrap,
        bundle,
        node: {
          version: "26.0.0",
          platforms: {
            [platform]: {
              ...node,
              url: "https://nodejs.org/dist/x.tar.gz",
              dir: nodeDir,
              binary: { sha256: sha256(nodeScript), size: nodeScript.length },
            },
          },
        },
      },
      true,
    );
    return { text, hash: sha256(text), bundle: bundle.sha256 };
  };
  const fetched: string[] = [];
  const fetchFile = async (hash: string, dest: string, size: number) => {
    const data = files.get(hash);
    assert.ok(data, `unknown file ${hash}`);
    assert.equal(data.length, size);
    fetched.push(hash);
    writeFileSync(dest, data);
  };
  const root = join(dir, "root");
  const launcherPath = join(dir, "bin", "cocalc");
  const initialState = (current: CliState | undefined): CliState =>
    current ?? {
      schema: STATE_SCHEMA,
      origin: ORIGIN,
      mode: "origin-trust",
      auto: true,
      held_at: null,
      launcher: launcherPath,
      origins: {},
    };
  const install = (
    n: ReturnType<typeof release>,
    faultAt?: FaultPoint,
    origin = ORIGIN,
  ) =>
    installRelease({
      root,
      origin,
      manifestText: n.text,
      manifestHash: n.hash,
      fetchFile,
      prepareState: (s) => ({ ...initialState(s), origin }),
      faultAt,
    });
  const run = (...args: string[]) =>
    spawnSync(launcherPath, args, {
      encoding: "utf8",
      env: { ...process.env, COCALC_CLI_ROOT: root, NODE_OPTIONS: "--inspect" },
    });
  const runs = () => JSON.parse(run().stdout).release;
  return {
    dir,
    root,
    launcherPath,
    release,
    install,
    fetched,
    run,
    runs,
    fetchFile,
  };
}

test("install, run through the launcher, update, rollback with a hold", async () => {
  const f = fixture();
  const r1 = f.release(100);
  await f.install(r1);
  const out = f.run("a b", "c");
  assert.equal(out.status, 0, out.stderr);
  // Arguments arrive exactly; NODE_OPTIONS is cleared by the launcher.
  assert.deepEqual(JSON.parse(out.stdout), {
    release: 100,
    args: ["a b", "c"],
    opts: null,
  });

  const fetchedBefore = f.fetched.length;
  const r2 = f.release(101);
  const result = await f.install(r2);
  assert.equal(result.changed, true);
  // Only the new bundle was downloaded; Node, bootstrap and launcher reused.
  assert.equal(f.fetched.length - fetchedBefore, 1);
  assert.equal(f.runs(), 101);
  assert.equal(
    (await readActive(f.root, "previous"))?.pointer.manifest,
    r1.hash,
  );

  await rollback(f.root);
  assert.equal(f.runs(), 100);
  const state = await readState(f.root);
  assert.equal(state?.held_at, 100);
  // Rollback never lowers the floor.
  assert.equal(state?.origins[ORIGIN].highest_seen, 101);
});

test("releases below the floor are refused under the lock", async () => {
  const f = fixture();
  await f.install(f.release(11));
  await assert.rejects(f.install(f.release(10)), /not downgrading/);
  assert.equal(f.runs(), 11);
  // The same after switching away and back to an origin.
  await f.install(f.release(5), undefined, "https://other.example");
  await assert.rejects(f.install(f.release(10)), /not downgrading/);
  // Concurrent updates to 20 and 21 always end at 21.
  const results = await Promise.allSettled([
    f.install(f.release(20)),
    f.install(f.release(21)),
  ]);
  assert.equal(f.runs(), 21);
  for (const r of results) {
    if (r.status === "rejected") assert.match(`${r.reason}`, /not downgrading/);
  }
});

test("one release number names one manifest", async () => {
  const f = fixture();
  await f.install(f.release(200));
  const before = readFileSync(join(f.root, "active"), "utf8");
  const other = f.release(200);
  const changed = other.text.replace('"1.0.200"', '"1.0.999"');
  await assert.rejects(
    installRelease({
      root: f.root,
      origin: ORIGIN,
      manifestText: changed,
      manifestHash: sha256(changed),
      fetchFile: f.fetchFile,
      prepareState: (s) => s!,
    }),
    /different manifest/,
  );
  assert.equal(readFileSync(join(f.root, "active"), "utf8"), before);
});

test("a manifest that does not match its hash is refused", async () => {
  const f = fixture();
  const r = f.release(300);
  await assert.rejects(
    installRelease({
      root: f.root,
      origin: ORIGIN,
      manifestText: r.text,
      manifestHash: "0".repeat(64),
      fetchFile: f.fetchFile,
      prepareState: (s) => s!,
    }),
    /does not match/,
  );
});

test("garbage collection keeps only active and previous", async () => {
  const f = fixture();
  for (const n of [400, 401, 402, 403]) await f.install(f.release(n));
  assert.equal(readdirSync(join(f.root, "manifests")).length, 2);
  // Two bundles plus the shared bootstrap.
  assert.equal(readdirSync(join(f.root, "targets")).length, 3);
});

for (const point of [
  "after-floors",
  "after-journal",
  "after-launcher",
  "after-active",
] as FaultPoint[]) {
  test(`a crash ${point} leaves the old or new release, and the next update completes`, async () => {
    const f = fixture();
    await f.install(f.release(500));
    await assert.rejects(f.install(f.release(501), point), /injected fault/);
    await withLock(f.root, () => recover(f.root));
    assert.ok([500, 501].includes(f.runs()));
    assert.equal(existsSync(join(f.root, "transition.json")), false);
    // Floors were raised before the switch, never lowered.
    assert.equal((await readState(f.root))?.origins[ORIGIN].highest_seen, 501);
    if (point === "after-active") {
      assert.equal(f.runs(), 501);
      assert.ok(existsSync(join(f.root, "previous")));
    }
    await f.install(f.release(501));
    assert.equal(f.runs(), 501);
  });
}

test("recovery completes or discards an interrupted switch", async () => {
  const f = fixture();
  await f.install(f.release(600));
  const a = readFileSync(join(f.root, "active"), "utf8");
  await f.install(f.release(601));
  const b = readFileSync(join(f.root, "active"), "utf8");

  writeFileSync(join(f.root, "previous"), "stale\n");
  writeFileSync(
    join(f.root, "transition.json"),
    JSON.stringify({ from: a, to: b }),
  );
  await withLock(f.root, () => recover(f.root));
  assert.equal(readFileSync(join(f.root, "previous"), "utf8"), a);

  writeFileSync(
    join(f.root, "transition.json"),
    JSON.stringify({ from: b, to: a }),
  );
  await withLock(f.root, () => recover(f.root));
  assert.equal(readFileSync(join(f.root, "active"), "utf8"), b);

  writeFileSync(join(f.root, "transition.json"), "{");
  await withLock(f.root, () => recover(f.root));
  assert.equal(existsSync(join(f.root, "transition.json")), false);
});

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the lock: mutual exclusion among many contenders", async () => {
  const f = fixture();
  let inside = 0;
  let max = 0;
  await Promise.all(
    Array.from({ length: 8 }, () =>
      withLock(f.root, async () => {
        inside += 1;
        max = Math.max(max, inside);
        await sleep(5);
        inside -= 1;
      }),
    ),
  );
  assert.equal(max, 1);
  // Only the newest slot (and its done marker) remains.
  assert.deepEqual(readdirSync(join(f.root, "locks")).sort(), ["8", "8.done"]);
});

test("the lock: a live owner is never stolen, however old", async () => {
  const f = fixture();
  mkdirSync(join(f.root, "locks"), { recursive: true });
  const old = `${process.pid} 1 ${"a".repeat(32)}\n`;
  writeFileSync(join(f.root, "locks", "1"), old);
  await assert.rejects(
    withLock(f.root, async () => 1, undefined, 300),
    /holds the lock/,
  );
  assert.equal(readFileSync(join(f.root, "locks", "1"), "utf8"), old);
  assert.equal(existsSync(join(f.root, "locks", "2")), false);
});

test("the lock: a dead owner is followed, not taken over", async () => {
  const f = fixture();
  mkdirSync(join(f.root, "locks"), { recursive: true });
  writeFileSync(join(f.root, "locks", "1"), `999999999 1 ${"b".repeat(32)}\n`);
  assert.equal(await withLock(f.root, async () => 7), 7);
  assert.deepEqual(readdirSync(join(f.root, "locks")).sort(), ["2", "2.done"]);
});

test("the lock: the stale-takeover schedule A/B/C keeps exclusion", async () => {
  // Slot 1 is held by a dead owner. A decides to claim slot 2 and pauses;
  // B claims slot 2 and enters; C arrives; then A resumes.
  const f = fixture();
  mkdirSync(join(f.root, "locks"), { recursive: true });
  writeFileSync(join(f.root, "locks", "1"), `999999999 1 ${"d".repeat(32)}\n`);
  let inside = 0;
  let max = 0;
  const body = async (wait?: Promise<void>) => {
    inside += 1;
    max = Math.max(max, inside);
    await (wait ?? sleep(5));
    inside -= 1;
  };
  const aPaused = gate();
  const aResume = gate();
  const a = withLock(f.root, () => body(), undefined, 10_000, {
    beforeClaim: async () => {
      aPaused.open();
      await aResume.opened;
    },
  });
  await aPaused.opened;
  const bInside = gate();
  const bRelease = gate();
  const b = withLock(f.root, async () => {
    bInside.open();
    await body(bRelease.opened);
  });
  await bInside.opened;
  const c = withLock(f.root, () => body(), undefined, 10_000);
  await sleep(150);
  aResume.open();
  await sleep(300);
  assert.equal(inside, 1, "only B is inside while it holds the lock");
  bRelease.open();
  await Promise.all([a, b, c]);
  assert.equal(max, 1);
});

test("the lock: a contender with a stale view of collected slots withdraws", async () => {
  const f = fixture();
  for (let i = 0; i < 4; i += 1) await withLock(f.root, async () => {});
  const dir = join(f.root, "locks");
  assert.deepEqual(readdirSync(dir).sort(), ["4", "4.done"]);
  const hold = gate();
  const holding = gate();
  const b = withLock(f.root, async () => {
    holding.open();
    await hold.opened;
  });
  await holding.opened;
  const record = join(dir, ".owner.test");
  writeFileSync(record, `${process.pid} 1 ${"e".repeat(32)}\n`);
  // Slot 3 was collected, so linking it succeeds, but slot 5 is newer.
  assert.equal(await claimSlot(dir, record, 3), false);
  assert.equal(existsSync(join(dir, "3")), false);
  assert.equal(await claimSlot(dir, record, 5), false);
  hold.open();
  await b;
});

test("the launcher and bootstrap refuse broken or mixed-up installs", async () => {
  const f = fixture();
  const r1 = f.release(700);
  await f.install(r1);
  const r2 = f.release(701);
  await f.install(r2);
  const good = readFileSync(join(f.root, "active"), "utf8");
  for (const bad of [
    "v1 junk\n",
    good.slice(0, -1),
    good + "x",
    good.replace("v1 ", "v2 "),
    good.replace(/[0-9a-f]$/m, "G"),
  ]) {
    writeFileSync(join(f.root, "active"), bad);
    const out = f.run();
    assert.equal(out.status, 1, bad);
    assert.match(
      out.stderr,
      /To repair it, reinstall: curl -fsSL https:\/\/cocalc.example\/cli\/install.sh/,
    );
  }
  // The manifest of one release with the bundle of another.
  writeFileSync(join(f.root, "active"), good.replace(r2.bundle, r1.bundle));
  const mixed = f.run();
  assert.equal(mixed.status, 1);
  assert.match(mixed.stderr, /does not match its manifest/);

  writeFileSync(join(f.root, "active"), good);
  writeFileSync(
    join(f.root, "targets", r2.bundle, "cocalc.js"),
    "process.exit(9)\n",
  );
  const damaged = f.run();
  assert.equal(damaged.status, 1);
  assert.match(damaged.stderr, /damaged/);
});
