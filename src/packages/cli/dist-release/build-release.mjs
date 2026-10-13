#!/usr/bin/env node
/*
 * Build a CoCalc CLI release (distribution Phase A) into a directory:
 *
 *   <out>/files/<sha256>   the launcher, bootstrap, bundle and Node archives
 *   <out>/build.json       everything the release manifest needs except the
 *                          release number, which publish-release.mjs assigns
 *
 * Node archives come from nodejs.org. Their checksums are taken from Node's
 * SHASUMS256.txt, which is verified with gpgv against the Node release keys.
 * That keeps an honest release honest; it does not protect clients from the
 * site they trust (see src/.agents/cli-distribution-2026-10-12.md).
 *
 * Usage:
 *   node dist-release/build-release.mjs [--out DIR] [--bundle index.js]
 *     [--node-version 26.11.1] [--node-keyring pubring.kbx]
 *     [--skip-node-signature] [--platforms linux-x64,darwin-arm64]
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..");
const PLATFORMS = ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"];
const NODE_DIST = "https://nodejs.org/dist";
const NODE_KEYRING_URL =
  "https://github.com/nodejs/release-keys/raw/HEAD/gpg-only-active-keys/pubring.kbx";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function run(command, args, options = {}) {
  process.stdout.write(`+ ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit status ${result.status}`);
  }
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function addFile(out, buffer) {
  const hash = sha256(buffer);
  const target = join(out, "files", hash);
  if (!existsSync(target)) {
    const temp = `${target}.tmp-${process.pid}`;
    writeFileSync(temp, buffer);
    renameSync(temp, target);
  }
  return { sha256: hash, size: buffer.length };
}

function git(args) {
  const result = spawnSync("git", args, { cwd: cliRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

// Size and sha256 of bin/node inside an archive, so installed runtimes can
// be checked before they are reused.
function nodeBinary(archive, dir) {
  const work = join(tmpdir(), `cocalc-cli-node-bin-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    writeFileSync(join(work, "node.tar.gz"), archive);
    run("tar", [
      "-xzf",
      join(work, "node.tar.gz"),
      "-C",
      work,
      `${dir}/bin/node`,
    ]);
    const binary = readFileSync(join(work, dir, "bin", "node"));
    return { sha256: sha256(binary), size: binary.length };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function verifiedNodeChecksums(version, args) {
  const base = `${NODE_DIST}/v${version}`;
  const shasums = await download(`${base}/SHASUMS256.txt`);
  if (args["skip-node-signature"]) {
    console.warn(
      "WARNING: --skip-node-signature: Node checksums are NOT verified against the Node release keys.",
    );
  } else {
    const work = join(tmpdir(), `cocalc-cli-node-${process.pid}`);
    mkdirSync(work, { recursive: true });
    try {
      const signature = await download(`${base}/SHASUMS256.txt.sig`);
      const keyring =
        typeof args["node-keyring"] === "string"
          ? resolve(args["node-keyring"])
          : join(work, "pubring.kbx");
      if (typeof args["node-keyring"] !== "string") {
        writeFileSync(keyring, await download(NODE_KEYRING_URL));
      }
      writeFileSync(join(work, "SHASUMS256.txt"), shasums);
      writeFileSync(join(work, "SHASUMS256.txt.sig"), signature);
      run("gpgv", [
        "--keyring",
        keyring,
        join(work, "SHASUMS256.txt.sig"),
        join(work, "SHASUMS256.txt"),
      ]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  const sums = new Map();
  for (const line of shasums.toString("utf8").split("\n")) {
    const match = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim());
    if (match) sums.set(match[2], match[1]);
  }
  return sums;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = resolve(
    typeof args.out === "string"
      ? args.out
      : join(cliRoot, "build", "cli-release"),
  );
  const nodeVersion =
    typeof args["node-version"] === "string"
      ? args["node-version"]
      : readFileSync(join(here, "node-version"), "utf8").trim();
  if (!/^\d+\.\d+\.\d+$/.test(nodeVersion)) {
    throw new Error(`invalid Node version: ${nodeVersion}`);
  }

  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "files"), { recursive: true });

  let bundlePath =
    typeof args.bundle === "string" ? resolve(args.bundle) : undefined;
  if (!bundlePath) {
    run(process.execPath, [join(cliRoot, "sea", "build-bundle.mjs")]);
    bundlePath = join(cliRoot, "build", "bundle", "index.js");
  }
  const bundle = addFile(out, readFileSync(bundlePath));
  const launcher = addFile(out, readFileSync(join(here, "launcher.sh")));
  const bootstrap = addFile(out, readFileSync(join(here, "bootstrap.js")));

  const sums = await verifiedNodeChecksums(nodeVersion, args);
  const wanted =
    typeof args.platforms === "string" ? args.platforms.split(",") : PLATFORMS;
  for (const platform of wanted) {
    if (!PLATFORMS.includes(platform)) {
      throw new Error(`unknown platform: ${platform}`);
    }
  }
  const platforms = {};
  for (const platform of wanted) {
    const dir = `node-v${nodeVersion}-${platform}`;
    const name = `${dir}.tar.gz`;
    const expected = sums.get(name);
    if (!expected) throw new Error(`Node ${nodeVersion} has no ${name}`);
    const url = `${NODE_DIST}/v${nodeVersion}/${name}`;
    process.stdout.write(`Downloading ${url}\n`);
    const archive = await download(url);
    const ref = addFile(out, archive);
    if (ref.sha256 !== expected) {
      throw new Error(`${name} does not match SHASUMS256.txt`);
    }
    platforms[platform] = {
      ...ref,
      url,
      dir,
      binary: nodeBinary(archive, dir),
    };
  }

  const head = git(["rev-parse", "HEAD"]);
  const dirty = !!git(["status", "--porcelain", "--untracked-files=no"]);
  const pkg = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8"));
  const build = {
    version: pkg.version,
    git: dirty ? `${head}-dirty` : head,
    built_at: new Date().toISOString(),
    launcher,
    bootstrap,
    bundle,
    node: { version: nodeVersion, platforms },
  };
  writeFileSync(join(out, "build.json"), JSON.stringify(build, null, 2) + "\n");
  process.stdout.write(
    `CLI release built in ${out}: bundle ${bundle.sha256.slice(0, 12)}, Node ${nodeVersion}\n`,
  );
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
