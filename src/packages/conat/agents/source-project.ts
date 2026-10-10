/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/**
 * How an agent message header names the sender's project. Saying whether it is
 * the recipient's own project matters: agents in different projects have
 * different files under the same paths (e.g. /home/user/cocalc-ai), so a path
 * in a message from another project is not a path in the recipient's project.
 *
 * Both the host that writes the header and the frontend that hides it use this,
 * so the two must stay byte-identical.
 */
export function agentSourceProjectPhrase(
  sourceProjectId: string | undefined,
  targetProjectId: string | undefined,
): string {
  const source = sourceProjectId ?? "unknown";
  if (!sourceProjectId || !targetProjectId) return `in project ${source}`;
  return sourceProjectId === targetProjectId
    ? `in project ${source}, the same project as yours`
    : `in project ${source}, a different project from yours; paths it mentions are in that project`;
}
