/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The sidebar's "Recent" agents: how many it shows (a per-account setting,
// the same on every device), and the agents waiting for this person's answer,
// which are always shown until they are answered.

/** Account setting (other_settings) for how many recent agents to show. */
export const SIDEBAR_RECENT_AGENTS_SETTING = "agents_sidebar_recent_count";
export const SIDEBAR_RECENT_AGENTS_CHOICES = [3, 5, 7, 10] as const;
const DEFAULT_COUNT = 3;

export function sidebarRecentAgentsCount(value: unknown): number {
  return (SIDEBAR_RECENT_AGENTS_CHOICES as readonly unknown[]).includes(value)
    ? (value as number)
    : DEFAULT_COUNT;
}

export function waitingKey(project_id: string, thread_id: string): string {
  return `${project_id}:${thread_id}`;
}

type MentionLike = { get(key: string): unknown };

/**
 * The conversations (project and thread) with a request waiting for this
 * person, from the account's notifications: an agent's question, or an
 * approval it asked for. A notice stops counting once it is answered.
 */
export function waitingThreads(
  // The mentions store's Map, or an array.
  mentions: { values(): Iterable<MentionLike> } | null | undefined,
): Set<string> {
  const waiting = new Set<string>();
  if (!mentions) return waiting;
  for (const mention of mentions.values()) {
    if (mention?.get("notice_type") !== "codex_attention") continue;
    if ((mention.get("attention_state") ?? "pending") !== "pending") continue;
    const project_id = mention.get("project_id");
    const thread_id = mention.get("thread_id");
    if (typeof project_id !== "string" || typeof thread_id !== "string")
      continue;
    if (!project_id || !thread_id) continue;
    waiting.add(waitingKey(project_id, thread_id));
  }
  return waiting;
}

/**
 * The unpinned agents the sidebar lists without a search: the most recent
 * `count`, then every other one waiting for an answer, then the open one.
 */
export function sidebarRecentAgents<T>(
  unpinned: readonly T[],
  {
    count,
    isWaiting,
    selected,
  }: { count: number; isWaiting: (agent: T) => boolean; selected?: T },
): T[] {
  const shown = unpinned.slice(0, count);
  for (const agent of unpinned.slice(count))
    if (isWaiting(agent)) shown.push(agent);
  if (selected && unpinned.includes(selected) && !shown.includes(selected))
    shown.push(selected);
  return shown;
}
