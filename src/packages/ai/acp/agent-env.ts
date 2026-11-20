/*
 *  This file is part of CoCalc: Copyright (C) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The environment of an agent process (Claude Code through CoCalc Plus's local
// harness, or a Codex app-server).
//
// CoCalc's own processes run with internal settings and credentials
// (CONAT_SERVER, COCALC_LITE_ACP_WORKER_CONAT_PASSWORD, ...). An agent must not
// inherit them: every key with one of these prefixes is dropped, so a new
// internal key is excluded by default. What an agent needs from CoCalc (the
// CLI's endpoint and scoped token, the conversation's context) is added back
// explicitly by the caller.

const INTERNAL_ENV_PREFIXES = [
  "COCALC_",
  "CONAT_",
  "MASTER_CONAT_",
  "DEBUG",
  "SMC_",
];
// Internal settings without one of those prefixes.
const INTERNAL_ENV_KEYS = new Set([
  "DATA",
  "BASE_URL",
  "PORT",
  "HUB_PORT",
  "NODE_OPTIONS",
]);
// CoCalc keys that are kept: where the CoCalc CLI is (paths, not credentials).
const COCALC_PASSTHROUGH_KEYS = ["COCALC_CLI_BIN", "COCALC_CLI_CMD"];

function isInternalEnvKey(key: string): boolean {
  return (
    INTERNAL_ENV_KEYS.has(key) ||
    INTERNAL_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

/**
 * The user's own environment, as in their terminal (PATH, HOME, USER, SHELL,
 * LANG and LC_*, TERM, proxy settings, their own provider settings), without
 * CoCalc's internal settings and credentials, plus the CoCalc CLI's location.
 * HOME is the user's original home when CoCalc moved it.
 */
export function agentBaseEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value != null && !isInternalEnvKey(key)) env[key] = value;
  }
  for (const key of COCALC_PASSTHROUGH_KEYS) {
    const value = base[key];
    if (value) env[key] = value;
  }
  if (base.COCALC_ORIGINAL_HOME) env.HOME = base.COCALC_ORIGINAL_HOME;
  return env;
}

/** A standalone app-server's environment: the process's own environment
 * without CoCalc's internal settings and credentials (agentBaseEnv), then the
 * caller's explicit `env`, then HOME. */
export function standaloneAppServerEnv(
  env?: NodeJS.ProcessEnv,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const HOME = base.COCALC_ORIGINAL_HOME ?? base.HOME;
  return {
    ...agentBaseEnv(base),
    ...(env ?? {}),
    ...(HOME ? { HOME } : {}),
  };
}
