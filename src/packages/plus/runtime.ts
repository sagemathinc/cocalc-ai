/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/**
 * The environment for running a script with process.execPath as its
 * interpreter (`spawn(process.execPath, [script, ...args])`).  Under Bun,
 * process.execPath is the CoCalc Plus launcher, a compiled executable that
 * otherwise starts CoCalc Plus; BUN_BE_BUN=1 makes it act as bun.
 */
export function execPathScriptEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return process.versions.bun ? { ...env, BUN_BE_BUN: "1" } : env;
}
