/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AcpLoopConfig } from "@cocalc/conat/ai/acp/types";

const LOOP_DEFAULT_MAX_TURNS = 8;
const LOOP_DEFAULT_MAX_WALL_TIME_MS = 30 * 60_000;

export function ensureLoopContractPrompt(
  prompt: string,
  loopConfig?: AcpLoopConfig,
): string {
  if (loopConfig?.enabled !== true) return prompt;
  if (prompt.includes("System loop contract (required):")) {
    return prompt;
  }
  const maxTurns = Number(loopConfig.max_turns ?? LOOP_DEFAULT_MAX_TURNS);
  const maxWallMinutes = Math.max(
    1,
    Math.round(
      Number(loopConfig.max_wall_time_ms ?? LOOP_DEFAULT_MAX_WALL_TIME_MS) /
        60_000,
    ),
  );
  return [
    prompt,
    "",
    "System loop contract (required):",
    `This run is in autonomous loop mode (max turns: ${maxTurns}, max wall time: ${maxWallMinutes} minutes).`,
    "At the END of your response, output exactly one JSON object in a ```json fenced block with this schema:",
    '{"loop":{"rerun":true|false,"needs_human":true|false,"next_prompt":"string","blocker":"string","confidence":0.0-1.0}}',
    "Rules:",
    "- If rerun=true and needs_human=false, set next_prompt to the exact next instruction for the next iteration.",
    "- If done, set rerun=false.",
    "- If human input is needed, set needs_human=true and explain blocker.",
    "- Do not omit the JSON contract block.",
  ].join("\n");
}
