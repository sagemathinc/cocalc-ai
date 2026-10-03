import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
  // JSDOM has no layout; rc-menu skips zero-size elements when moving focus.
  jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    width: 100,
    height: 20,
    top: 0,
    left: 0,
    right: 100,
    bottom: 20,
    toJSON: () => ({}),
  });
});

afterEach(() => jest.restoreAllMocks());

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
  await waitFor(() =>
    expect(
      screen.getByRole("menuitem", { name: "Link to message" }),
    ).toBeVisible(),
  );
  expect(screen.queryByText("Copy whole message")).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Read aloud" })).toBeNull();
});

test("no footer actions while the agent is still generating", () => {
  renderTurn(true);
  expect(screen.queryByRole("button", { name: "Read aloud" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();
});

test("footer actions support keyboard navigation and restore disclosure focus", async () => {
  localStorage.removeItem("cocalc-chat-speech-output-disclosed");
  const user = userEvent.setup();
  renderTurn(false);
  const footer = within(screen.getByTestId("chat-message-actions"));
  const copy = footer.getByRole("button", { name: "Copy message" });
  copy.focus();
  await user.tab();
  const readAloud = footer.getByRole("button", { name: "Read aloud" });
  expect(readAloud).toHaveFocus();
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog", {
    name: "Read this response aloud",
  });
  const confirm = within(dialog).getByRole("button", { name: "Read aloud" });
  await waitFor(() => expect(confirm).toHaveFocus());
  expect(startChatSpeech).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(readAloud).toHaveFocus());
  expect(startChatSpeech).not.toHaveBeenCalled();
  expect(
    localStorage.getItem("cocalc-chat-speech-output-disclosed"),
  ).toBeNull();

  await user.keyboard("{Enter}");
  const reopened = await screen.findByRole("dialog", {
    name: "Read this response aloud",
  });
  await waitFor(() =>
    expect(
      within(reopened).getByRole("button", { name: "Read aloud" }),
    ).toHaveFocus(),
  );
  await user.keyboard("{Enter}");
  await waitFor(() => expect(readAloud).toHaveFocus());
  expect(startChatSpeech).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem("cocalc-chat-speech-output-disclosed")).toBe(
    "yes",
  );

  await user.tab();
  const more = footer.getByRole("button", { name: "More message actions" });
  expect(more).toHaveFocus();
  await user.keyboard("{Enter}");
  const menu = await screen.findByRole("menu");
  await waitFor(() => expect(menu).toBeVisible());
  // rc-menu/dropdown use legacy keyCode/which, which user-event does not set.
  fireEvent.keyDown(more, { key: "Tab", keyCode: 9, which: 9 });
  await waitFor(() =>
    expect(within(menu).getByRole("menuitem", { name: "Info" })).toHaveFocus(),
  );
  fireEvent.keyDown(document.activeElement!, {
    key: "ArrowDown",
    keyCode: 40,
    which: 40,
  });
  await waitFor(() =>
    expect(
      within(menu).getByRole("menuitem", { name: "Link to message" }),
    ).toHaveFocus(),
  );
  fireEvent.keyDown(document.activeElement!, {
    key: "Escape",
    keyCode: 27,
    which: 27,
  });
  await waitFor(() => expect(more).toHaveFocus());
});
