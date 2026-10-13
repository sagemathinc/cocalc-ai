import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { constants, zstdCompressSync } from "node:zlib";

import {
  canonicalJson,
  currentPlatform,
} from "@cocalc/util/cli-distribution/schema";
import { PLUS_MANIFEST_SCHEMA } from "@cocalc/util/cli-distribution/plus-schema";

import { type CliState, STATE_SCHEMA, readState, withLock } from "./local";
import {
  type DataFault,
  installPlusRelease,
  plusRollback,
  prepareServer,
  recoverData,
} from "./plus";

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

function fixture() {
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
  const root = join(dir, "root");
  const launcherPath = join(dir, "bin", "cocalc-plus");
  const install = (r: ReturnType<typeof release>) =>
    installPlusRelease({
      root,
      origin: ORIGIN,
      manifestText: r.text,
      manifestHash: r.hash,
      fetchFile,
      prepareState: (current): CliState =>
        current ?? {
          schema: STATE_SCHEMA,
          origin: ORIGIN,
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
    await withLock(f.root, () => recoverData(f.root, d.paths));
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
