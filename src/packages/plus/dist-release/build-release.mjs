#!/usr/bin/env node
/*
 * Build a CoCalc Plus release (distribution Phase A) into a directory:
 *
 *   <out>/files/<sha256>   launcher, bootstrap, Node archives and the parts
 *   <out>/build.json       the manifest fields and file list, without the
 *                          release number, which publish-release.mjs assigns
 *
 * Parts are zstd-compressed tars, unpacked side by side into one release
 * directory on the user's machine:
 *   app/<platform>    bundle/ (Lite, with that platform's native modules)
 *   static, public    the frontend and its assets (the same everywhere)
 *   tools/<platform>  tools/bin: rg, fd and ouch from the tools-minimal
 *                     artifact, plus the CLI from this build
 *
 * Usage:
 *   node plus/dist-release/build-release.mjs [--out DIR]
 *     [--platforms linux-x64,linux-arm64,darwin-arm64] [--node-version 26.12.1]
 *     [--skip-node-signature] [--zstd-level 19]
 * Then publish with the same command as the CLI:
 *   node cli/dist-release/publish-release.mjs --build <out> [...]
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, zstdCompressSync } from "node:zlib";
import {
  addFile,
  download,
  gitIdentity,
  nodeSection,
  parseArgs,
  run,
  sha256,
  wantedPlatforms,
} from "../../cli/dist-release/lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const plusRoot = resolve(here, "..");
const packages = resolve(plusRoot, "..");
const TOOLS_BASE = "https://software.cocalc.ai/software/tools-minimal";

function tarZst(cwd, entries, level) {
  const tar = spawnSync("tar", ["-cf", "-", "-C", cwd, ...entries], {
    maxBuffer: 2 * 1024 * 1024 * 1024,
  });
  if (tar.status !== 0) {
    throw new Error(`tar failed: ${tar.stderr?.toString()}`);
  }
  return zstdCompressSync(tar.stdout, {
    params: { [constants.ZSTD_c_compressionLevel]: level },
  });
}

// rg, fd and ouch for a platform, from the published tools-minimal artifact.
async function toolsBinaries(platform, work) {
  const [os, arch] = platform.split("-");
  const storeArch = arch === "x64" ? "amd64" : arch;
  let info;
  const url = `${TOOLS_BASE}/latest-${os}-${storeArch}.json`;
  for (let attempt = 1; info == null; attempt += 1) {
    try {
      info = JSON.parse((await download(url)).toString("utf8"));
    } catch (err) {
      if (attempt >= 3) {
        process.stdout.write(`  ${url}: ${err?.message ?? err}\n`);
        return undefined;
      }
    }
  }
  const archive = await download(info.url);
  if (sha256(archive) !== info.sha256) {
    throw new Error(`tools-minimal for ${platform} does not match its sha256`);
  }
  const dir = join(work, `tools-${platform}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tools.tar.xz"), archive);
  run("tar", ["-xJf", join(dir, "tools.tar.xz"), "-C", dir]);
  return dir;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = resolve(
    typeof args.out === "string"
      ? args.out
      : join(plusRoot, "build", "plus-release"),
  );
  const level = Number(args["zstd-level"] ?? 19);
  // darwin-x64 has no tools-minimal artifact, so it isn't built by default.
  const platforms = wantedPlatforms({
    platforms: "linux-x64,linux-arm64,darwin-arm64",
    ...args,
  });
  const work = join(tmpdir(), `cocalc-plus-release-${process.pid}`);
  rmSync(out, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(out, "files"), { recursive: true });
  mkdirSync(work, { recursive: true });
  const files = [];
  const add = (buffer) => {
    const ref = addFile(out, buffer);
    files.push(ref);
    return ref;
  };

  try {
    // The CLI bundle goes into tools/bin, so agents in Lite run this build's CLI.
    run(process.execPath, [join(packages, "cli", "sea", "build-bundle.mjs")]);
    const cliBundle = join(packages, "cli", "build", "bundle", "index.js");
    const cliLicenses = join(
      packages,
      "cli",
      "build",
      "bundle",
      "licenses.txt",
    );

    const app = {};
    const tools = {};
    let shared;
    for (const platform of platforms) {
      const [os, arch] = platform.split("-");
      const bundleOut = join(work, `bundle-${platform}`);
      run("bash", [join(plusRoot, "sea", "build-bundle.sh"), bundleOut], {
        env: {
          ...process.env,
          COCALC_PLUS_TARGET_OS: os,
          COCALC_PLUS_TARGET_ARCH: arch,
        },
      });
      process.stdout.write(`Compressing the ${platform} app...\n`);
      const appEntries = ["bundle"];
      if (existsSync(join(bundleOut, "build"))) appEntries.push("build");
      app[platform] = add(tarZst(bundleOut, appEntries, level));
      if (shared == null) {
        process.stdout.write("Compressing static and public...\n");
        shared = {
          static: add(tarZst(bundleOut, ["static"], level)),
          public: add(tarZst(bundleOut, ["public"], level)),
        };
      }

      const binaries = await toolsBinaries(platform, work);
      if (binaries == null) {
        throw new Error(
          `no tools-minimal artifact for ${platform}; CoCalc Plus needs its tools on every platform`,
        );
      } else {
        const toolsDir = join(work, `tools-tree-${platform}`, "tools");
        mkdirSync(join(toolsDir, "bin"), { recursive: true });
        mkdirSync(join(toolsDir, "share", "licenses", "cocalc-cli"), {
          recursive: true,
        });
        for (const name of ["rg", "fd", "ouch"]) {
          const source = join(binaries, "bin", name);
          if (existsSync(source)) {
            copyFileSync(source, join(toolsDir, "bin", name));
          }
        }
        // cocalc-cli.js starts the bundle with the compile cache on.
        copyFileSync(cliBundle, join(toolsDir, "bin", "cocalc-cli-bundle.js"));
        copyFileSync(
          join(packages, "cli", "sea", "cli-loader.cjs"),
          join(toolsDir, "bin", "cocalc-cli.js"),
        );
        writeFileSync(
          join(toolsDir, "bin", "cocalc"),
          '#!/usr/bin/env sh\nset -eu\nSCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec node "$SCRIPT_DIR/cocalc-cli.js" "$@"\n',
          { mode: 0o755 },
        );
        symlinkSync("cocalc", join(toolsDir, "bin", "cocalc-cli"));
        if (existsSync(cliLicenses)) {
          copyFileSync(
            cliLicenses,
            join(toolsDir, "share", "licenses", "cocalc-cli", "licenses.txt"),
          );
        }
        tools[platform] = add(tarZst(dirname(toolsDir), ["tools"], level));
      }
    }

    const node = await nodeSection(out, args, platforms);
    for (const archive of Object.values(node.platforms)) files.push(archive);
    const launcher = add(readFileSync(join(here, "launcher.sh")));
    const bootstrap = add(readFileSync(join(here, "bootstrap.js")));
    const pkg = JSON.parse(
      readFileSync(join(plusRoot, "package.json"), "utf8"),
    );
    const build = {
      schema: "cocalc-plus-release/1",
      fields: {
        version: pkg.version,
        git: gitIdentity(plusRoot),
        built_at: new Date().toISOString(),
        launcher,
        bootstrap,
        node,
        app,
        tools,
        static: shared.static,
        public: shared.public,
      },
      files,
    };
    writeFileSync(
      join(out, "build.json"),
      JSON.stringify(build, null, 2) + "\n",
    );
    const mb = (ref) => `${(ref.size / 1e6).toFixed(1)} MB`;
    process.stdout.write(
      `CoCalc Plus release built in ${out}: ${platforms
        .map((p) => `${p} app ${mb(app[p])}`)
        .join(
          ", ",
        )}; static ${mb(shared.static)}, public ${mb(shared.public)}\n`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
