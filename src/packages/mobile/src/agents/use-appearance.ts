/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";
import { AgentSessionIndex } from "@cocalc/chat-client";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { resolveNamedAgentHost } from "@cocalc/chat-client/named-agents";
import { getActiveSiteSession } from "../cocalc/session-registry";
import { openProjectHost } from "../cocalc/site-session";
import { isPreviewProfile } from "../preview/fixtures";
import {
  appearanceKey,
  cachedAppearances,
  loadAppearanceCache,
  peekAppearanceCache,
  sameAppearances,
  saveAppearanceCache,
  type AgentAppearance,
  type AppearanceCache,
} from "./appearance-cache";

export type { AgentAppearance } from "./appearance-cache";

const REFRESH_MS = 60_000;

export function useAgentAppearance(profile: string, agents: NamedAgent[]) {
  const [view, setView] = useState(() => {
    const cache = peekAppearanceCache(profile);
    return {
      profile,
      ready: !!cache || isPreviewProfile(profile),
      appearances: cache ? cachedAppearances(cache, agents) : {},
      siteUrl: cache?.siteUrl ?? "",
    };
  });
  useFocusEffect(
    useCallback(() => {
      let active = true;
      const indices: AgentSessionIndex[] = [];
      const show = (cache: AppearanceCache) => {
        if (!active) return;
        const appearances = cachedAppearances(cache, agents);
        setView((previous) =>
          previous.profile === profile &&
          previous.ready &&
          previous.siteUrl === cache.siteUrl &&
          sameAppearances(previous.appearances, appearances)
            ? previous
            : { profile, ready: true, appearances, siteUrl: cache.siteUrl },
        );
      };
      if (isPreviewProfile(profile)) {
        setView({
          profile,
          ready: true,
          siteUrl: "",
          appearances: Object.fromEntries(
            agents.map((agent, i) => [
              agent.endpoint.agent_id,
              {
                thread_color: ["#3558a8", "#8054a6", "#258368"][i % 3],
                thread_accent_color: ["#dce8ff", "#eddffc", "#d9f5eb"][i % 3],
                thread_icon: ["book", "calculator", "edit"][i % 3],
              },
            ]),
          ),
        });
        return;
      }
      // The persisted cache is shown before a host connection is opened. Host
      // indices remain the authority; stale entries are replaced on refresh.
      void (async () => {
        let cache = await loadAppearanceCache(profile);
        if (!active) return;
        show(cache);
        if (!agents.length) return;
        const missing = agents.some(
          (agent) =>
            cache.items[agent.endpoint.agent_id]?.key !== appearanceKey(agent),
        );
        if (
          !missing &&
          cache.siteUrl &&
          Date.now() - cache.refreshedAt < REFRESH_MS
        )
          return;
        const session = await getActiveSiteSession(profile);
        if (!active) return;
        cache = { ...cache, siteUrl: session.profile.canonical_app_url };
        void saveAppearanceCache(profile, cache).catch(() => {});
        show(cache);
        const projects = [
          ...new Set(agents.map((agent) => agent.endpoint.project_id)),
        ];
        let next = 0;
        let succeeded = 0;
        const worker = async () => {
          while (active && next < projects.length) {
            const project = projects[next++];
            try {
              const host = await resolveNamedAgentHost(
                session.hubApi,
                session.profile.account_id,
                project,
              );
              if (!active) return;
              const lease = await openProjectHost(session, {
                project_id: project,
                host_id: host,
              });
              if (!active) return;
              const index = new AgentSessionIndex({
                client: lease.client,
                project_id: project,
              });
              indices.push(index);
              await index.open();
              if (!active) {
                index.close();
                return;
              }
              index.subscribe((records) => {
                if (!active) return;
                const items = { ...cache.items };
                for (const agent of agents.filter(
                  (a) => a.endpoint.project_id === project,
                )) {
                  const record = records.find(
                    (r) =>
                      r.chat_path === agent.path &&
                      r.thread_key === agent.thread_id,
                  );
                  if (record) {
                    const appearance: AgentAppearance = {
                      title: record.title,
                      thread_color: record.thread_color,
                      thread_accent_color: record.thread_accent_color,
                      thread_icon: record.thread_icon,
                      thread_image: record.thread_image,
                    };
                    items[agent.endpoint.agent_id] = {
                      key: appearanceKey(agent),
                      appearance,
                    };
                  } else {
                    delete items[agent.endpoint.agent_id];
                  }
                }
                cache = { ...cache, items };
                void saveAppearanceCache(profile, cache).catch(() => {});
                show(cache);
              });
              succeeded++;
            } catch {
              // Appearance is optional; directory and chat stay usable.
            }
          }
        };
        await Promise.all([worker(), worker(), worker()]);
        if (active && succeeded === projects.length) {
          cache = { ...cache, refreshedAt: Date.now() };
          void saveAppearanceCache(profile, cache).catch(() => {});
        }
      })().catch(() => {
        if (active) setView((previous) => ({ ...previous, ready: true }));
      });
      return () => {
        active = false;
        indices.forEach((index) => index.close());
      };
    }, [profile, agents]),
  );
  const cache = peekAppearanceCache(profile);
  return {
    ready: !!cache || (view.profile === profile && view.ready),
    appearances:
      cache && !isPreviewProfile(profile)
        ? cachedAppearances(cache, agents)
        : view.profile === profile
          ? view.appearances
          : {},
    siteUrl:
      cache && !isPreviewProfile(profile)
        ? cache.siteUrl
        : view.profile === profile
          ? view.siteUrl
          : "",
  };
}
