/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Lite startup drops inherited COCALC_* variables (project-setup cleanup());
// these are kept, since Lite's ACP, Codex and Claude runtimes read them.

export const PRESERVED_COCALC_ENV_KEYS = [
  "COCALC_ACP_MODE",
  "COCALC_ACP_MOCK_SCRIPT",
  "COCALC_ACP_MOCK_FILE",
  "COCALC_ACP_EXECUTOR",
  "COCALC_LITE_ACP_DETACHED_WORKER",
  "COCALC_CODEX_BIN",
  "COCALC_CODEX_HOME",
  // Claude Code in CoCalc Plus (hub/acp/local-harness.ts)
  "COCALC_CLAUDE_BIN",
  "COCALC_CLAUDE_AGENT_ACP",
  "COCALC_CLI_BIN",
  "COCALC_CLI_CMD",
  "COCALC_ENABLE_PROJECT_INFO",
  "COCALC_WINDOWS_TERMINAL_SHELL",
] as const;

export function captureEnv(keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = `${process.env[key] ?? ""}`.trim();
    if (value) out[key] = value;
  }
  return out;
}

export function restoreEnv(env: Record<string, string>) {
  for (const key in env) {
    const value = `${env[key] ?? ""}`.trim();
    if (value) process.env[key] = value;
  }
}
