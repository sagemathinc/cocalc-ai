/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  createRemoteHeadlessChatClient,
  type HeadlessChatClient,
  type ProjectedChatMessage,
} from "@cocalc/chat-client";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { useEffect, useState } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { Spin, Typography } from "antd";

const { Paragraph, Text } = Typography;
const PREVIEW_MESSAGE_LIMIT = 5;
const PREVIEW_CHARACTER_LIMIT = 1_000;

export function selectedPreviewMessages(
  messages: ProjectedChatMessage[],
  threadId: string,
): ProjectedChatMessage[] {
  return messages
    .filter(({ thread_id, content }) => thread_id === threadId && !!content)
    .slice(-PREVIEW_MESSAGE_LIMIT);
}

function previewText(content: string): string {
  if (content.length <= PREVIEW_CHARACTER_LIMIT) return content;
  return `${content.slice(0, PREVIEW_CHARACTER_LIMIT).trimEnd()}...`;
}

export function AgentLoadingPreview({
  accountId,
  agent,
}: {
  accountId?: string;
  agent: NamedAgent;
}) {
  const [messages, setMessages] = useState<ProjectedChatMessage[]>([]);

  useEffect(() => {
    let disposed = false;
    let client: HeadlessChatClient | undefined;
    let unsubscribe: (() => void) | undefined;
    setMessages([]);
    if (!accountId) return;
    void (async () => {
      const projectHostClient = await webapp_client.conat_client.projectConat({
        project_id: agent.endpoint.project_id,
        caller: "AgentLoadingPreview",
        requireRouting: true,
      });
      if (disposed) return;
      client = createRemoteHeadlessChatClient({
        account_id: accountId,
        project_id: agent.endpoint.project_id,
        path: agent.path,
        projectHostClient,
        selected_thread_id: agent.thread_id,
        initial_message_limit: PREVIEW_MESSAGE_LIMIT,
        readyTimeoutMs: 10_000,
      });
      unsubscribe = client.subscribe((snapshot) => {
        if (disposed || !snapshot.ready) return;
        setMessages(
          selectedPreviewMessages(snapshot.messages, agent.thread_id),
        );
      });
      await client.open();
    })().catch(() => {
      // This is a best-effort first-paint optimization. The full editor below
      // remains authoritative and reports actionable loading errors.
    });
    return () => {
      disposed = true;
      unsubscribe?.();
      void client?.close().catch(() => undefined);
    };
  }, [accountId, agent.endpoint.project_id, agent.path, agent.thread_id]);

  return (
    <div
      aria-label="Recent conversation preview"
      style={{
        height: "100%",
        overflow: "auto",
        padding: "32px max(24px, 10%)",
      }}
    >
      <div style={{ alignItems: "center", display: "flex", gap: 10 }}>
        <Spin size="small" />
        <Text type="secondary">Loading full conversation...</Text>
      </div>
      {messages.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <Text type="secondary">Recent messages</Text>
          {messages.map((message) => (
            <div
              key={message.message_id}
              style={{
                background:
                  message.role === "human"
                    ? UI_COLORS.inset
                    : UI_COLORS.surface,
                border: `1px solid ${UI_COLORS.border}`,
                borderRadius: 8,
                marginTop: 10,
                padding: "10px 12px",
              }}
            >
              <Text strong>{message.role === "human" ? "You" : "Agent"}</Text>
              <Paragraph
                ellipsis={{ rows: 5 }}
                style={{ margin: "4px 0 0", whiteSpace: "pre-wrap" }}
              >
                {previewText(message.content)}
              </Paragraph>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
