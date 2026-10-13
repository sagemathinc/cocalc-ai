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
import { constants, zstdCompressSync } from "node:zlib";

import {
  canonicalJson,
  currentPlatform,
} from "@cocalc/util/cli-distribution/schema";
import { PLUS_MANIFEST_SCHEMA } from "@cocalc/util/cli-distribution/plus-schema";

import { type CliState, STATE_SCHEMA, readState } from "./local";
import {
  installPlusRelease,
  plusRollback,
  restoreDataSnapshot,
  snapshotDataIfNewRelease,
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

  // A live server pinned to release 20 keeps it through later updates.
  mkdirSync(join(f.root, "running"), { recursive: true });
  writeFileSync(
    join(f.root, "running", `${process.pid}`),
    JSON.stringify({ line: r1Line, role: "server" }) + "\n",
  );
  await f.install(f.release(22));
  await f.install(f.release(23));
  assert.ok(existsSync(join(f.root, "apps", r1.hash, ".complete")));
  // Without the pin, release 20 is collected.
  writeFileSync(join(f.root, "running", `${process.pid}`), "");
  await f.install(f.release(24));
  assert.equal(existsSync(join(f.root, "apps", r1.hash)), false);
});

test("rollback waits for a running Lite and places a hold", async () => {
  const f = fixture();
  await f.install(f.release(30));
  await f.install(f.release(31));
  const line = readFileSync(join(f.root, "active"), "utf8").trimEnd();
  mkdirSync(join(f.root, "running"), { recursive: true });
  // A server pin for another live process (our parent stands in).
  writeFileSync(
    join(f.root, "running", `${process.ppid}`),
    JSON.stringify({ line, role: "server" }) + "\n",
  );
  await assert.rejects(plusRollback(f.root), /is running/);
  writeFileSync(join(f.root, "running", `${process.ppid}`), "");
  const to = await plusRollback(f.root);
  assert.equal(to.release, 30);
  assert.equal(f.run().release, 30);
  assert.equal((await readState(f.root))?.held_at, 30);
});

test("data snapshot: one previous version, restored by a rollback", async () => {
  const f = fixture();
  const home = join(f.dir, "home");
  const data = join(home, "data");
  mkdirSync(join(data, "sync"), { recursive: true });
  writeFileSync(join(data, "hub.db"), "v1 data");
  writeFileSync(join(data, "sync", "blobs.db"), "blobs");
  const paths = { home, data };
  const v1 = { manifest: "a".repeat(64), release: 1, version: "1.0.1" };
  const v2 = { manifest: "b".repeat(64), release: 2, version: "1.0.2" };

  // First run of the installed build on old data: snapshot it.
  assert.equal(await snapshotDataIfNewRelease(paths, v1), "snapshot");
  assert.equal(await snapshotDataIfNewRelease(paths, v1), "unchanged");
  // Release 2 starts: the data release 1 used is the snapshot.
  assert.equal(await snapshotDataIfNewRelease(paths, v2), "snapshot");
  writeFileSync(join(data, "hub.db"), "v2 data (migrated)");
  assert.equal(
    readFileSync(join(home, "data.snapshot", "hub.db"), "utf8"),
    "v1 data",
  );
  assert.equal(
    readFileSync(join(home, "data.snapshot", "sync", "blobs.db"), "utf8"),
    "blobs",
  );
  // Rolling back to another release leaves the data alone.
  assert.equal(
    await restoreDataSnapshot(paths, { ...v1, manifest: "c".repeat(64) }),
    "other-release",
  );
  // Rolling back to release 1 brings its data back and keeps the newer once.
  assert.equal(await restoreDataSnapshot(paths, v1), "restored");
  assert.equal(readFileSync(join(data, "hub.db"), "utf8"), "v1 data");
  assert.equal(
    readFileSync(join(home, "data.replaced", "hub.db"), "utf8"),
    "v2 data (migrated)",
  );
  assert.equal(existsSync(join(home, "data.snapshot")), false);
  // Starting release 1 again is not a new release for this data.
  assert.equal(await snapshotDataIfNewRelease(paths, v1), "unchanged");
});
