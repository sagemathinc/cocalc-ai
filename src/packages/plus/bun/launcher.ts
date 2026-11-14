/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The CoCalc Plus launcher for Bun.  plus/bun/build.sh compiles it, with Bun's
runtime, into one executable per platform, named cocalc-plus; that executable
is the only part that has to be signed.  It runs the app next to it,
app/bundle/index.js (the release bundle from plus/sea/build-bundle.sh, the same
on every platform), with its arguments.

CoCalc Plus starts itself again through this same executable: the daemon child,
the ACP worker (COCALC_LITE_ACP_WORKER=1) and reflect's scheduler
(--run-reflect-scheduler) all arrive here as arguments or environment, and the
app's CLI handles them.  Code that runs a script with process.execPath sets
BUN_BE_BUN=1 (plus/runtime.ts), and then Bun runs the script instead of this.
*/

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const root = dirname(process.execPath);

// rg, fd and ouch, when they come with this launcher
const bin = join(root, "bin");
if (!process.env.COCALC_BIN_PATH && existsSync(bin)) {
  process.env.COCALC_BIN_PATH = bin;
  const sep = process.platform === "win32" ? ";" : ":";
  process.env.PATH = `${bin}${sep}${process.env.PATH ?? ""}`;
}

const app =
  process.env.COCALC_PLUS_APP ?? join(root, "app", "bundle", "index.js");
if (!existsSync(app)) {
  console.error(`cocalc-plus: the app is missing (${app})`);
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
require(app)
  .runCli()
  .catch((err: any) => {
    console.error(err?.message || err);
    process.exit(1);
  });
