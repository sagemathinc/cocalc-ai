/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  InfoCircleOutlined,
  QuestionCircleOutlined,
  RobotOutlined,
} from "@ant-design/icons";
import { useState } from "react";
import type { AgentSessionActivity } from "@cocalc/conat/agents/personal";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { markdown_to_slate } from "../markdown-to-slate";
import {
  register,
  type RenderElementProps,
  type SlateElement,
} from "./register";

export interface AgentMessage extends SlateElement {
  type: "agent-message";
  agent_session_id?: string;
  attempt_id?: string;
  source_label?: string;
}

function deliveryLabel(activity: AgentSessionActivity): string {
  switch (activity.effective_delivery) {
    case "idle-wake":
      return "Woke idle agent";
    case "live-guidance":
      return "Delivered as guidance";
    case "queued-fallback":
      return "Queued (live unavailable)";
    case "external-inbox":
      return "External inbox";
    case "queued":
      return "Queued";
    default:
      return activity.configured_delivery === "live" ? "Live" : "Queued";
  }
}

function outcomePresentation(activity: AgentSessionActivity) {
  switch (activity.outcome) {
    case "accepted":
      return {
        label: "Accepted for delivery",
        color: UI_COLORS.success,
        background: UI_COLORS.successBg,
        icon: <CheckCircleOutlined />,
      };
    case "rejected":
      return {
        label: "Rejected",
        color: UI_COLORS.danger,
        background: UI_COLORS.dangerBg,
        icon: <CloseCircleOutlined />,
      };
    default:
      return {
        label: "Outcome unknown",
        color: UI_COLORS.warning,
        background: UI_COLORS.warningBg,
        icon: <QuestionCircleOutlined />,
      };
  }
}

function observedLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

export function agentMessageFromMarkdownFence({
  info,
  value,
}: {
  info: string;
  value: string;
}): AgentMessage | undefined {
  const [kind, agent_session_id, attempt_id, source, extra] = info
    .trim()
    .split(/\s+/);
  if (kind.toLowerCase() !== "agent-message" || extra !== undefined) return;
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    (agent_session_id !== undefined || attempt_id !== undefined) &&
    (!uuid.test(agent_session_id ?? "") || !uuid.test(attempt_id ?? ""))
  )
    return;
  let source_label: string | undefined;
  if (source !== undefined) {
    if (!source.startsWith("from=")) return;
    try {
      source_label = decodeURIComponent(source.slice(5)).trim();
    } catch {
      return;
    }
    if (!source_label || source_label.length > 120) return;
  }
  return {
    type: "agent-message",
    ...(agent_session_id && attempt_id ? { agent_session_id, attempt_id } : {}),
    ...(source_label ? { source_label } : {}),
    children: markdown_to_slate(value, true),
  };
}

export function AgentMessageElement({
  attributes,
  children,
  element,
}: RenderElementProps) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activity, setActivity] = useState<AgentSessionActivity>();
  const [error, setError] = useState("");
  if (element.type !== "agent-message")
    throw new Error("Expected agent-message element");
  const message = element as AgentMessage;
  const sourceLabel = message.source_label ?? "Agent";
  const inspectable = !!(message.agent_session_id && message.attempt_id);
  const outcome = activity ? outcomePresentation(activity) : undefined;
  async function inspect() {
    const next = !expanded;
    setExpanded(next);
    if (!next || activity || !inspectable) return;
    setLoading(true);
    setError("");
    try {
      const { personalAgentApi } = await import("@cocalc/frontend/agents/api");
      const result = await personalAgentApi().inspectAgentSessionAttempt({
        agent_session_id: message.agent_session_id!,
        attempt_id: message.attempt_id!,
      });
      if (!result)
        throw new Error("No retained operational evidence is available");
      setActivity(result);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }
  return (
    <section
      {...attributes}
      aria-label="Agent-message quote"
      className="cocalc-slate-agent-message"
      style={{
        margin: "6px 0",
        padding: "6px 8px",
        borderRadius: 9,
        background: UI_COLORS.surface,
        color: UI_COLORS.text,
        border: `1px solid ${UI_COLORS.border}`,
        display: "flex",
        alignItems: "center",
        gap: 7,
        flexWrap: "wrap",
      }}
    >
      <span
        contentEditable={false}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          color: UI_COLORS.info,
          fontSize: 13,
          fontWeight: 650,
          whiteSpace: "nowrap",
          flex: "0 0 auto",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            borderRadius: 999,
            color: UI_COLORS.info,
            background: UI_COLORS.infoBg,
          }}
        >
          <RobotOutlined />
        </span>
        {sourceLabel}:
      </span>
      <div
        className="cocalc-slate-agent-message-body"
        style={{
          flex: "1 1 240px",
          minWidth: 0,
          height: "1.5em",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          lineHeight: 1.5,
        }}
      >
        {children}
      </div>
      <button
        type="button"
        aria-label={expanded ? "Hide delivery details" : "Inspect delivery"}
        aria-expanded={expanded}
        title={expanded ? "Hide delivery details" : "Inspect delivery"}
        onClick={() => void inspect()}
        style={{
          appearance: "none",
          border: 0,
          borderRadius: 6,
          padding: 4,
          background: "transparent",
          color: UI_COLORS.secondary,
          cursor: "pointer",
          lineHeight: 1,
          flex: "0 0 auto",
        }}
      >
        <InfoCircleOutlined />
      </button>
      {expanded && (
        <div
          contentEditable={false}
          style={{
            flex: "1 0 100%",
            color: UI_COLORS.secondary,
            background: UI_COLORS.inset,
            borderRadius: 8,
            padding: "9px 10px",
            fontSize: 12,
          }}
        >
          {loading && <div role="status">Loading delivery details...</div>}
          {error && (
            <div role="alert">
              Delivery details are unavailable. This message remains editable
              project content.
              <details style={{ marginTop: 7 }}>
                <summary style={{ cursor: "pointer", color: UI_COLORS.info }}>
                  Error details
                </summary>
                <div style={{ marginTop: 4, overflowWrap: "anywhere" }}>
                  {error}
                </div>
              </details>
            </div>
          )}
          {activity && (
            <>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  flexWrap: "wrap",
                  marginBottom: 7,
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    borderRadius: 999,
                    padding: "3px 8px",
                    color: outcome!.color,
                    background: outcome!.background,
                    fontWeight: 600,
                  }}
                >
                  {outcome!.icon}
                  {outcome!.label}
                </span>
                <span>{deliveryLabel(activity)}</span>
                <span aria-hidden="true">·</span>
                <time dateTime={activity.observed_at}>
                  {observedLabel(activity.observed_at)}
                </time>
              </div>
              <div style={{ lineHeight: 1.45 }}>
                Operational evidence confirms admission, not task completion.
                The message text is editable project data.
              </div>
              <details style={{ marginTop: 8 }}>
                <summary style={{ cursor: "pointer", color: UI_COLORS.info }}>
                  Technical details
                </summary>
                <dl
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(90px, auto) minmax(0, 1fr)",
                    columnGap: 10,
                    rowGap: 3,
                    margin: "7px 0 0",
                    overflowWrap: "anywhere",
                  }}
                >
                  <dt>Session</dt>
                  <dd style={{ margin: 0 }}>{activity.agent_session_id}</dd>
                  <dt>Attempt</dt>
                  <dd style={{ margin: 0 }}>{activity.attempt_id}</dd>
                  <dt>Source</dt>
                  <dd style={{ margin: 0 }}>{activity.source_member_id}</dd>
                  <dt>Target</dt>
                  <dd style={{ margin: 0 }}>{activity.target_member_id}</dd>
                  <dt>Generation</dt>
                  <dd style={{ margin: 0 }}>{activity.session_generation}</dd>
                </dl>
              </details>
            </>
          )}
          {!inspectable && !loading && (
            <div>No authenticated delivery details are attached.</div>
          )}
        </div>
      )}
    </section>
  );
}

register({
  slateType: "agent-message",
  Element: AgentMessageElement,
  StaticElement: AgentMessageElement,
  fromSlate: ({ children, node }) => {
    const body = children.trimEnd();
    let fence = "```";
    while (body.includes(fence)) fence += "`";
    const info =
      node.agent_session_id && node.attempt_id
        ? `agent-message ${node.agent_session_id} ${node.attempt_id}${
            node.source_label
              ? ` from=${encodeURIComponent(node.source_label)}`
              : ""
          }`
        : "agent-message";
    return `${fence}${info}\n${body}\n${fence}\n\n`;
  },
});
