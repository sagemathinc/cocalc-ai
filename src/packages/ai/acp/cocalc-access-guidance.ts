/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/**
 * How an agent uses the managed CoCalc connector (account or other-project
 * access granted to its named agent), shared by Codex and ACP harnesses.
 */
export function cocalcAccessGuidance(cli: string): string {
  return `When CoCalc access is enabled for this turn, use ordinary \`${cli}\` commands. The CLI keeps the own-project credential for this project and automatically selects the temporary scoped credential for permitted account or other-project operations. Inspect \`${cli} project list --help\` or the relevant command's help when needed. Do not read, print, or copy the connector credential file, and do not fall back to a broader login if a grant is absent.`;
}
