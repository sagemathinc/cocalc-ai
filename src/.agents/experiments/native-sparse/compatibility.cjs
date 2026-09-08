// Bounded old/new/independent-reader recovery. Only disposable local repositories.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const [current, old, restic] = process.argv.slice(2);
for (const binary of [current, old, restic]) assert(path.isAbsolute(binary));
const root = fs.mkdtempSync("/tmp/cocalc-sparse-compat-");
const source = path.join(root, "source");
const MiB = 1024 ** 2;
const env = {
  HOME: root,
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  PATH: "/usr/bin:/bin",
  RUSTIC_PASSWORD: "disposable-fixture-only",
  RESTIC_PASSWORD: "disposable-fixture-only",
};
function run(binary, args, cwd = source) {
  return execFileSync(binary, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 120000,
    killSignal: "SIGKILL",
    maxBuffer: 8 * MiB,
  });
}
function hash(file) {
  const digest = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(MiB);
    for (;;) {
      const n = fs.readSync(fd, buf);
      if (!n) break;
      digest.update(buf.subarray(0, n));
    }
    return digest.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}
const report = { versions: {}, results: [] };
try {
  fs.mkdirSync(source);
  for (const [name, binary] of Object.entries({ current, old, restic }))
    report.versions[name] = run(binary, [
      name === "restic" ? "version" : "--version",
    ]).trim();
  const zero = fs.openSync(path.join(source, "zero"), "wx", 0o600);
  fs.ftruncateSync(zero, 128 * MiB);
  fs.fsyncSync(zero);
  fs.closeSync(zero);
  const mixed = fs.openSync(path.join(source, "mixed"), "wx", 0o640);
  fs.ftruncateSync(mixed, 16 * MiB);
  for (let offset = 0; offset < 16 * MiB; offset += 65536)
    fs.writeSync(mixed, crypto.randomBytes(4096), 0, 4096, offset);
  fs.fsyncSync(mixed);
  fs.closeSync(mixed);
  fs.linkSync(path.join(source, "mixed"), path.join(source, "linked"));
  fs.symlinkSync("mixed", path.join(source, "symlink"));
  fs.writeFileSync(path.join(source, "empty"), "");
  const expected = Object.fromEntries(
    ["zero", "mixed", "linked", "empty"].map((name) => [
      name,
      hash(path.join(source, name)),
    ]),
  );

  for (const [writerName, writer] of Object.entries({ old, current })) {
    const repo = path.join(root, `repo-${writerName}`);
    const common = ["--repository", repo, "--no-cache", "--no-progress"];
    run(writer, [...common, "init"]);
    run(writer, [
      ...common,
      "backup",
      ...(writerName === "current" ? ["--strict"] : []),
      "--host",
      "compatibility",
      ".",
    ]);
    const readers = writerName === "old" ? { current } : { restic, old };
    for (const [readerName, reader] of Object.entries(readers)) {
      const dest = path.join(root, `${writerName}-to-${readerName}`);
      if (readerName === "restic") {
        run(reader, ["-r", repo, "--no-cache", "check", "--read-data"]);
        run(reader, [
          "-r",
          repo,
          "--no-cache",
          "restore",
          "latest",
          "--target",
          dest,
          "--sparse",
        ]);
      } else {
        run(reader, [...common, "check", "--read-data"]);
        run(reader, [
          ...common,
          "restore",
          ...(readerName === "current"
            ? ["--strict", "--sparse", "by-content-required"]
            : []),
          "--no-ownership",
          "latest",
          dest,
        ]);
      }
      const allocated = {};
      for (const [name, digest] of Object.entries(expected)) {
        const file = path.join(dest, name);
        assert.equal(
          hash(file),
          digest,
          `${writerName}->${readerName}: ${name}`,
        );
        const meta = fs.statSync(file);
        allocated[name] = meta.blocks * 512;
        if (readerName === "current")
          assert(
            allocated[name] <=
              fs.statSync(path.join(source, name)).blocks * 512 + MiB,
          );
      }
      assert.equal(fs.readlinkSync(path.join(dest, "symlink")), "mixed");
      assert.equal(
        fs.statSync(path.join(dest, "mixed")).ino,
        fs.statSync(path.join(dest, "linked")).ino,
      );
      report.results.push({
        writer: writerName,
        reader: readerName,
        allocated,
      });
    }
  }
  report.ok = true;
} finally {
  console.log(JSON.stringify(report, null, 2));
  fs.rmSync(root, { recursive: true, force: true });
}
