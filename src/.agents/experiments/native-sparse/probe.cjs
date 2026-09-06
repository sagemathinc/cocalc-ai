// Disposable native sparse-backup qualification. Never uses inherited credentials.
// node probe.cjs /absolute/path/to/rustic /absolute/path/to/report.json
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");

const binary = process.argv[2];
assert(binary && path.isAbsolute(binary), "explicit Rustic binary required");
const root = fs.mkdtempSync("/tmp/cocalc-native-sparse-");
const source = path.join(root, "source");
const repo = path.join(root, "repo");
const helper = path.join(root, "extent-check");
const measure = path.join(root, "measure");
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
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
  runs: [],
  limitations: [
    "Local Btrfs files, not privileged subvolume snapshots or enforced project quotas.",
    "Process I/O sampled from /proc; reported rchar is a lower bound and includes repository reads.",
    "Record build profile; debug-build elapsed times are not production throughput predictions.",
  ],
};
function run(cmd, args) {
  return execFileSync(cmd, args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 60000,
    killSignal: "SIGKILL",
    maxBuffer: 8 * MiB,
  });
}
function stat(file) {
  const info = fs.statSync(file);
  return { size: info.size, allocated: info.blocks * 512 };
}
function make(name, size, islands = []) {
  const file = path.join(source, name);
  const fd = fs.openSync(file, "wx", 0o600);
  fs.ftruncateSync(fd, size);
  for (const [offset, length] of islands) {
    const bytes = crypto.randomBytes(length);
    assert.equal(fs.writeSync(fd, bytes, 0, bytes.length, offset), length);
  }
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  return file;
}
function edit(file, offset) {
  const fd = fs.openSync(file, "r+");
  const bytes = crypto.randomBytes(4096);
  assert.equal(fs.writeSync(fd, bytes, 0, bytes.length, offset), bytes.length);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
}
function totalBytes(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, item) => {
    const child = path.join(dir, item.name);
    return (
      sum + (item.isDirectory() ? totalBytes(child) : fs.statSync(child).size)
    );
  }, 0);
}
async function rustic(label, args, cwd = root) {
  const timeFile = path.join(root, `time-${report.runs.length}.json`);
  const before = Date.now();
  const child = spawn(
    measure,
    [
      timeFile,
      binary,
      "--repository",
      repo,
      "--no-cache",
      "--no-progress",
      ...args,
    ],
    { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  let stdout = "",
    stderr = "",
    maxRchar = 0,
    overflow = false,
    timedOut = false;
  const sample = setInterval(() => {
    try {
      const children = fs
        .readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8")
        .trim()
        .split(/\s+/);
      for (const pid of children) {
        if (!/^\d+$/.test(pid)) continue;
        const io = fs.readFileSync(`/proc/${pid}/io`, "utf8");
        maxRchar = Math.max(
          maxRchar,
          Number(io.match(/^rchar: (\d+)$/m)?.[1] ?? 0),
        );
      }
    } catch {
      /* A process may exit between /proc reads. */
    }
  }, 20);
  const kill = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (err) {
      if (err.code !== "ESRCH") throw err;
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, 180000);
  child.stdout.on("data", (buf) => {
    stdout += buf;
    if (stdout.length > 8 * MiB) {
      overflow = true;
      kill();
    }
  });
  child.stderr.on("data", (buf) => {
    stderr += buf;
    if (stderr.length > 8 * MiB) {
      overflow = true;
      kill();
    }
  });
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert(!overflow && !timedOut, `${label}: exceeded benchmark budget`);
    assert.equal(code, 0, `${label}: ${stderr}`);
    const row = {
      label,
      elapsedMs: Date.now() - before,
      ...JSON.parse(fs.readFileSync(timeFile, "utf8")),
      maxObservedRchar: maxRchar,
    };
    report.runs.push(row);
    console.log(JSON.stringify(row));
    return { stdout, row };
  } finally {
    clearTimeout(timer);
    clearInterval(sample);
  }
}
function verify(dest) {
  for (const name of fs.readdirSync(source)) {
    const original = path.join(source, name);
    const restored = path.join(dest, name);
    const fd = fs.openSync(restored, "r");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    // Compares every data extent in either file, not just the original's islands.
    JSON.parse(run(helper, [original, restored]));
    assert(
      stat(restored).allocated <= stat(original).allocated + MiB,
      `${name}: excessive sparse allocation`,
    );
  }
}
async function main() {
  report.binary = binary;
  report.version = run(binary, ["--version"]).trim();
  report.filesystem = run("findmnt", ["-T", root, "-n", "-o", "FSTYPE"]).trim();
  assert.equal(report.filesystem, "btrfs");
  const help = run(binary, ["restore", "--help"]);
  assert(
    help.includes("by-content-required"),
    "use the qualified development binary, not stock Rustic",
  );
  assert(help.includes("--strict"), "strict restore capability required");
  assert(run(binary, ["backup", "--help"]).includes("--strict"));
  run("gcc", [
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-o",
    helper,
    path.join(__dirname, "../sparse-packing/extent-check.c"),
  ]);
  run("gcc", [
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-o",
    measure,
    path.join(__dirname, "measure.c"),
  ]);
  fs.mkdirSync(source);
  make("zero", 1024 * GiB);
  make("huge", 100 * GiB, [
    [0, MiB / 2],
    [100 * GiB - MiB / 2, MiB / 2],
  ]);
  make(
    "mixed",
    16 * MiB,
    Array.from({ length: 256 }, (_, n) => [n * 65536, 4096]),
  );
  make("ordinary", MiB, [[0, MiB]]);
  for (const name of fs.readdirSync(source))
    report.fixtures[name] = stat(path.join(source, name));
  await rustic("init", ["init"]);
  let parent;
  for (const label of [
    "initial",
    "unchanged",
    "ordinary-edit",
    "sparse-edit-mtime-reset",
  ]) {
    if (label === "ordinary-edit") edit(path.join(source, "ordinary"), 4096);
    if (label === "sparse-edit-mtime-reset") {
      const file = path.join(source, "huge");
      const old = fs.statSync(file);
      edit(file, 50 * GiB);
      fs.utimesSync(file, old.atime, old.mtime);
    }
    const beforeBytes = totalBytes(repo);
    const { stdout, row } = await rustic(
      label,
      [
        "backup",
        "--strict",
        "--json",
        "--no-scan",
        "--host",
        "native-sparse-test",
        ...(parent ? ["--parent", parent] : []),
        ".",
      ],
      source,
    );
    const snapshot = JSON.parse(stdout);
    parent = snapshot.id;
    row.summary = snapshot.summary;
    row.repositoryGrowth = totalBytes(repo) - beforeBytes;
    if (label === "unchanged") {
      assert.equal(snapshot.summary.files_unmodified, 4);
      assert.equal(snapshot.summary.data_added_files, 0);
    }
    if (label === "ordinary-edit" || label === "sparse-edit-mtime-reset") {
      assert.equal(snapshot.summary.files_unmodified, 3);
      assert.equal(snapshot.summary.files_changed, 1);
    }
  }
  const dest = path.join(root, "restore");
  await rustic("restore", [
    "restore",
    "--strict",
    "--no-ownership",
    "--sparse",
    "by-content-required",
    parent,
    dest,
  ]);
  verify(dest);
  // Recreate the existing-target corruption: zero bytes must replace nonzero bytes.
  edit(path.join(dest, "zero"), 500 * GiB);
  await rustic("restore-existing", [
    "restore",
    "--strict",
    "--no-ownership",
    "--verify-existing",
    "--sparse",
    "by-content-required",
    parent,
    dest,
  ]);
  verify(dest);
  await rustic("check-data", ["check", "--read-data"]);
  report.ok = true;
}
main()
  .catch((err) => {
    report.error = String(err.stack || err);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(root, { recursive: true, force: true });
    if (process.argv[3])
      fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  });
