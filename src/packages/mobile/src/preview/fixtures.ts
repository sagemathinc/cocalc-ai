/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import type {
  ChatSnapshot,
  HeadlessChatClient,
  ProjectedChatMessage,
} from "@cocalc/chat-client";
import type { loadNamedAgentWorkspace } from "@cocalc/chat-client/named-agents";
import { normalizeAgentWorkspaceOrganization } from "@cocalc/chat-client/agent-organization";

// Both gates are required: a production bundle cannot enable local fixtures.
export const previewEnabled =
  typeof __DEV__ !== "undefined" &&
  __DEV__ &&
  process.env.EXPO_PUBLIC_MOBILE_PREVIEW === "1";
export const PREVIEW_PROFILE = "local-ui-preview";
export const isPreviewProfile = (profile: string) =>
  previewEnabled && profile === PREVIEW_PROFILE;
export type ConversationClient = Pick<
  HeadlessChatClient,
  | "open"
  | "close"
  | "subscribe"
  | "getSnapshot"
  | "interrupt"
  | "loadOlderMessages"
  | "sendToExistingCodexThread"
  | "sendGuidanceToCodexThread"
>;
type Workspace = Awaited<ReturnType<typeof loadNamedAgentWorkspace>>;
let workspace: Workspace | undefined;
export function previewWorkspace(): Workspace {
  if (!workspace)
    workspace = {
      directory: {
        enabled: true,
        agents: [
          "Research",
          "A very long agent name for investigating mathematical questions",
          "Writing",
          "Unavailable",
        ].map((name, index) => ({
          account_id: PREVIEW_PROFILE,
          name,
          endpoint: {
            agent_id: `preview-${index}`,
            project_id: "preview-project",
          },
          path: "preview.chat",
          thread_id: "preview-thread",
          project_title: "Mobile layout laboratory",
          description:
            "A realistic description that wraps over several lines on a narrow screen and at larger text sizes.",
          available: index !== 3,
          updated_at: "2026-09-21T12:00:00Z",
        })),
      },
      organization: normalizeAgentWorkspaceOrganization(undefined),
    };
  return workspace;
}
export function savePreviewOrganization(
  organization: Workspace["organization"],
) {
  workspace = { ...previewWorkspace(), organization };
}
export function createPreviewChat(): ConversationClient {
  let sequence = 0;
  const message = (
    role: ProjectedChatMessage["role"],
    content: string,
  ): ProjectedChatMessage => ({
    message_id: `preview-message-${sequence++}`,
    thread_id: "preview-thread",
    sender_id: role,
    role,
    content,
    date: "2026-09-21T12:00:00Z",
    generating: false,
    state: "complete",
  });
  let snapshot: ChatSnapshot = {
    revision: 1,
    connection: "connected",
    ready: true,
    project_id: "preview-project",
    path: "preview.chat",
    threads: [
      { thread_id: "preview-thread", agent_kind: "acp", state: "idle" },
    ],
    messages: [
      message(
        "human",
        "Please help me check this conversation on a small screen.",
      ),
      message(
        "agent",
        'This is local preview data. No account or running agent is connected.\n\nHere is a longer paragraph to check wrapping, selection, spacing, and scrolling. The conversation should remain readable while the keyboard is open.\n\n```python\nfor number in range(10):\n    print(number ** 2, "A longer code line to check wrapping on a narrow phone screen.")\n```\n\nAn inline `variable_name` and a [documentation link](https://cocalc.ai).',
      ),
      message("human", "Can I type and send a local message?"),
      message(
        "agent",
        "Yes. Send a message below to exercise the real composer. The response is deterministic and stays entirely on this device.",
      ),
    ],
    message_window: { limit: 30, loaded: 4, has_older: true, omitted: 1 },
  };
  const listeners = new Set<(snapshot: ChatSnapshot) => void>();
  const publish = () => {
    snapshot = { ...snapshot, revision: snapshot.revision + 1 };
    listeners.forEach((listener) => listener(snapshot));
  };
  const send: ConversationClient["sendToExistingCodexThread"] = async ({
    text,
    thread_id,
  }) => {
    const sent = message("human", text);
    const response = {
      ...message("agent", ""),
      parent_message_id: sent.message_id,
      generating: true,
      state: "running" as const,
      activity: {
        state: "ready" as const,
        events: [],
        markdown: "Checking the task and preparing the result…",
      },
    };
    snapshot = {
      ...snapshot,
      messages: [...snapshot.messages, sent, response],
    };
    snapshot = {
      ...snapshot,
      threads: [{ ...snapshot.threads[0], state: "running" }],
    };
    publish();
    setTimeout(() => {
      snapshot = {
        ...snapshot,
        threads: [{ ...snapshot.threads[0], state: "idle" }],
        messages: snapshot.messages.map((item) =>
          item.message_id === response.message_id
            ? {
                ...item,
                generating: false,
                state: "complete",
                activity: undefined,
                content:
                  'Preview reply: your message stayed on this device.\n\n## Result\n\n- **Reviewed** the task.\n- Ready for your next instruction.\n\nYou can leave and return to this conversation.\n\n```python\nprint("A long line of code that you can wrap to read comfortably on a narrow phone screen.")\n```\n\n| Check | Result |\n|:---|---:|\n| Passed | 42 |\n| Failed | 0 |',
              }
            : item,
        ),
      };
      publish();
    }, 8000);
    return { message_id: sent.message_id, thread_id };
  };
  return {
    open: async () => {},
    close: async () => {
      listeners.clear();
    },
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    sendToExistingCodexThread: send,
    sendGuidanceToCodexThread: send,
    interrupt: async () => {},
    loadOlderMessages: async () => {
      snapshot = {
        ...snapshot,
        messages: [
          message("agent", "Earlier preview message."),
          ...snapshot.messages,
        ],
        message_window: { limit: 60, loaded: 5, has_older: false, omitted: 0 },
      };
      publish();
    },
  };
}

let resumedChat: ConversationClient | undefined;
export function resumePreviewChat(): ConversationClient {
  return (resumedChat ??= createPreviewChat());
}
