import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  lstatSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { constants, zstdCompressSync } from "node:zlib";

import {
  POINTER_SCHEMA,
  canonicalJson,
  currentPlatform,
} from "@cocalc/util/cli-distribution/schema";
import { PLUS_MANIFEST_SCHEMA } from "@cocalc/util/cli-distribution/plus-schema";

import {
  type CliState,
  STATE_SCHEMA,
  readActive,
  readState,
  switchActive,
  withLock,
  writeState,
} from "./local";
import {
  type DataFault,
  installPlusRelease,
  plusRollback,
  pathWithin,
  prepareServer,
  recoverData,
  renamable,
} from "./plus";
import { HeldError, updatePlusFromOrigin, updateState } from "./plus-update";

const ORIGIN = "https://software.example/software/plus";

function plusDistRelease(): string {
  for (let dir = __dirname; dir !== "/"; dir = dirname(dir)) {
    const candidate = join(dir, "plus", "dist-release");
    if (existsSync(join(candidate, "launcher.sh"))) return candidate;
    const sibling = join(dir, "..", "plus", "dist-release");
    if (existsSync(join(sibling, "launcher.sh"))) return sibling;
  }
  throw new Error("plus/dist-release not found");
}

const sha256 = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");

function tarZst(cwd: string, entries: string[]): Buffer {
  const tar = execFileSync("tar", ["-cf", "-", "-C", cwd, ...entries], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return zstdCompressSync(tar, {
    params: { [constants.ZSTD_c_compressionLevel]: 3 },
  });
}

function fixture(rootName = "root") {
  const dir = mkdtempSync(join(tmpdir(), "plus-dist-test-"));
  const files = new Map<string, Buffer>();
  const add = (data: Buffer | string) => {
    const buffer = Buffer.from(data);
    files.set(sha256(buffer), buffer);
    return { sha256: sha256(buffer), size: buffer.length };
  };
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
  const dist = plusDistRelease();
  const launcher = add(readFileSync(join(dist, "launcher.sh")));
  const bootstrap = add(readFileSync(join(dist, "bootstrap.js")));

  // static, public and tools are shared by every release in these tests.
  const parts = join(dir, "parts");
  mkdirSync(join(parts, "static"), { recursive: true });
  writeFileSync(join(parts, "static", "app.html"), "<html></html>\n");
  mkdirSync(join(parts, "public"), { recursive: true });
  writeFileSync(join(parts, "public", "logo.svg"), "<svg/>\n");
  mkdirSync(join(parts, "tools", "bin"), { recursive: true });
  writeFileSync(join(parts, "tools", "bin", "rg"), "#!/bin/sh\necho rg\n", {
    mode: 0o755,
  });
  const staticPart = add(tarZst(parts, ["static"]));
  const publicPart = add(tarZst(parts, ["public"]));
  const toolsPart = add(tarZst(parts, ["tools"]));

  const release = (n: number) => {
    const appDir = join(dir, `app-${n}`);
    mkdirSync(join(appDir, "bundle"), { recursive: true });
    // A Lite stand-in: reports what the bootstrap set up.
    writeFileSync(
      join(appDir, "bundle", "index.js"),
      `if (require.main !== module) throw new Error("not main");
const fs = require("fs"), path = require("path");
console.log(JSON.stringify({
  release: ${n},
  args: process.argv.slice(2),
  bin: process.env.COCALC_BIN_PATH,
  nodeOnPath: (process.env.PATH || "").split(":").includes(path.dirname(process.execPath)),
  staticHtml: fs.existsSync(path.join(__dirname, "..", "static", "app.html")),
  pinned: fs.existsSync(path.join(process.env.COCALC_PLUS_DIST_ROOT, "running", String(process.pid))),
}));\n`,
    );
    const app = add(tarZst(appDir, ["bundle"]));
    const text = canonicalJson(
      {
        schema: PLUS_MANIFEST_SCHEMA,
        release: n,
        version: `1.0.${n}`,
        git: "abcdef1",
        built_at: "2026-10-13T00:00:00Z",
        launcher,
        bootstrap,
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
        app: { [platform]: app },
        tools: { [platform]: toolsPart },
        static: staticPart,
        public: publicPart,
      },
      true,
    );
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
  const root = join(dir, rootName);
  const launcherPath = join(dir, "bin", "cocalc-plus");
  const install = (r: ReturnType<typeof release>, origin = ORIGIN) =>
    installPlusRelease({
      root,
      origin,
      manifestText: r.text,
      manifestHash: r.hash,
      fetchFile,
      prepareState: (current): CliState =>
        current ?? {
          schema: STATE_SCHEMA,
          origin,
          mode: "origin-trust",
          auto: true,
          held_at: null,
          launcher: launcherPath,
          origins: {},
        },
    });
  const run = (...args: string[]) => {
    const out = spawnSync(launcherPath, args, {
      encoding: "utf8",
      env: { ...process.env, COCALC_PLUS_DIST_ROOT: root },
    });
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout);
  };
  return {
    dir,
    root,
    release,
    install,
    run,
    fetched,
    files,
    staticPart,
    publicPart,
  };
}

test("install a Plus release and start it through the launcher", async () => {
  const f = fixture();
  await f.install(f.release(10));
  const out = f.run("a b", "c");
  assert.equal(out.release, 10);
  assert.deepEqual(out.args, ["a b", "c"]);
  assert.match(out.bin, /apps\/[0-9a-f]{64}\/tools\/bin$/);
  assert.equal(out.nodeOnPath, true);
  assert.equal(out.staticHtml, true);
  assert.equal(out.pinned, true);
  // The pin is removed when the process exits.
  assert.deepEqual(readdirSync(join(f.root, "running")), []);
});

test("an update reuses unchanged parts and keeps what a running Lite uses", async () => {
  const f = fixture();
  const r1 = f.release(20);
  await f.install(r1);
  const r1Line = readFileSync(join(f.root, "active"), "utf8").trimEnd();
  const before = f.fetched.length;
  await f.install(f.release(21));
  // Only the new app part was downloaded; static, public, tools and Node
  // were reused.
  assert.equal(f.fetched.length - before, 1);
  assert.equal(f.run().release, 21);

  // A live process pinned to release 20 keeps it through later updates.
  mkdirSync(join(f.root, "running"), { recursive: true });
  writeFileSync(
    join(f.root, "running", `${process.pid}`),
    JSON.stringify({ line: r1Line, role: "server" }) + "\n",
  );
  await f.install(f.release(22));
  await f.install(f.release(23));
  assert.ok(existsSync(join(f.root, "apps", r1.hash, ".complete")));
  // An unreadable pin of a live process stops collection entirely.
  writeFileSync(join(f.root, "running", `${process.pid}`), "{");
  await f.install(f.release(24));
  assert.ok(existsSync(join(f.root, "apps", r1.hash, ".complete")));
  // Without the pin, release 20 is collected.
  rmSync(join(f.root, "running", `${process.pid}`));
  await f.install(f.release(25));
  assert.equal(existsSync(join(f.root, "apps", r1.hash)), false);
});

function dataFixture(f: ReturnType<typeof fixture>) {
  const home = join(f.dir, "home");
  const paths = { home, data: join(home, "data") };
  const activeLine = () =>
    readFileSync(join(f.root, "active"), "utf8").trimEnd();
  // Start a server for the active release (this test process plays Lite).
  const start = async (faultAt?: DataFault) => {
    const result = await prepareServer({
      root: f.root,
      line: activeLine(),
      paths,
      faultAt,
    });
    // ...and stop it: drop this process's server pin.
    rmSync(join(f.root, "running", `${process.pid}`), { force: true });
    return result;
  };
  const write = (text: string) => {
    mkdirSync(join(paths.data, "sync"), { recursive: true });
    writeFileSync(join(paths.data, "hub.db"), text);
    writeFileSync(join(paths.data, "sync", "blobs.db"), `blobs ${text}`);
  };
  const read = () => readFileSync(join(paths.data, "hub.db"), "utf8");
  return { paths, start, write, read, activeLine };
}

test("a server start: no data, unchanged, snapshot, and only one server", async () => {
  const f = fixture();
  const d = dataFixture(f);
  await f.install(f.release(40));
  assert.equal(await d.start(), "no-data");
  d.write("from 40");
  assert.equal(await d.start(), "unchanged");
  await f.install(f.release(41));
  assert.equal(await d.start(), "snapshot");
  assert.equal(
    readFileSync(join(d.paths.home, "data.snapshot", "hub.db"), "utf8"),
    "from 40",
  );
  // Another live server owns the data: refused, and nothing is snapshotted.
  mkdirSync(join(f.root, "running"), { recursive: true });
  writeFileSync(
    join(f.root, "running", `${process.ppid}`),
    JSON.stringify({ line: d.activeLine(), role: "server" }) + "\n",
  );
  await assert.rejects(d.start(), /already running/);
  rmSync(join(f.root, "running", `${process.ppid}`));
  // A release removed before the server could pin it is not started.
  const r = d.activeLine().split(" ")[1];
  rmSync(join(f.root, "apps", r, ".complete"));
  await assert.rejects(d.start(), /incomplete or was removed/);
});

test("rollback goes to the release that owns the data, not the last installed one", async () => {
  const f = fixture();
  const d = dataFixture(f);
  const r1 = f.release(50);
  await f.install(r1);
  d.write("from 50");
  await d.start(); // release 50 owns the data
  // Two background installs while 50 keeps running.
  await f.install(f.release(51));
  await f.install(f.release(52));
  // Never restarted: rollback goes back to 50, code only (its data is intact).
  const back = await plusRollback({ root: f.root, paths: d.paths });
  assert.equal(back.release, 50);
  assert.equal(f.run().release, 50);
  assert.equal(d.read(), "from 50");

  // Restart into 52 (resume), which migrates the data; then roll back.
  await f.install(f.release(53));
  assert.equal(await d.start(), "snapshot");
  d.write("from 53 (migrated)");
  const restored = await plusRollback({ root: f.root, paths: d.paths });
  assert.equal(restored.release, 50);
  assert.equal(f.run().release, 50);
  assert.equal(d.read(), "from 50");
  assert.equal(
    readFileSync(join(d.paths.home, "data.replaced", "hub.db"), "utf8"),
    "from 53 (migrated)",
  );
  assert.equal(existsSync(join(d.paths.data, ".cocalc-snapshot.json")), false);
  assert.equal((await readState(f.root))?.held_at, 50);
  // Nothing older is left to restore: refused, nothing changes.
  await assert.rejects(
    plusRollback({ root: f.root, paths: d.paths }),
    /no snapshot of your data/,
  );
  assert.equal(d.read(), "from 50");
});

test("garbage collection keeps the releases the data may need", async () => {
  const f = fixture();
  const d = dataFixture(f);
  const r1 = f.release(60);
  await f.install(r1);
  d.write("from 60");
  await d.start();
  for (const n of [61, 62, 63, 64]) await f.install(f.release(n));
  // 60 owns the data, so it stays installed.
  assert.ok(existsSync(join(f.root, "apps", r1.hash, ".complete")));
  await d.start(); // 64 takes over; 60 is now the snapshot's release
  for (const n of [65, 66, 67]) await f.install(f.release(n));
  assert.ok(existsSync(join(f.root, "apps", r1.hash, ".complete")));
});

test("rollback refuses while Lite runs and without a snapshot for newer data", async () => {
  const f = fixture();
  const d = dataFixture(f);
  await f.install(f.release(70));
  await f.install(f.release(71));
  d.write("from 71");
  await d.start(); // first start, by 71: data had no owner, so it's snapshotted
  mkdirSync(join(f.root, "running"), { recursive: true });
  writeFileSync(
    join(f.root, "running", `${process.ppid}`),
    JSON.stringify({ line: d.activeLine(), role: "server" }) + "\n",
  );
  await assert.rejects(
    plusRollback({ root: f.root, paths: d.paths }),
    /is running/,
  );
  rmSync(join(f.root, "running", `${process.ppid}`));
  // The snapshot holds data that no release owned (from before this build):
  // there is no release to restore it with, so rollback is refused.
  await assert.rejects(
    plusRollback({ root: f.root, paths: d.paths }),
    /no snapshot of your data/,
  );
  assert.equal(f.run().release, 71);
});

for (const point of ["snapshot-copied", "snapshot-renamed"] as DataFault[]) {
  test(`a crash at ${point} leaves data, snapshot and owner consistent`, async () => {
    const f = fixture();
    const d = dataFixture(f);
    await f.install(f.release(80));
    d.write("from 80");
    await d.start();
    await f.install(f.release(81));
    await assert.rejects(d.start(point), /injected fault/);
    rmSync(join(f.root, "running", `${process.pid}`), { force: true });
    // The next start recovers and ends with 80's data in the snapshot.
    assert.equal(await d.start().then(() => "ok"), "ok");
    assert.equal(
      readFileSync(join(d.paths.home, "data.snapshot", "hub.db"), "utf8"),
      "from 80",
    );
    assert.equal(d.read(), "from 80");
    const back = await plusRollback({ root: f.root, paths: d.paths });
    assert.equal(back.release, 80);
  });
}

for (const point of [
  "data-replaced",
  "snapshot-restored",
  "code-switched",
] as DataFault[]) {
  test(`a crash at ${point} during rollback is finished by recovery`, async () => {
    const f = fixture();
    const d = dataFixture(f);
    await f.install(f.release(90));
    d.write("from 90");
    await d.start();
    await f.install(f.release(91));
    await d.start();
    d.write("from 91");
    await assert.rejects(
      plusRollback({ root: f.root, paths: d.paths, faultAt: point }),
      /injected fault/,
    );
    // Recovery (here: the next server start's) completes the rollback.
    await withLock(f.root, () => recoverData(f.root));
    assert.equal(f.run().release, 90);
    assert.equal(d.read(), "from 90");
    assert.equal(
      readFileSync(join(d.paths.home, "data.replaced", "hub.db"), "utf8"),
      "from 91",
    );
    assert.equal((await readState(f.root))?.held_at, 90);
    assert.equal(existsSync(join(f.root, "data-journal.json")), false);
  });
}

for (const point of [
  "data-replaced",
  "snapshot-restored",
  "code-switched",
] as DataFault[]) {
  test(`a start after a rollback crash at ${point} never runs the release chosen before recovery`, async () => {
    const f = fixture();
    const d = dataFixture(f);
    await f.install(f.release(110));
    d.write("from 110");
    await d.start();
    await f.install(f.release(111));
    await d.start();
    d.write("from 111");
    const line111 = d.activeLine();
    await assert.rejects(
      plusRollback({ root: f.root, paths: d.paths, faultAt: point }),
      /injected fault/,
    );
    // The launcher had picked 111; recovery installs 110 under the lock, so
    // the 111 process must not go on and open the data.
    await assert.rejects(
      prepareServer({ root: f.root, line: line111, paths: d.paths }),
      /changed while starting/,
    );
    rmSync(join(f.root, "running", `${process.pid}`), { force: true });
    assert.equal(f.run().release, 110);
    assert.equal(d.read(), "from 110");
    assert.equal(await d.start(), "unchanged");
    assert.equal(d.read(), "from 110");
  });
}

test("an update first finishes an interrupted rollback, and keeps what it needs", async () => {
  const f = fixture();
  const d = dataFixture(f);
  const r1 = f.release(120);
  await f.install(r1);
  d.write("from 120");
  await d.start();
  await f.install(f.release(121));
  await d.start();
  d.write("from 121");
  await assert.rejects(
    plusRollback({
      root: f.root,
      paths: d.paths,
      faultAt: "snapshot-restored",
    }),
    /injected fault/,
  );
  await f.install(f.release(122));
  assert.equal(existsSync(join(f.root, "data-journal.json")), false);
  assert.ok(existsSync(join(f.root, "apps", r1.hash, ".complete")));
  assert.equal(d.read(), "from 120");
  assert.equal(f.run().release, 122);
  // 122 starting snapshots 120's data, so 120 can still be rolled back to.
  assert.equal(await d.start(), "snapshot");
  assert.equal(
    (await plusRollback({ root: f.root, paths: d.paths })).release,
    120,
  );
  assert.equal(d.read(), "from 120");
});

test("a damaged data journal stops starts and updates and is kept", async () => {
  const f = fixture();
  const d = dataFixture(f);
  await f.install(f.release(130));
  writeFileSync(join(f.root, "data-journal.json"), "{");
  await assert.rejects(d.start(), /data journal/);
  await assert.rejects(f.install(f.release(131)), /data journal/);
  writeFileSync(
    join(f.root, "data-journal.json"),
    JSON.stringify({ op: "rollback", line: "v1 junk" }),
  );
  await assert.rejects(d.start(), /damaged/);
  assert.ok(existsSync(join(f.root, "data-journal.json")));
});

test("an unreadable data path is not treated as empty", async () => {
  const f = fixture();
  const d = dataFixture(f);
  await f.install(f.release(140));
  mkdirSync(d.paths.home, { recursive: true });
  writeFileSync(d.paths.data, "not a directory");
  await assert.rejects(d.start(), /not a directory/);
});

test("ownership does not carry over when the data moves", async () => {
  const f = fixture();
  const d = dataFixture(f);
  await f.install(f.release(150));
  d.write("from 150");
  await d.start(); // 150 owns the data at the first path
  await f.install(f.release(151));
  // The same install, pointed at other data (COCALC_PLUS_HOME changed).
  const other = {
    home: join(f.dir, "other-home"),
    data: join(f.dir, "other-home", "data"),
  };
  mkdirSync(other.data, { recursive: true });
  writeFileSync(join(other.data, "hub.db"), "other data");
  const line = d.activeLine();
  assert.equal(
    await prepareServer({ root: f.root, line, paths: other }),
    "snapshot",
  );
  rmSync(join(f.root, "running", `${process.pid}`), { force: true });
  // The other data's previous owner is unknown, so there is nothing to roll
  // back to, and 150's code never runs on it.
  await assert.rejects(
    plusRollback({ root: f.root, paths: other }),
    /no snapshot of your data/,
  );
  assert.equal(f.run().release, 151);
});

test("a symlinked data directory is snapshotted by its contents and rolled back", async () => {
  const f = fixture();
  const d = dataFixture(f);
  const real = join(f.dir, "real-data");
  mkdirSync(real, { recursive: true });
  mkdirSync(d.paths.home, { recursive: true });
  symlinkSync(real, d.paths.data);
  await f.install(f.release(160));
  d.write("from 160");
  await d.start();
  await f.install(f.release(161));
  assert.equal(await d.start(), "snapshot");
  // A real copy next to the real directory, not a second link to it.
  const snapshot = `${realpathSync(real)}.snapshot`;
  assert.equal(lstatSync(snapshot).isSymbolicLink(), false);
  d.write("from 161");
  assert.equal(readFileSync(join(snapshot, "hub.db"), "utf8"), "from 160");
  assert.equal(
    (await plusRollback({ root: f.root, paths: d.paths })).release,
    160,
  );
  assert.equal(d.read(), "from 160");
  assert.equal(lstatSync(d.paths.data).isSymbolicLink(), true);
});

test("data on another filesystem than the CoCalc Plus home rolls back", async () => {
  if (!existsSync("/dev/shm")) return;
  const f = fixture();
  const shm = mkdtempSync("/dev/shm/plus-dist-test-");
  try {
    const paths = { home: join(f.dir, "home"), data: join(shm, "data") };
    const line = () => readFileSync(join(f.root, "active"), "utf8").trimEnd();
    const start = async () => {
      const r = await prepareServer({ root: f.root, line: line(), paths });
      rmSync(join(f.root, "running", `${process.pid}`), { force: true });
      return r;
    };
    await f.install(f.release(170));
    mkdirSync(paths.data, { recursive: true });
    writeFileSync(join(paths.data, "hub.db"), "from 170");
    await start();
    await f.install(f.release(171));
    assert.equal(await start(), "snapshot");
    writeFileSync(join(paths.data, "hub.db"), "from 171");
    assert.equal((await plusRollback({ root: f.root, paths })).release, 170);
    assert.equal(readFileSync(join(paths.data, "hub.db"), "utf8"), "from 170");
  } finally {
    rmSync(shm, { recursive: true, force: true });
  }
});

test("a data directory that is a mount point is not snapshotted, and rollback refuses", async () => {
  const f = fixture();
  const d = dataFixture(f);
  await f.install(f.release(180));
  d.write("from 180");
  await d.start();
  await f.install(f.release(181));
  assert.equal(
    await prepareServer({
      root: f.root,
      line: d.activeLine(),
      paths: d.paths,
      isRenamable: async () => false,
    }),
    "no-snapshot",
  );
  rmSync(join(f.root, "running", `${process.pid}`), { force: true });
  await assert.rejects(
    plusRollback({ root: f.root, paths: d.paths }),
    /no snapshot of your data/,
  );
  assert.equal(f.run().release, 181);
});

test("well-formed but wrong journals are refused before recovery acts", async () => {
  const f = fixture();
  const d = dataFixture(f);
  const r = f.release(190);
  await f.install(r);
  const other = f.release(191);
  await f.install(other);
  const line = d.activeLine(); // release 191
  const data = join(f.dir, "home", "data");
  const release = { manifest: r.hash, release: 190, version: "1.0.190" };
  const cases = [
    // The line runs a different release than the one recorded as owner.
    { op: "rollback", data, to: release, line, restore: null },
    // An id that would turn into a path outside the data's siblings.
    { op: "snapshot", data, id: "../../../etc", from: null, to: release },
    {
      op: "snapshot",
      data: "relative/data",
      id: "0123456789abcdef",
      from: null,
      to: release,
    },
    {
      op: "snapshot",
      data,
      id: "0123456789abcdef",
      from: null,
      to: { ...release, release: 1.5 },
    },
    {
      op: "snapshot",
      data,
      id: "0123456789abcdef",
      from: null,
      to: release,
      temp: "/",
    },
  ];
  for (const journal of cases) {
    writeFileSync(join(f.root, "data-journal.json"), JSON.stringify(journal));
    await assert.rejects(d.start(), /damaged/, JSON.stringify(journal));
    assert.ok(existsSync(join(f.root, "data-journal.json")));
  }
  rmSync(join(f.root, "data-journal.json"));
});

test("names starting with two dots are ordinary children for containment", async () => {
  assert.equal(pathWithin("/a/b", "/a/b/..data"), "..data");
  assert.equal(pathWithin("/a/b", "/a/b/..x/y"), join("..x", "y"));
  assert.equal(pathWithin("/a/b", "/a/b"), "");
  assert.equal(pathWithin("/a/b", "/a"), undefined);
  assert.equal(pathWithin("/a/b", "/a/c"), undefined);
  assert.equal(pathWithin("/a/b", "/a/b.."), undefined);
  // Data inside the install, and the install inside the data, both through
  // a component that starts with "..".
  const f = fixture("..install");
  // One release object: building it again re-tars, which can change the hash.
  const r = f.release(205);
  await f.install(r);
  const line = readFileSync(join(f.root, "active"), "utf8").trimEnd();
  for (const data of [join(f.root, "..data"), f.dir]) {
    await assert.rejects(
      prepareServer({ root: f.root, line, paths: { home: f.dir, data } }),
      /overlaps/,
      data,
    );
    // A journal naming such data is refused before recovery acts.
    const release = {
      manifest: r.hash,
      release: 205,
      version: "1.0.205",
    };
    for (const journal of [
      { op: "rollback", data, to: release, line, restore: "0123456789abcdef" },
      { op: "snapshot", data, id: "0123456789abcdef", from: null, to: release },
    ]) {
      writeFileSync(join(f.root, "data-journal.json"), JSON.stringify(journal));
      await assert.rejects(
        withLock(f.root, () => recoverData(f.root)),
        /unsafe paths/,
        `${data} ${journal.op}`,
      );
      assert.ok(existsSync(join(f.root, "active")));
    }
    rmSync(join(f.root, "data-journal.json"));
  }
});

test("relative or overlapping data paths are refused", async () => {
  const f = fixture();
  await f.install(f.release(200));
  const line = readFileSync(join(f.root, "active"), "utf8").trimEnd();
  await assert.rejects(
    prepareServer({ root: f.root, line, paths: { home: "h", data: "data" } }),
    /absolute path/,
  );
  await assert.rejects(
    prepareServer({
      root: f.root,
      line,
      paths: { home: f.root, data: join(f.root, "apps") },
    }),
    /overlaps/,
  );
});

test("an automatic update stops at a hold placed after its unlocked check", () => {
  const state: CliState = {
    schema: STATE_SCHEMA,
    origin: ORIGIN,
    mode: "origin-trust",
    auto: true,
    held_at: 7,
    launcher: "/x/cocalc-plus",
    origins: {},
  };
  assert.throws(() => updateState({ ...state }, ORIGIN, false), HeldError);
  assert.equal(updateState({ ...state }, ORIGIN, true).held_at, null);
  assert.throws(
    () =>
      updateState(
        { ...state, held_at: null },
        "https://elsewhere.example",
        false,
      ),
    /source changed/,
  );
});

test("a rollback whose snapshot went missing fails closed and keeps its journal", async () => {
  for (const damage of ["removed", "replaced by another"]) {
    const f = fixture();
    const d = dataFixture(f);
    await f.install(f.release(210));
    d.write("from 210");
    await d.start();
    await f.install(f.release(211));
    await d.start();
    d.write("from 211");
    // The data is moved aside, then the crash...
    await assert.rejects(
      plusRollback({ root: f.root, paths: d.paths, faultAt: "data-replaced" }),
      /injected fault/,
    );
    // ...and the snapshot is gone, or is not this rollback's.
    const snapshot = join(d.paths.home, "data.snapshot");
    if (damage === "removed") {
      rmSync(snapshot, { recursive: true });
    } else {
      const marker = join(snapshot, ".cocalc-snapshot.json");
      const info = JSON.parse(readFileSync(marker, "utf8"));
      writeFileSync(
        marker,
        JSON.stringify({ ...info, id: "ffffffffffffffff" }) + "\n",
      );
    }
    await assert.rejects(
      withLock(f.root, () => recoverData(f.root)),
      /is missing; the journal .* was kept/,
    );
    await assert.rejects(d.start(), /is missing/);
    assert.ok(existsSync(join(f.root, "data-journal.json")));
    // Older code never went live, and the newer data is where it was put.
    assert.equal(f.run().release, 211);
    assert.equal(
      readFileSync(join(d.paths.home, "data.replaced", "hub.db"), "utf8"),
      "from 211",
    );
  }
});

test("a rollback whose data can't be moved is undone, not left half done", async () => {
  if (process.getuid?.() === 0) return; // root ignores the permissions
  const f = fixture();
  const d = dataFixture(f);
  await f.install(f.release(220));
  d.write("from 220");
  await d.start();
  await f.install(f.release(221));
  await d.start();
  d.write("from 221");
  // Like a mount point: renaming the data directory is refused.
  chmodSync(d.paths.home, 0o555);
  try {
    await assert.rejects(
      plusRollback({ root: f.root, paths: d.paths }),
      /can't be moved \(EACCES\).*nothing was changed/,
    );
  } finally {
    chmodSync(d.paths.home, 0o755);
  }
  assert.equal(existsSync(join(f.root, "data-journal.json")), false);
  assert.equal(f.run().release, 221);
  assert.equal(d.read(), "from 221");
  assert.equal(await d.start(), "unchanged");
});

test("mount points on the same device as their parent are not renamable", async () => {
  let found: string | undefined;
  for (const line of readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
    const point = line.split(" ")[4];
    if (!point || point === "/" || /\\/.test(point)) continue;
    try {
      const own = lstatSync(point);
      if (own.isDirectory() && own.dev === lstatSync(dirname(point)).dev) {
        found = point;
        break;
      }
    } catch {}
  }
  if (found == null) return; // no such mount here
  assert.equal(await renamable(found), false, found);
  const f = fixture();
  mkdirSync(join(f.dir, "plain"));
  assert.equal(await renamable(join(f.dir, "plain")), true);
});

test("the install may not sit among the data's derived paths", async () => {
  for (const rootName of [
    "data.snapshot",
    "data.replaced",
    "data.snapshot.old",
    "data.snapshot.tmp-0123456789abcdef",
    // Nested below them too, e.g. inside a temporary snapshot's directory.
    "data.snapshot.tmp-0123456789abcdef/install",
    "data.snapshot/nested/install",
    "data.anything/install",
  ]) {
    const f = fixture(rootName);
    const r = f.release(230);
    await f.install(r);
    const line = readFileSync(join(f.root, "active"), "utf8").trimEnd();
    const paths = { home: f.dir, data: join(f.dir, "data") };
    await assert.rejects(
      prepareServer({ root: f.root, line, paths }),
      /overlaps|sits among/,
      rootName,
    );
    // Nor may a journal name such data: recovery refuses before acting.
    const release = { manifest: r.hash, release: 230, version: "1.0.230" };
    const journals = [
      {
        op: "rollback",
        data: paths.data,
        to: release,
        line,
        restore: "0123456789abcdef",
      },
      // Its recovery removes ${data}.snapshot.tmp-<id>.
      {
        op: "snapshot",
        data: paths.data,
        id: "0123456789abcdef",
        from: null,
        to: release,
      },
    ];
    for (const journal of journals) {
      writeFileSync(join(f.root, "data-journal.json"), JSON.stringify(journal));
      await assert.rejects(
        withLock(f.root, () => recoverData(f.root)),
        /unsafe paths/,
        `${rootName} ${journal.op}`,
      );
      assert.ok(existsSync(join(f.root, "data-journal.json")));
      assert.ok(existsSync(join(f.root, "active")));
    }
  }
  // A sibling that merely shares a prefix without the dot is fine.
  const f = fixture("database/install");
  await f.install(f.release(231));
  const line = readFileSync(join(f.root, "active"), "utf8").trimEnd();
  assert.equal(
    await prepareServer({
      root: f.root,
      line,
      paths: { home: f.dir, data: join(f.dir, "data") },
    }),
    "no-data",
  );
});

/*
 * "Already current" is decided under the lock. A rollback lands while the
 * update waits for the lock, after it read current.json naming the release
 * that was active until then.
 */
for (const explicit of [true, false]) {
  test(`a rollback while ${explicit ? "an explicit" : "an automatic"} Plus update waits for the lock`, async () => {
    const f = fixture();
    const r1 = f.release(240);
    const r2 = f.release(241);
    const manifests = new Map([r1, r2].map((r) => [r.hash, r.text]));
    let pointerServed = false;
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      let body: Buffer | string | undefined;
      if (url === "/current.json") {
        pointerServed = true;
        body = canonicalJson(
          {
            schema: POINTER_SCHEMA,
            release: 241,
            manifest: r2.hash,
            min_release: 241,
            published_at: "2026-10-13T00:00:00Z",
          },
          true,
        );
      } else if (url.startsWith("/manifests/")) {
        body = manifests.get(url.slice(11, -5));
      } else if (url.startsWith("/files/")) {
        body = f.files.get(url.slice(7));
      }
      res.statusCode = body == null ? 404 : 200;
      res.end(body);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await f.install(r1, origin);
      await f.install(r2, origin);
      const log: string[] = [];
      let update: ReturnType<typeof updatePlusFromOrigin>;
      await withLock(f.root, async () => {
        update = updatePlusFromOrigin({
          root: f.root,
          explicit,
          log: (m) => log.push(m),
        });
        let settled = false;
        update.then(
          () => (settled = true),
          () => (settled = true),
        );
        const start = Date.now();
        while (!(pointerServed && log.some((m) => /Waiting/.test(m)))) {
          assert.ok(!settled, "the update finished without the lock");
          assert.ok(Date.now() - start < 10_000, "the update never waited");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        // What rollback does, while the update waits for the lock.
        const state = await readState(f.root);
        await writeState(f.root, { ...state!, held_at: 240 });
        const previous = await readActive(f.root, "previous");
        await switchActive(f.root, previous!.line);
      });
      const outcome = await update!;
      const state = await readState(f.root);
      if (explicit) {
        assert.equal(outcome.status, "updated");
        assert.equal(f.run().release, 241);
        assert.equal(state?.held_at, null);
      } else {
        assert.equal(outcome.status, "held");
        assert.equal(f.run().release, 240);
        assert.equal(state?.held_at, 240);
      }
    } finally {
      server.close();
    }
  });
}
