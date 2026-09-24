/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState, type ReactNode } from "react";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { resultKey, useUnseenResult } from "./unseen-result";
import { Tooltip } from "@cocalc/frontend/components";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

const REFRESH_MS = 5_000;
type Listener = (threads: ReadonlySet<string>) => void;
type ActivityEntry = {
  threads: ReadonlySet<string>;
  listeners: Set<Listener>;
  timer?: ReturnType<typeof setTimeout>;
  refreshing: boolean;
  lastSuccessAt: number;
  onFocus?: () => void;
};
const activityByProject = new Map<string, ActivityEntry>();

function threadKey(path: string, threadId: string): string {
  return `${path}\0${threadId}`;
}

function entryForProject(projectId: string): ActivityEntry {
  let entry = activityByProject.get(projectId);
  if (!entry) {
    entry = {
      threads: new Set(),
      listeners: new Set(),
      refreshing: false,
      lastSuccessAt: 0,
    };
    activityByProject.set(projectId, entry);
  }
  return entry;
}

function publish(entry: ActivityEntry, threads: ReadonlySet<string>): void {
  entry.threads = threads;
  for (const listener of entry.listeners) listener(threads);
}

async function refreshProject(projectId: string, entry: ActivityEntry) {
  if (entry.refreshing || entry.listeners.size === 0) return;
  entry.refreshing = true;
  try {
    const result = await webapp_client.conat_client.controlAcp({
      action: "status",
      project_id: projectId,
    });
    if (result.ok && entry.listeners.size > 0) {
      entry.lastSuccessAt = Date.now();
      publish(
        entry,
        new Set(
          (result.active_threads ?? []).map(({ path, thread_id }) =>
            threadKey(path, thread_id),
          ),
        ),
      );
    }
  } catch {
    if (Date.now() - entry.lastSuccessAt > REFRESH_MS * 3) {
      publish(entry, new Set());
    }
  } finally {
    entry.refreshing = false;
    if (entry.listeners.size > 0) {
      entry.timer = setTimeout(
        () => void refreshProject(projectId, entry),
        REFRESH_MS,
      );
    }
  }
}

function useActiveProjectThreads(
  accountId: string,
  projectId: string,
): ReadonlySet<string> {
  const cacheKey = `${accountId}\0${projectId}`;
  const [threads, setThreads] = useState<ReadonlySet<string>>(
    () => entryForProject(cacheKey).threads,
  );
  useEffect(() => {
    const entry = entryForProject(cacheKey);
    entry.listeners.add(setThreads);
    setThreads(entry.threads);
    if (entry.listeners.size === 1) {
      entry.onFocus = () => {
        if (entry.timer) clearTimeout(entry.timer);
        void refreshProject(projectId, entry);
      };
      window.addEventListener("focus", entry.onFocus);
      void refreshProject(projectId, entry);
    }
    return () => {
      entry.listeners.delete(setThreads);
      if (entry.listeners.size === 0) {
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.onFocus) window.removeEventListener("focus", entry.onFocus);
        activityByProject.delete(cacheKey);
      }
    };
  }, [cacheKey, projectId]);
  return threads;
}

export function AgentRunningIndicator({
  agent,
  children,
}: {
  agent: NamedAgent;
  children: ReactNode;
}) {
  const account = useTypedRedux("account", "account_id") ?? "";
  const activeThreads = useActiveProjectThreads(
    account,
    agent.endpoint.project_id,
  );
  const running = activeThreads.has(threadKey(agent.path, agent.thread_id));
  const unseen = useUnseenResult(
    resultKey(account, agent.endpoint.project_id, agent.path, agent.thread_id),
  );

  return (
    <span
      style={{
        display: "inline-flex",
        flex: "0 0 auto",
        position: "relative",
      }}
    >
      {children}
      {running || unseen ? (
        <Tooltip
          title={running ? "Agent is running" : "Finished: unseen result"}
        >
          <span
            role="status"
            aria-label={
              running
                ? `@${agent.name} is running`
                : `@${agent.name} has an unseen result`
            }
            style={{
              background: running ? UI_COLORS.success : UI_COLORS.primary,
              color: UI_COLORS.surface,
              fontSize: 10,
              fontWeight: "bold",
              lineHeight: "12px",
              textAlign: "center",
              border: `2px solid ${UI_COLORS.surface}`,
              borderRadius: "50%",
              bottom: -2,
              boxSizing: "border-box",
              height: running ? 11 : 16,
              position: "absolute",
              right: -2,
              width: running ? 11 : 16,
            }}
          >
            {unseen && !running ? "!" : null}
          </span>
        </Tooltip>
      ) : null}
    </span>
  );
}
