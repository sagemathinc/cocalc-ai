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

test("finished agent messages show copy, read aloud and more as footer icons", async () => {
  renderTurn(false);
  const footer = screen.getByTestId("chat-message-actions");
  expect(
    within(footer).getByRole("button", { name: "Copy message" }),
  ).toBeVisible();
  expect(
    within(footer).getByRole("button", { name: "More message actions" }),
  ).toBeVisible();

  await userEvent.click(
    within(footer).getByRole("button", { name: "Read aloud" }),
  );
  expect(startChatSpeech).toHaveBeenCalledWith(
    expect.objectContaining({
      markdown: "All done.",
      messageId: "assistant-1",
      threadId: "thread-1",
    }),
  );

  // Footer icon actions are not repeated in the overflow menu.
  await userEvent.click(
    within(footer).getByRole("button", { name: "More message actions" }),
  );
  expect(await screen.findByText("Link to message")).toBeVisible();
  expect(screen.queryByText("Copy whole message")).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Read aloud" })).toBeNull();
});

test("no footer actions while the agent is still generating", () => {
  renderTurn(true);
  expect(screen.queryByRole("button", { name: "Read aloud" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();
});
