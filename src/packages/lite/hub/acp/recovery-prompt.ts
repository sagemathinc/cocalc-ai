/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { AGENT_SNAPSHOTS_PROMPT_HEADING } from "@cocalc/conat/agents/attachment-staging";

/** The prompt of a turn that resumes one that did not complete: the work so
 * far is in the session and workspace, and the original prompt is repeated
 * in full, so the retry never depends on the model remembering it. */
export function buildRecoveryContinuationPrompt({
  interruptedNotice,
  recoveryCount,
  originalPrompt,
  recoveryGuidance,
  agentMessage = false,
}: {
  interruptedNotice: string;
  recoveryCount: number;
  originalPrompt: string;
  recoveryGuidance?: string;
  /** Delivered by CoCalc (from another agent, a sensor, ...), not typed by
   * a person: its own header says who it is from. */
  agentMessage?: boolean;
}): string {
  // Staged snapshots live in /tmp, so a restart since may have removed them.
  const snapshots =
    agentMessage &&
    originalPrompt.includes(`\n\n${AGENT_SNAPSHOTS_PROMPT_HEADING} (`);
  return [
    "The previous turn in this same session did not complete.",
    `Recovery attempt: ${recoveryCount}.`,
    `Interruption summary: ${`${interruptedNotice ?? ""}`.replace(/\*\*/g, "").trim()}`,
    "Resume the work from the current workspace state.",
    "Before repeating any expensive, destructive, or externally visible action, inspect what already completed and avoid duplicating side effects.",
    "If commands, calculations, or scripts may have been interrupted, determine their state first and then continue safely.",
    recoveryGuidance,
    snapshots
      ? "The original message came with file snapshots in /tmp. They are temporary and are gone if the project restarted since: check that each listed path still exists before using it. If any is missing, do not guess its contents; tell the sender, so they can send it again."
      : undefined,
    "",
    agentMessage
      ? "Original message (delivered by CoCalc; its header says who it is from):"
      : "Original user request:",
    originalPrompt,
  ]
    .filter((line): line is string => line != null)
    .join("\n");
}
