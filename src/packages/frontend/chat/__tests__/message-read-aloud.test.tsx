import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntlProvider } from "react-intl";
import Message from "../message";
import { startChatSpeech } from "../audio/chat-speech-player";

jest.mock("../audio/chat-speech-player", () => ({
  ...jest.requireActual("../audio/chat-speech-player"),
  startChatSpeech: jest.fn(async () => undefined),
}));
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

const actions = {
  isLanguageModelThread: () => "codex",
  getMessagesInThread: () => [],
  getMessageById: () => undefined,
  getThreadMetadata: () => undefined,
  store: { get: () => undefined },
} as any;

function renderTurn(generating: boolean) {
  const message = {
    date: 2000,
    message_id: "assistant-1",
    thread_id: "thread-1",
    sender_id: "codex",
    acp_account_id: "codex",
    generating,
    history: [{ content: generating ? ":robot: Thinking..." : "All done." }],
  };
  return render(
    <IntlProvider locale="en">
      <Message
        index={0}
        actions={actions}
        message={message as any}
        messages={new Map([["2000", message]]) as any}
        account_id="viewer"
        get_user_name={() => "Codex"}
        mode="standalone"
        is_thread_body={false}
      />
    </IntlProvider>,
  );
}

beforeEach(() => {
  localStorage.setItem("cocalc-chat-speech-output-disclosed", "yes");
  jest.mocked(startChatSpeech).mockClear();
});

test("agent message footer has no speaker button; read aloud is in the menu", async () => {
  renderTurn(false);
  const footer = screen.getByTestId("chat-message-actions");
  expect(
    within(footer).queryByRole("button", { name: "Read this response aloud" }),
  ).toBeNull();

  await userEvent.click(
    within(footer).getByRole("button", { name: "More message actions" }),
  );
  await userEvent.click(await screen.findByText("Read aloud"));
  expect(startChatSpeech).toHaveBeenCalledWith(
    expect.objectContaining({
      markdown: "All done.",
      messageId: "assistant-1",
      threadId: "thread-1",
    }),
  );
});

test("read aloud is not offered while the agent is still generating", async () => {
  renderTurn(true);
  const more = screen.queryByRole("button", { name: "More message actions" });
  if (more) {
    await userEvent.click(more);
  }
  expect(screen.queryByText("Read aloud")).toBeNull();
});
