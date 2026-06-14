/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";

import type { AgentSessionRecord } from "@cocalc/frontend/chat/agent-session-index";
import { watchAgentSessionsForProject } from "@cocalc/frontend/chat/agent-session-index";
import { html_to_text } from "@cocalc/frontend/misc";

export function agentSessionDateMs(value?: string): number {
  if (!value) return 0;
  const ms = new Date(value).valueOf();
  return Number.isFinite(ms) ? ms : 0;
}

export function agentSessionTitle(record: AgentSessionRecord): string {
  const raw = typeof record.title === "string" ? record.title : "";
  const plain = html_to_text(raw).replace(/\s+/g, " ").trim();
  if (plain) return plain;
  return "Navigator session";
}

export function sortRecentAgentSessions(
  sessions: readonly AgentSessionRecord[],
): AgentSessionRecord[] {
  return [...sessions].sort(
    (a, b) =>
      Math.max(
        agentSessionDateMs(b.updated_at),
        agentSessionDateMs(b.created_at),
      ) -
      Math.max(
        agentSessionDateMs(a.updated_at),
        agentSessionDateMs(a.created_at),
      ),
  );
}

export function selectableRecentAgentSessions(
  sessions: readonly AgentSessionRecord[],
): AgentSessionRecord[] {
  return sortRecentAgentSessions(
    sessions.filter((session) => {
      if (session.status === "archived") return false;
      return (
        typeof session.chat_path === "string" &&
        session.chat_path.trim().length > 0 &&
        typeof session.thread_key === "string" &&
        session.thread_key.trim().length > 0
      );
    }),
  );
}

export function useRecentAgentSessions({
  project_id,
  enabled = true,
}: {
  project_id: string;
  enabled?: boolean;
}): {
  sessions: AgentSessionRecord[];
  loading: boolean;
  error: string;
} {
  const [records, setRecords] = useState<AgentSessionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!enabled || !project_id) {
      setRecords([]);
      setLoading(false);
      setError("");
      return;
    }
    let closed = false;
    let unsubscribe: (() => void) | undefined;
    setLoading(true);
    setError("");
    void watchAgentSessionsForProject(
      { project_id },
      (nextRecords: AgentSessionRecord[]) => {
        if (closed) return;
        setRecords(nextRecords);
        setLoading(false);
      },
    )
      .then((cleanup) => {
        if (closed) {
          cleanup();
          return;
        }
        unsubscribe = cleanup;
        setLoading(false);
      })
      .catch((err) => {
        if (closed) return;
        setError(`${err}`);
        setLoading(false);
      });

    return () => {
      closed = true;
      unsubscribe?.();
    };
  }, [enabled, project_id]);

  const sessions = useMemo(
    () => selectableRecentAgentSessions(records),
    [records],
  );

  return { sessions, loading, error };
}
