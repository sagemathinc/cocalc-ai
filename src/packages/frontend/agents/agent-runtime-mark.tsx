/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// A small mark on an agent's badge saying which runtime it uses: OpenAI for
// Codex, Anthropic for Claude Code, a plug for any other ACP harness.

import type { ReactNode } from "react";
import { Icon } from "@cocalc/frontend/components";
import AnthropicAvatar from "@cocalc/frontend/components/anthropic-avatar";
import OpenAIAvatar from "@cocalc/frontend/components/openai-avatar";
import {
  agentRuntimeLabel,
  type AgentRuntimeSummary,
} from "@cocalc/util/ai/agent-runtime-kind";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

export function AgentRuntimeIcon({
  runtime,
  size = 14,
}: {
  runtime: AgentRuntimeSummary;
  size?: number;
}) {
  if (runtime.kind === "codex") return <OpenAIAvatar size={size} />;
  if (runtime.kind === "claude-code") return <AnthropicAvatar size={size} />;
  return (
    <Icon name="api" style={{ fontSize: size, color: UI_COLORS.secondary }} />
  );
}

/** The badge with the runtime's mark in its lower-right corner. */
export function WithAgentRuntimeMark({
  runtime,
  children,
}: {
  runtime?: AgentRuntimeSummary;
  children: ReactNode;
}) {
  if (!runtime) return <>{children}</>;
  const label = agentRuntimeLabel(runtime);
  return (
    <span
      style={{ position: "relative", display: "inline-flex", flex: "0 0 auto" }}
    >
      {children}
      <span
        role="img"
        aria-label={label}
        title={label}
        style={{
          position: "absolute",
          right: -4,
          bottom: -4,
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: UI_COLORS.surface,
          border: `1px solid ${UI_COLORS.border}`,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          lineHeight: 0,
        }}
      >
        <AgentRuntimeIcon runtime={runtime} size={12} />
      </span>
    </span>
  );
}
