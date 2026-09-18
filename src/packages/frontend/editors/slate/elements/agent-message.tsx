/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

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
}

export function agentMessageFromMarkdownFence({
  info,
  value,
}: {
  info: string;
  value: string;
}): AgentMessage | undefined {
  const [kind, agent_session_id, attempt_id, extra] = info.trim().split(/\s+/);
  if (kind.toLowerCase() !== "agent-message" || extra !== undefined) return;
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    (agent_session_id !== undefined || attempt_id !== undefined) &&
    (!uuid.test(agent_session_id ?? "") || !uuid.test(attempt_id ?? ""))
  )
    return;
  return {
    type: "agent-message",
    ...(agent_session_id && attempt_id ? { agent_session_id, attempt_id } : {}),
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
  const inspectable = !!(message.agent_session_id && message.attempt_id);
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
        padding: "8px 10px 10px",
        borderRadius: 10,
        background: UI_COLORS.inset,
        color: UI_COLORS.text,
        border: `1px solid ${UI_COLORS.border}`,
        borderLeft: `4px solid ${UI_COLORS.info}`,
      }}
    >
      <button
        type="button"
        contentEditable={false}
        aria-expanded={expanded}
        onClick={() => void inspect()}
        style={{
          appearance: "none",
          border: 0,
          padding: 0,
          background: "transparent",
          color: UI_COLORS.info,
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        Agent-message quote {expanded ? "(hide details)" : "(inspect)"}
      </button>
      {expanded && (
        <div contentEditable={false} style={{ color: UI_COLORS.secondary }}>
          <p>
            This content is editable project data. A quote does not prove
            sender, delivery, session membership, or authorization.
          </p>
          {loading && <p role="status">Loading operational evidence...</p>}
          {error && <p role="alert">{error}</p>}
          {activity && (
            <dl style={{ margin: "4px 0", fontSize: 12 }}>
              <dt>Session</dt>
              <dd>{activity.agent_session_id}</dd>
              <dt>Attempt</dt>
              <dd>{activity.attempt_id}</dd>
              <dt>Source member</dt>
              <dd>{activity.source_member_id}</dd>
              <dt>Target member</dt>
              <dd>{activity.target_member_id}</dd>
              <dt>Operational outcome</dt>
              <dd>{activity.outcome ?? "not observed"}</dd>
              <dt>Delivery</dt>
              <dd>
                {activity.effective_delivery ?? activity.configured_delivery}
              </dd>
              <dt>Observed</dt>
              <dd>{activity.observed_at}</dd>
              <dt>Session generation</dt>
              <dd>{activity.session_generation}</dd>
            </dl>
          )}
          {!inspectable && !loading && (
            <p>No authenticated correlation metadata is attached.</p>
          )}
        </div>
      )}
      <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>{children}</div>
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
        ? `agent-message ${node.agent_session_id} ${node.attempt_id}`
        : "agent-message";
    return `${fence}${info}\n${body}\n${fence}\n\n`;
  },
});
