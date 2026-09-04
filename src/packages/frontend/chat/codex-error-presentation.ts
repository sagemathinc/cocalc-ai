/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const CODEX_PROJECT_RESTART_HINT =
  "Click settings on the left rail, restart the project, then try again.";

export const CODEX_PROJECT_RESTART_TITLE =
  "This project must be restarted to upgrade Codex.";

export const CODEX_LITE_UPGRADE_HINT =
  "Upgrade and restart CoCalc Plus, then try again.";

export const CODEX_LITE_UPGRADE_TITLE =
  "CoCalc Plus must be upgraded to update Codex.";

export function isCodexUpgradeRequiredError(error: string): boolean {
  const normalized = `${error ?? ""}`.toLowerCase();
  return (
    normalized.includes("requires a newer version of codex") ||
    normalized.includes("unknown feature flag")
  );
}

export function getCodexUpgradeInstructions(liteMode = false): {
  title: string;
  hint: string;
} {
  return liteMode
    ? { title: CODEX_LITE_UPGRADE_TITLE, hint: CODEX_LITE_UPGRADE_HINT }
    : { title: CODEX_PROJECT_RESTART_TITLE, hint: CODEX_PROJECT_RESTART_HINT };
}

export function formatCodexErrorForDisplay(
  error: string,
  liteMode = false,
): string {
  const detail = `${error ?? ""}`;
  if (!isCodexUpgradeRequiredError(detail)) {
    return detail;
  }
  const { title, hint } = getCodexUpgradeInstructions(liteMode);
  return `${title} ${hint}`;
}

export function formatCodexErrorMarkdown(
  error: string,
  liteMode = false,
): string {
  const detail = `${error ?? ""}`;
  if (!isCodexUpgradeRequiredError(detail)) {
    return detail;
  }
  const { title, hint } = getCodexUpgradeInstructions(liteMode);
  return `**${title}**\n\n${hint}`;
}
