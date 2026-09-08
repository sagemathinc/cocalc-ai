// Isolated experiment: no CoCalc API, production repository, or inherited auth.
// Usage: node probe.cjs /absolute/path/to/rustic [/absolute/path/to/report.json]
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");

const binary = process.argv[2];
assert(binary && path.isAbsolute(binary), "pass an explicit Rustic binary");
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const root = fs.mkdtempSync("/tmp/cocalc-sparse-packing-");
const source = path.join(root, "source");
const helper = path.join(root, "extent-check");
const env = {
  HOME: root,
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  TZ: "UTC",
  RUSTIC_PASSWORD: "disposable-fixture-only",
};
const report = {
  fixtures: {},
  formats: {},
  runs: [],
  limitations: [
    "File transformations use Btrfs files, not privileged subvolume snapshots or enforced project quotas.",
    "Warm reuse holds a persistent packed staging tree; new-clone behavior is measured separately.",
    "Generated fixtures only; not a production encoder, cache, or hostile-input-safe decoder.",
  ],
};

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 60000,
    killSignal: "SIGKILL",
    maxBuffer: 8 * MiB,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}
function rustic(repo, args, cwd = root) {
  return run(
    binary,
    ["--repository", repo, "--no-cache", "--no-progress", ...args],
    { cwd },
  );
}
function stat(file) {
  const s = fs.statSync(file);
  return { size: s.size, allocated: s.blocks * 512 };
}
function extent(file, other) {
  for (const target of [file, other].filter(Boolean)) {
    const fd = fs.openSync(target, "r");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  }
  return JSON.parse(run(helper, [file, ...(other ? [other] : [])]));
}
function digest(file) {
  // Only call this on packed files, never on the huge sparse source.
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}
function make(name, size, islands) {
  const file = path.join(source, name);
  const fd = fs.openSync(file, "wx", 0o600);
  fs.ftruncateSync(fd, size);
  for (const [offset, length] of islands) {
    const bytes = crypto.randomBytes(length);
    assert.equal(fs.writeSync(fd, bytes, 0, length, offset), length);
  }
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  const timestamp = Math.floor(Date.now() / 1000) - 60;
  fs.utimesSync(file, timestamp, timestamp);
  return file;
}
function encode(name, dest, format = "pax") {
  const args = [
    "--create",
    "--file",
    dest,
    "--format",
    format,
    "--sparse",
    "--hole-detection=seek",
  ];
  if (format === "pax") args.push("--sparse-version=1.0");
  if (format === "pax-normalized") {
    args[args.indexOf("pax-normalized")] = "pax";
    args.push(
      "--sparse-version=1.0",
      "--pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime",
    );
  }
  run("tar", [...args, "--directory", source, "--", name]);
  const fd = fs.openSync(dest, "r");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
}
function identity(file) {
  const s = fs.statSync(file, { bigint: true });
  // Deliberately include ctime; resetting mtime must not hide an edit.
  return [
    s.dev,
    s.ino,
    s.size,
    s.mtimeNs,
    s.ctimeNs,
    s.mode,
    s.uid,
    s.gid,
    s.nlink,
  ].join(":");
}
function repoBytes(dir) {
  let n = 0;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, item.name);
    n += item.isDirectory() ? repoBytes(p) : fs.statSync(p).size;
  }
  return n;
}
function writeEdit(name, pos) {
  const fd = fs.openSync(path.join(source, name), "r+");
  const bytes = crypto.randomBytes(4096);
  assert.equal(fs.writeSync(fd, bytes, 0, bytes.length, pos), bytes.length);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
}
function collectFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? collectFiles(p) : [p];
  });
}

try {
  report.rustic = run(binary, ["--version"]).trim();
  report.tar = run("tar", ["--version"]).split("\n")[0];
  report.filesystem = run("findmnt", ["-T", root, "-n", "-o", "FSTYPE"]).trim();
  assert.equal(report.filesystem, "btrfs");
  run("gcc", [
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-o",
    helper,
    path.join(__dirname, "extent-check.c"),
  ]);
  fs.mkdirSync(source);
  const sparse = ["huge.bin", "large.bin", "mixed.bin", "empty.bin"];
  make("huge.bin", 100 * GiB, [
    [0, MiB / 2],
    [100 * GiB - MiB / 2, MiB / 2],
  ]);
  make("large.bin", 10 * GiB, [
    [0, 32 * MiB],
    [9 * GiB, 32 * MiB],
  ]);
  make(
    "mixed.bin",
    256 * MiB,
    Array.from({ length: 256 }, (_, i) => [i * MiB, 64 * 1024]),
  );
  make("empty.bin", 1024 * GiB, []);
  const ordinary = Array.from({ length: 12 }, (_, i) => `ordinary-${i}.bin`);
  for (const name of ordinary) make(name, MiB, [[0, MiB]]);
  for (const name of [...sparse, ...ordinary])
    report.fixtures[name] = extent(path.join(source, name));
  // Ensure the checker detects corrupt data in a source hole, not only islands.
  const bad = path.join(root, "bad.bin");
  run("cp", ["--reflink=always", path.join(source, "huge.bin"), bad]);
  const badfd = fs.openSync(bad, "r+");
  fs.writeSync(badfd, Buffer.from("bad"), 0, 3, 50 * GiB);
  fs.fsyncSync(badfd);
  fs.closeSync(badfd);
  assert.throws(
    () => extent(path.join(source, "huge.bin"), bad),
    (err) => err.status === 7,
  );
  fs.unlinkSync(bad);

  for (const format of ["pax", "pax-normalized", "gnu"]) {
    const first = path.join(root, `${format}-1.tar`);
    const second = path.join(root, `${format}-2.tar`);
    encode("huge.bin", first, format);
    encode("huge.bin", second, format);
    const a = fs.readFileSync(first),
      b = fs.readFileSync(second);
    report.formats[format] = {
      identical: a.equals(b),
      ...stat(first),
      generatedMemberNames: [a, b].map((data) => [
        ...new Set(data.toString("latin1").match(/GNUSparseFile\.\d+/g) ?? []),
      ]),
    };
    fs.unlinkSync(first);
    fs.unlinkSync(second);
  }
  console.log(
    JSON.stringify({
      event: "fixtures-and-formats",
      fixtures: report.fixtures,
      formats: report.formats,
    }),
  );

  function experiment(strategy) {
    const home = path.join(root, strategy);
    const stage = path.join(home, "stage");
    const repo = path.join(home, "repo");
    fs.mkdirSync(stage, { recursive: true });
    rustic(repo, ["init"]);
    const identities = new Map();
    let parent;

    function backup(label, regenerate, cloneStage = false) {
      const start = performance.now();
      let encoded = 0,
        encodedDataBytes = 0,
        ordinaryCopied = 0;
      for (const name of [...sparse, ...ordinary]) {
        const original = path.join(source, name);
        const key = identity(original);
        const isSparse = sparse.includes(name);
        if ((!isSparse || !regenerate) && identities.get(name) === key)
          continue;
        if (isSparse) {
          const tmp = path.join(stage, `${name}.tar.tmp`);
          encode(name, tmp, "gnu");
          fs.renameSync(tmp, path.join(stage, `${name}.tar`));
          const times = fs.statSync(original);
          fs.utimesSync(
            path.join(stage, `${name}.tar`),
            times.atime,
            times.mtime,
          );
          encoded++;
          encodedDataBytes += extent(original).dataBytes;
        } else {
          run("cp", [
            "--reflink=always",
            "--preserve=all",
            original,
            path.join(stage, name),
          ]);
          ordinaryCopied++;
        }
        identities.set(name, key);
      }
      if (cloneStage) {
        const next = path.join(home, "new-stage");
        run("cp", ["-a", "--reflink=always", stage, next]);
        fs.renameSync(stage, path.join(home, "previous-stage"));
        fs.renameSync(next, stage);
      }
      const transformMs = performance.now() - start;
      const sizeBefore = repoBytes(repo);
      const backupStart = performance.now();
      const snap = JSON.parse(
        rustic(
          repo,
          [
            "backup",
            "--json",
            "--no-scan",
            "--host",
            "disposable-packing-probe",
            ...(parent ? ["--parent", parent] : []),
            ".",
          ],
          stage,
        ),
      );
      const backupMs = performance.now() - backupStart;
      parent = snap.id;
      const row = {
        strategy,
        label,
        encoded,
        encodedDataBytes,
        ordinaryCopied,
        transformMs: Math.round(transformMs),
        backupMs: Math.round(backupMs),
        repoGrowth: repoBytes(repo) - sizeBefore,
        summary: snap.summary,
      };
      const packed = path.join(home, `restore-${label}`);
      const decoded = path.join(home, `decode-${label}`);
      fs.mkdirSync(decoded);
      // No sparse mode: Rustic restores only dense encoded payloads.
      rustic(repo, ["restore", "--no-ownership", snap.id, packed]);
      const restored = collectFiles(packed);
      row.restored = {};
      for (const name of sparse) {
        const archive = restored.find(
          (p) => path.basename(p) === `${name}.tar`,
        );
        assert(archive);
        assert.equal(digest(archive), digest(path.join(stage, `${name}.tar`)));
        run("tar", [
          "--extract",
          "--file",
          archive,
          "--directory",
          decoded,
          "--no-same-owner",
        ]);
        const file = path.join(decoded, name);
        row.restored[name] = {
          packed: stat(archive),
          decoded: extent(file),
          verification: extent(path.join(source, name), file),
        };
        assert(
          row.restored[name].decoded.allocated <=
            report.fixtures[name].allocated + 2 * MiB,
          `unexpected expansion: ${name}`,
        );
      }
      for (const name of ordinary) {
        const file = restored.find((p) => path.basename(p) === name);
        assert(file);
        assert.equal(digest(file), digest(path.join(source, name)));
      }
      row.verified = true;
      if (label === "unchanged" && strategy === "reuse") {
        assert.equal(encoded, 0);
        assert.equal(snap.summary.files_unmodified, 16);
        assert.equal(snap.summary.data_added_files, 0);
      }
      if (
        [
          "small-ordinary-edit",
          "small-sparse-edit",
          "large-sparse-edit",
          "restored-mtime-edit",
          "new-extent",
        ].includes(label)
      ) {
        assert.equal(snap.summary.files_unmodified, 15);
        assert(
          snap.summary.data_added_files < 32 * MiB,
          "small edit uploaded too much data",
        );
      }
      report.runs.push(row);
      console.log(JSON.stringify({ event: "backup", ...row }));
      fs.rmSync(packed, { recursive: true, force: true });
      fs.rmSync(decoded, { recursive: true, force: true });
    }

    backup("initial", strategy === "repack");
    backup("unchanged", strategy === "repack");
    if (strategy === "repack") {
      rustic(repo, ["check", "--read-data"]);
      report.repositoryChecks ??= [];
      report.repositoryChecks.push({ strategy, readData: true, passed: true });
      return;
    }
    writeEdit("ordinary-0.bin", 0);
    backup("small-ordinary-edit", false);
    writeEdit("mixed.bin", 128 * MiB);
    backup("small-sparse-edit", false);
    writeEdit("large.bin", 16 * MiB);
    backup("large-sparse-edit", false);
    const before = fs.statSync(path.join(source, "huge.bin"));
    const beforeNs = fs.statSync(path.join(source, "huge.bin"), {
      bigint: true,
    }).mtimeNs;
    writeEdit("huge.bin", 4096);
    fs.utimesSync(path.join(source, "huge.bin"), before.atime, before.mtime);
    assert.equal(
      fs.statSync(path.join(source, "huge.bin"), { bigint: true }).mtimeNs,
      beforeNs,
    );
    backup("restored-mtime-edit", false);
    writeEdit("huge.bin", 50 * GiB);
    backup("new-extent", false);
    backup("fresh-reflink-stage", false, true);
    backup("unchanged-after-clone", false);
    report.repositoryChecks ??= [];
    rustic(repo, ["check", "--read-data"]);
    report.repositoryChecks.push({ strategy, readData: true, passed: true });
  }
  experiment("repack");
  experiment("reuse");
  report.passed = true;
} catch (err) {
  report.passed = false;
  report.error = err.stack;
  console.error(err.stack);
  if (err.stderr) console.error(String(err.stderr));
  process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  report.cleanedUp = true;
  if (process.argv[3])
    fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      event: "complete",
      passed: report.passed,
      cleanedUp: true,
    }),
  );
}
