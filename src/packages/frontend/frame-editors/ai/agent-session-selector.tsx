/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Select, Space, Tag } from "antd";
import type { ReactElement } from "react";
import { useEffect, useMemo, useState } from "react";

import type { AgentSessionRecord } from "@cocalc/frontend/chat/agent-session-index";
import {
  agentSessionTitle,
  useRecentAgentSessions,
} from "@cocalc/frontend/chat/recent-agent-sessions";
import * as LS from "@cocalc/frontend/misc/local-storage-typed";
import { COLORS } from "@cocalc/util/theme";

const ASSISTANT_SESSION_LS_PREFIX = "AI-CODEX-ASSISTANT-SESSION:v1";
export const NEW_AGENT_THREAD_SESSION_ID = "__cocalc_new_agent_thread__";

export interface AgentSessionSelection {
  sessions: AgentSessionRecord[];
  selectedSessionId: string | undefined;
  selectedAgentSession: AgentSessionRecord | undefined;
  setSelectedSessionId: (sessionId: string) => void;
  saveSelectedAgentSession: () => void;
  loading: boolean;
  error: string;
}

export function isNewAgentThreadSelection(selection: AgentSessionSelection) {
  return selection.selectedSessionId === NEW_AGENT_THREAD_SESSION_ID;
}

export function usePersistentAgentSessionSelection({
  project_id,
  path,
  cacheContext,
  enabled = true,
}: {
  project_id: string;
  path: string;
  cacheContext: string;
  enabled?: boolean;
}): AgentSessionSelection {
  const storageKey = `${ASSISTANT_SESSION_LS_PREFIX}:${project_id}:${path}:${cacheContext}`;
  const [selectedSessionId, setSelectedSessionIdState] = useState<string>();
  const { sessions, loading, error } = useRecentAgentSessions({
    project_id,
    enabled,
  });

  useEffect(() => {
    if (!enabled) return;
    setSelectedSessionIdState(LS.get<string>(storageKey));
  }, [enabled, storageKey]);

  useEffect(() => {
    if (!enabled) return;
    if (sessions.length === 0) {
      setSelectedSessionIdState(undefined);
      return;
    }
    const savedSessionId = LS.get<string>(storageKey);
    const savedSession = savedSessionId
      ? sessions.find((session) => session.session_id === savedSessionId)
      : undefined;
    if (savedSession) {
      setSelectedSessionIdState(savedSession.session_id);
      return;
    }
    setSelectedSessionIdState((current) => {
      if (
        current &&
        sessions.some((session) => session.session_id === current)
      ) {
        return current;
      }
      return sessions[0]?.session_id;
    });
  }, [enabled, sessions, storageKey]);

  const selectedAgentSession = useMemo(
    () => sessions.find((session) => session.session_id === selectedSessionId),
    [sessions, selectedSessionId],
  );

  function setSelectedSessionId(sessionId: string) {
    setSelectedSessionIdState(sessionId);
    if (sessionId === NEW_AGENT_THREAD_SESSION_ID) {
      LS.del(storageKey);
      return;
    }
    LS.set(storageKey, sessionId);
  }

  function saveSelectedAgentSession() {
    if (selectedAgentSession) {
      LS.set(storageKey, selectedAgentSession.session_id);
    } else if (selectedSessionId === NEW_AGENT_THREAD_SESSION_ID) {
      LS.del(storageKey);
    }
  }

  return {
    sessions,
    selectedSessionId,
    selectedAgentSession,
    setSelectedSessionId,
    saveSelectedAgentSession,
    loading,
    error,
  };
}

export function AgentSessionSelect({
  selection,
  disabled,
  label = "Recent agent sessions",
  includeNewThreadOption = false,
}: {
  selection: AgentSessionSelection;
  disabled?: boolean;
  label?: string;
  includeNewThreadOption?: boolean;
}): ReactElement | null {
  if (selection.sessions.length === 0 && !includeNewThreadOption) {
    return null;
  }
  const options = [
    ...(includeNewThreadOption
      ? [
          {
            value: NEW_AGENT_THREAD_SESSION_ID,
            title: "New agent thread",
            label: <NewAgentThreadOption />,
          },
        ]
      : []),
    ...selection.sessions.map((session) => ({
      value: session.session_id,
      title: `${agentSessionTitle(session)} · ${agentSessionCostSummary(
        session,
      )}`,
      label: <AgentSessionOption session={session} />,
    })),
  ];
  return (
    <Space orientation="vertical" size={4} style={{ width: "100%" }}>
      <div style={{ fontWeight: 500 }}>{label}</div>
      <Select
        aria-label={label}
        value={selection.selectedSessionId}
        placeholder="Workspace agent thread"
        loading={selection.loading}
        disabled={disabled}
        style={{ width: "100%" }}
        optionLabelProp="title"
        onChange={selection.setSelectedSessionId}
        options={options}
      />
    </Space>
  );
}

export function AgentSessionError({
  selection,
}: {
  selection: AgentSessionSelection;
}): ReactElement | null {
  if (selection.sessions.length === 0 || !selection.error) {
    return null;
  }
  return (
    <Alert
      type="warning"
      showIcon
      title="Could not load recent agent sessions."
      description={selection.error}
    />
  );
}

function AgentSessionOption({
  session,
}: {
  session: AgentSessionRecord;
}): ReactElement {
  const title = agentSessionTitle(session);
  const context =
    session.working_directory?.trim() || session.chat_path?.trim() || "";
  const tags = agentSessionTags(session);
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          alignItems: "center",
          display: "flex",
          gap: 6,
          overflow: "hidden",
        }}
      >
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </span>
        <span style={{ flex: "0 0 auto" }}>
          {tags.map(({ key, label, color }) => (
            <Tag key={key} color={color} style={{ marginInlineEnd: 4 }}>
              {label}
            </Tag>
          ))}
        </span>
      </div>
      {context ? (
        <div
          style={{
            color: COLORS.GRAY_D,
            fontSize: 12,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {context}
        </div>
      ) : null}
    </div>
  );
}

function NewAgentThreadOption(): ReactElement {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontWeight: 500 }}>New agent thread</div>
      <div style={{ color: COLORS.GRAY_D, fontSize: 12 }}>
        Start with fresh context in the workspace chat.
      </div>
    </div>
  );
}

function prettyValue(value?: string): string | undefined {
  const trimmed = `${value ?? ""}`.trim();
  if (!trimmed) return undefined;
  return trimmed
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function agentSessionTags(session: AgentSessionRecord): {
  key: string;
  label: string;
  color?: string;
}[] {
  const model = `${session.model ?? ""}`.trim() || "default model";
  const reasoning = prettyValue(session.reasoning) ?? "Default reasoning";
  const serviceTier =
    `${session.serviceTier ?? ""}`.trim() === "fast" ? "Fast" : "Standard";
  const mode = prettyValue(session.mode);
  return [
    { key: "model", label: model },
    { key: "reasoning", label: reasoning },
    {
      key: "service-tier",
      label: serviceTier,
      color: serviceTier === "Fast" ? "orange" : undefined,
    },
    ...(mode ? [{ key: "mode", label: mode }] : []),
  ];
}

function agentSessionCostSummary(session: AgentSessionRecord): string {
  return agentSessionTags(session)
    .map(({ label }) => label)
    .join(" · ");
}
