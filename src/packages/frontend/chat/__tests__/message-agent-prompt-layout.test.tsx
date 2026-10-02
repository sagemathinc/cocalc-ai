import { render, within } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import Message from "../message";

jest.mock("../use-codex-log", () => ({
  useCodexLog: () => ({
    events: [],
    liveStatus: "idle",
    hasLogRef: false,
    loadState: "idle",
    deleteLog: jest.fn(),
  }),
}));
jest.mock("../agent-message-status", () => ({
  AgentMessageStatus: () => null,
  AttachedSteerStatusList: () => null,
}));
jest.mock("@cocalc/frontend/editors/markdown-input/mentionable-users", () => ({
  useMentionableUsers: () => () => [],
}));

function renderPrompt(message: any, threadModel: string | undefined) {
  const actions = {
    isLanguageModelThread: () => threadModel,
    getMessagesInThread: () => [],
    getMessageById: () => undefined,
    getThreadMetadata: () => undefined,
    store: { get: () => undefined },
  } as any;
  const { container } = render(
    <IntlProvider locale="en">
      <Message
        index={0}
        actions={actions}
        message={message}
        messages={new Map([[`${message.date}`, message]]) as any}
        account_id="viewer"
        get_user_name={() => "Viewer"}
        mode="standalone"
        is_thread_body={false}
      />
    </IntlProvider>,
  );
  return container.querySelector(".smc-chat-message") as HTMLElement;
}

const ownPrompt = {
  date: 1000,
  message_id: "prompt-1",
  thread_id: "thread-1",
  sender_id: "viewer",
  history: [{ content: "Run the tests", author_id: "viewer" }],
};

// Agent-network messages are stored under the target's human principal.
const agentPrompt = {
  ...ownPrompt,
  message_id: "network-1",
  agent_rpc: {
    source: { agent_id: "agent-1", project_id: "peer-project" },
    source_label: "@claude",
  },
  agent_rpc_launch: { state: "accepted", updated_at: 1001 },
  history: [{ content: "NETWORK_PONG", author_id: "viewer" }],
};

test("a message from another agent sits in the prompt position of an agent thread", () => {
  const own = renderPrompt(ownPrompt, "codex");
  const fromAgent = renderPrompt(agentPrompt, "codex");
  expect(own.style.marginLeft).not.toBe("");
  expect(fromAgent.style.marginLeft).toBe(own.style.marginLeft);
  expect(fromAgent.style.background).toBe(own.style.background);
  expect(fromAgent.style.marginTop).toBe(own.style.marginTop);
  // It is not presented as the viewer's own message.
  expect(fromAgent.className).not.toContain("smc-message-from-viewer");
  // PR #792's reply footer must not appear on PR #794's network prompts.
  expect(
    within(fromAgent).queryByRole("button", { name: "Copy message" }),
  ).toBeNull();
  expect(
    within(fromAgent).queryByRole("button", { name: "Read aloud" }),
  ).toBeNull();
});

test("agent messages outside agent threads keep the ordinary layout", () => {
  const fromAgent = renderPrompt(agentPrompt, undefined);
  expect(fromAgent.style.marginLeft).toBe("");
});
