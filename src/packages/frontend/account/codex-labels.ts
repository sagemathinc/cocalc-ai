/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Labels of the Codex settings controls, kept apart from the panel components
// so settings page definitions (and Quick Navigation's keyword index) can read
// them without importing the panels themselves.

export const CODEX_DEFAULTS_LABELS = {
  title: "New Codex chat defaults",
  model: "Model",
  reasoning: "Reasoning",
  execution: "Execution mode",
} as const;

export const CODEX_CREDENTIALS_LABELS = {
  title: "OpenAI Credentials & Codex Payment Source",
  chatgpt: "Connect Codex with ChatGPT",
  apiKeys: "OpenAI API Keys",
} as const;

export const CODEX_SUBAGENTS_LABEL = "Maximum concurrent subagents";
