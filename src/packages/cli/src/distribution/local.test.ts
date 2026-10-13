import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
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
  currentPlatform,
} from "@cocalc/util/cli-distribution/schema";

import {
  type CliState,
  STATE_SCHEMA,
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
  const nodeDir = "node-v26.0.0-" + (currentPlatform() ?? "linux-x64");
  mkdirSync(join(dir, "archive", nodeDir, "bin"), { recursive: true });
  writeFileSync(
    join(dir, "archive", nodeDir, "bin", "node"),
    `#!/bin/sh\nexec ${process.execPath} "$@"\n`,
    { mode: 0o755 },
  );
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
    const text =
      JSON.stringify({
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
            [currentPlatform() ?? "linux-x64"]: {
              ...node,
              url: "https://nodejs.org/dist/x.tar.gz",
              dir: nodeDir,
            },
          },
        },
      }) + "\n";
    return { text, hash: sha256(text) };
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
  const install = (n: ReturnType<typeof release>) =>
    installRelease({
      root,
      origin: ORIGIN,
      manifestText: n.text,
      manifestHash: n.hash,
      fetchFile,
      prepareState: initialState,
    });
  const run = (...args: string[]) =>
    spawnSync(launcherPath, args, {
      encoding: "utf8",
      env: { ...process.env, COCALC_CLI_ROOT: root, NODE_OPTIONS: "--inspect" },
    });
  return { dir, root, launcherPath, release, install, fetched, run, fetchFile };
}

test("install, run through the launcher, update, rollback with a hold", async () => {
  const f = fixture();
  const r1 = f.release(100);
  await f.install(r1);
  let out = f.run("a b", "c");
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
  assert.equal(JSON.parse(f.run().stdout).release, 101);
  assert.equal(
    (await readActive(f.root, "previous"))?.pointer.manifest,
    r1.hash,
  );

  await rollback(f.root);
  assert.equal(JSON.parse(f.run().stdout).release, 100);
  const state = await readState(f.root);
  assert.equal(state?.held_at, 100);
  // Rollback never lowers the floor.
  assert.equal(state?.origins[ORIGIN].highest_seen, 101);
  assert.equal(
    (await readActive(f.root, "previous"))?.pointer.manifest,
    r2.hash,
  );
});

test("one release number names one manifest", async () => {
  const f = fixture();
  await f.install(f.release(200));
  const before = readFileSync(join(f.root, "active"), "utf8");
  // A different manifest under the same number (a different bundle).
  const other = f.release(200);
  const changed = other.text.replace(
    '"version":"1.0.200"',
    '"version":"1.0.999"',
  );
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

test("recovery completes or discards an interrupted switch", async () => {
  const f = fixture();
  const r1 = f.release(500);
  await f.install(r1);
  const a = readFileSync(join(f.root, "active"), "utf8");
  await f.install(f.release(501));
  const b = readFileSync(join(f.root, "active"), "utf8");

  // Crash after `active` was switched but before `previous` was written.
  writeFileSync(join(f.root, "previous"), "stale\n");
  writeFileSync(
    join(f.root, "transition.json"),
    JSON.stringify({ from: a, to: b }),
  );
  await withLock(f.root, () => recover(f.root));
  assert.equal(readFileSync(join(f.root, "previous"), "utf8"), a);
  assert.equal(existsSync(join(f.root, "transition.json")), false);

  // Crash before `active` was switched: the journal is discarded and the old
  // release stays active.
  writeFileSync(
    join(f.root, "transition.json"),
    JSON.stringify({ from: b, to: a }),
  );
  await withLock(f.root, () => recover(f.root));
  assert.equal(readFileSync(join(f.root, "active"), "utf8"), b);
  assert.equal(existsSync(join(f.root, "transition.json")), false);

  // A torn journal is discarded too.
  writeFileSync(join(f.root, "transition.json"), "{");
  await withLock(f.root, () => recover(f.root));
  assert.equal(existsSync(join(f.root, "transition.json")), false);
});

test("a stale lock from a dead process is taken over", async () => {
  const f = fixture();
  mkdirSync(f.root, { recursive: true });
  writeFileSync(join(f.root, "lock"), `999999999 ${Date.now()}\n`);
  assert.equal(await withLock(f.root, async () => 7), 7);
  assert.equal(existsSync(join(f.root, "lock")), false);
});

test("the launcher refuses malformed pointers and incomplete installs", async () => {
  const f = fixture();
  await f.install(f.release(600));
  const good = readFileSync(join(f.root, "active"), "utf8");
  const cases = [
    "v1 junk\n",
    good.slice(0, -1), // no newline
    good + "x",
    good.replace("v1 ", "v2 "),
    good.replace(/[0-9a-f]$/m, "G"),
  ];
  for (const bad of cases) {
    writeFileSync(join(f.root, "active"), bad);
    const out = f.run();
    assert.equal(out.status, 1, bad);
    assert.match(
      out.stderr,
      /To repair it, reinstall: curl -fsSL https:\/\/cocalc.example\/cli\/install.sh/,
    );
  }
  writeFileSync(join(f.root, "active"), good);
  const bundle = good.trim().split(" ")[4];
  copyFileSync(
    join(f.root, "targets", bundle, "cocalc.js"),
    join(f.dir, "bundle.save"),
  );
  writeFileSync(
    join(f.root, "targets", bundle, "cocalc.js"),
    "process.exit(9)\n",
  );
  const damaged = f.run();
  assert.equal(damaged.status, 1);
  assert.match(damaged.stderr, /damaged/);
});
