/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";
import {
  AgentSessionIndex,
  type AgentSessionRecord,
} from "@cocalc/chat-client";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { resolveNamedAgentHost } from "@cocalc/chat-client/named-agents";
import { getActiveSiteSession } from "../cocalc/session-registry";
import { openProjectHost } from "../cocalc/site-session";
import { isPreviewProfile } from "../preview/fixtures";

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
export function useAgentAppearance(profile: string, agents: NamedAgent[]) {
  const [appearances, setAppearances] = useState<
    Record<string, AgentAppearance>
  >({});
  const [siteUrl, setSiteUrl] = useState("");
  useFocusEffect(
    useCallback(() => {
      let active = true;
      const indices: AgentSessionIndex[] = [];
      setAppearances({});
      if (isPreviewProfile(profile)) {
        setAppearances(
          Object.fromEntries(
            agents.map((agent, i) => [
              agent.endpoint.agent_id,
              {
                thread_color: ["#3558a8", "#8054a6", "#258368"][i % 3],
                thread_accent_color: ["#dce8ff", "#eddffc", "#d9f5eb"][i % 3],
                thread_icon: ["book", "calculator", "edit"][i % 3],
              },
            ]),
          ),
        );
        return;
      }
      // Read host-owned session indices without starting any project processes.
      // A missing index/host must never prevent the directory itself from opening.
      void (async () => {
        const session = await getActiveSiteSession(profile);
        if (!active) return;
        setSiteUrl(session.profile.canonical_app_url);
        const projects = [
          ...new Set(agents.map((agent) => agent.endpoint.project_id)),
        ];
        let next = 0;
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
              index.subscribe((records) => {
                if (!active) return;
                const values: Record<string, AgentAppearance> = {};
                for (const agent of agents.filter(
                  (a) => a.endpoint.project_id === project,
                )) {
                  const record = records.find(
                    (r) =>
                      r.chat_path === agent.path &&
                      r.thread_key === agent.thread_id,
                  );
                  if (record) values[agent.endpoint.agent_id] = record;
                }
                setAppearances((previous) => {
                  const updated = { ...previous };
                  for (const agent of agents.filter(
                    (a) => a.endpoint.project_id === project,
                  ))
                    delete updated[agent.endpoint.agent_id];
                  return { ...updated, ...values };
                });
              });
              await index.open();
              if (!active) index.close();
            } catch {
              /* Appearance is optional; directory and chat stay usable. */
            }
          }
        };
        await Promise.all([worker(), worker(), worker()]);
      })().catch(() => {});
      return () => {
        active = false;
        indices.forEach((index) => index.close());
      };
    }, [profile, agents]),
  );
  return { appearances, siteUrl };
}
