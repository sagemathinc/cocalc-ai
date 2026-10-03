/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// An agent's theme: its thread's title, colors, icon and image. The .chat
// thread metadata is the source; agent_identities keeps a copy so lists can
// show it without loading the chat.
export interface AgentAppearance {
  name?: string;
  thread_color?: string;
  thread_accent_color?: string;
  thread_icon?: string;
  thread_image?: string;
}

const LIMITS: Record<keyof AgentAppearance, number> = {
  name: 200,
  thread_color: 64,
  thread_accent_color: 64,
  thread_icon: 100,
  thread_image: 500,
};

// Keep only known, non-empty, bounded string fields; null if nothing is set.
export function normalizeAgentAppearance(
  value: unknown,
): AgentAppearance | null {
  if (value == null || typeof value !== "object") return null;
  const result: AgentAppearance = {};
  for (const key of Object.keys(LIMITS) as (keyof AgentAppearance)[]) {
    const field = (value as Record<string, unknown>)[key];
    if (typeof field !== "string") continue;
    const trimmed = field.trim();
    if (!trimmed) continue;
    if (trimmed.length > LIMITS[key]) throw Error(`${key} is too long`);
    result[key] = trimmed;
  }
  return Object.keys(result).length ? result : null;
}
