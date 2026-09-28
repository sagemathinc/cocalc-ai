#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const seaDir = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(seaDir, "../../..");
const cliRoot = join(srcRoot, "packages", "cli");
const out = resolve(process.argv[2] || join(cliRoot, "build", "bundle"));
const entry = join(cliRoot, "dist", "bin", "cocalc.js");
const require = createRequire(join(cliRoot, "package.json"));
const ncc = require.resolve("@vercel/ncc/dist/ncc/cli.js");

function run(command, args, options = {}) {
  process.stdout.write(`+ ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, {
    cwd: srcRoot,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with exit status ${result.status ?? "unknown"}`,
    );
  }
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
mkdirSync(out, { recursive: true });
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

run(pnpm, ["--dir", cliRoot, "build"]);
run(
  process.execPath,
  [ncc, "build", entry, "-o", out, "--minify", "--license", "licenses.txt"],
  {
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, "--max-old-space-size=8192"]
        .filter(Boolean)
        .join(" "),
    },
  },
);

const bundle = join(out, "index.js");
if (!existsSync(bundle)) {
  throw new Error(`bundle output is missing: ${bundle}`);
}
const git = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: cliRoot,
  encoding: "utf8",
});
const status = spawnSync(
  "git",
  ["status", "--porcelain", "--untracked-files=no"],
  {
    cwd: cliRoot,
    encoding: "utf8",
  },
);
if (git.status !== 0 || status.status !== 0) {
  throw new Error("Cannot stamp CLI bundle without Git build identity");
}
const metadata = { git: git.stdout.trim(), dirty: !!status.stdout.trim() };
const source = readFileSync(bundle, "utf8");
const start = source.startsWith("#!") ? source.indexOf("\n") + 1 : 0;
writeFileSync(
  bundle,
  source.slice(0, start) +
    `globalThis.__COCALC_CLI_BUILD__=${JSON.stringify(metadata)};\n` +
    source.slice(start),
);
process.stdout.write(`Bundle ready: ${bundle}\n`);
