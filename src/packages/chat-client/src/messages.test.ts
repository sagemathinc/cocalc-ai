/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import { projectChatRows } from "./messages";

describe("projectChatRows", () => {
  it("projects current revisions and authoritative thread state", () => {
    const result = projectChatRows(
      [
        {
          event: "chat-thread",
          sender_id: "__thread__",
          date: "2026-01-01T00:00:00.000Z",
          thread_id: "thread-1",
          root_message_id: "message-1",
        },
        {
          event: "chat-thread-config",
          sender_id: "__thread_config__:thread-1",
          date: "1970-01-01T00:00:00.000Z",
          thread_id: "thread-1",
          name: "Mobile thread",
          agent_kind: "acp",
          agent_model: "gpt-5.6-codex",
        },
        {
          event: "chat-thread-state",
          sender_id: "__thread_state__:thread-1",
          date: "1970-01-01T00:00:00.000Z",
          thread_id: "thread-1",
          state: "running",
          active_message_id: "message-2",
          updated_at: "2026-01-01T00:00:03.000Z",
        },
        {
          event: "chat",
          sender_id: "account-1",
          date: "2026-01-01T00:00:01.000Z",
          message_id: "message-1",
          thread_id: "thread-1",
          history: [
            {
              author_id: "account-1",
              content: "edited",
              date: "2026-01-01T00:00:02.000Z",
            },
            {
              author_id: "account-1",
              content: "original",
              date: "2026-01-01T00:00:01.000Z",
            },
          ],
        },
        {
          event: "chat",
          sender_id: "account-1",
          date: "2026-01-01T00:00:03.000Z",
          message_id: "message-2",
          thread_id: "thread-1",
          parent_message_id: "message-1",
          acp_account_id: "agent-account",
          acp_log_store: "acp-log/chat.chat",
          acp_log_key: "thread-1:message-2",
          acp_live_log_stream: "acp-live-log/chat.chat/thread-1/message-2",
          acp_live_preview_stream:
            "acp-preview-log/chat.chat/thread-1/message-2",
          generating: true,
          history: [
            {
              author_id: "agent-account",
              content: "working",
              date: "2026-01-01T00:00:03.000Z",
            },
          ],
        },
      ],
      "thread-1",
    );

    expect(result.threads[0]).toEqual(
      expect.objectContaining({
        thread_id: "thread-1",
        name: "Mobile thread",
        state: "running",
        active_message_id: "message-2",
      }),
    );
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].content).toBe("edited");
    expect(result.messages[1]).toEqual(
      expect.objectContaining({
        role: "agent",
        state: "running",
        acp_log_store: "acp-log/chat.chat",
        acp_log_key: "thread-1:message-2",
        acp_live_log_stream: "acp-live-log/chat.chat/thread-1/message-2",
        acp_live_preview_stream: "acp-preview-log/chat.chat/thread-1/message-2",
      }),
    );
  });
});
