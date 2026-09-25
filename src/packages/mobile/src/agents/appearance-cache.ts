/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { AgentSessionRecord } from "@cocalc/chat-client";
import type { NamedAgent } from "@cocalc/conat/agents/personal";

export type AgentAppearance = Partial<
  Pick<
    AgentSessionRecord,
    | "thread_color"
    | "thread_accent_color"
    | "thread_icon"
    | "thread_image"
    | "title"
  >
>;

type CachedAppearance = {
  key: string;
  appearance: AgentAppearance;
};

export type AppearanceCache = {
  siteUrl: string;
  refreshedAt: number;
  items: Record<string, CachedAppearance>;
};

const PREFIX = "cocalc.mobile.agent-appearance.v1.";
const memory = new Map<string, AppearanceCache>();
const writes = new Map<string, Promise<void>>();

export function appearanceKey(agent: NamedAgent): string {
  return `${agent.endpoint.project_id}\0${agent.path}\0${agent.thread_id}`;
}

export function peekAppearanceCache(
  profile: string,
): AppearanceCache | undefined {
  return memory.get(profile);
}

export async function loadAppearanceCache(
  profile: string,
): Promise<AppearanceCache> {
  const cached = memory.get(profile);
  if (cached) return cached;
  let parsed: Partial<AppearanceCache> | undefined;
  try {
    const raw = await AsyncStorage.getItem(PREFIX + profile);
    if (raw && raw.length <= 1_000_000) parsed = JSON.parse(raw);
  } catch {
    // Cache loss must never prevent the agent directory from opening.
  }
  const items: AppearanceCache["items"] = {};
  if (parsed?.items && typeof parsed.items === "object") {
    for (const [id, entry] of Object.entries(parsed.items)) {
      if (
        entry &&
        typeof entry.key === "string" &&
        entry.appearance &&
        typeof entry.appearance === "object"
      ) {
        items[id] = entry;
      }
    }
  }
  const value: AppearanceCache = {
    siteUrl: typeof parsed?.siteUrl === "string" ? parsed.siteUrl : "",
    refreshedAt:
      typeof parsed?.refreshedAt === "number" ? parsed.refreshedAt : 0,
    items,
  };
  memory.set(profile, value);
  return value;
}

export function cachedAppearances(
  cache: AppearanceCache,
  agents: NamedAgent[],
): Record<string, AgentAppearance> {
  const appearances: Record<string, AgentAppearance> = {};
  for (const agent of agents) {
    const entry = cache.items[agent.endpoint.agent_id];
    if (entry?.key === appearanceKey(agent))
      appearances[agent.endpoint.agent_id] = entry.appearance;
  }
  return appearances;
}

export function sameAppearances(
  left: Record<string, AgentAppearance>,
  right: Record<string, AgentAppearance>,
): boolean {
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => {
    const a = left[key];
    const b = right[key];
    return (
      !!b &&
      a.title === b.title &&
      a.thread_color === b.thread_color &&
      a.thread_accent_color === b.thread_accent_color &&
      a.thread_icon === b.thread_icon &&
      a.thread_image === b.thread_image
    );
  });
}

export function saveAppearanceCache(profile: string, cache: AppearanceCache) {
  memory.set(profile, cache);
  const previous = writes.get(profile) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => AsyncStorage.setItem(PREFIX + profile, JSON.stringify(cache)));
  writes.set(profile, next);
  void next
    .finally(() => {
      if (writes.get(profile) === next) writes.delete(profile);
    })
    .catch(() => {});
  return next;
}
