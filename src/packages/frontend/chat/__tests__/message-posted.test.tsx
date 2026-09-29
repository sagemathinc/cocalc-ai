import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import Message from "../message";

jest.mock("../use-codex-log", () => ({
  useCodexLog: () => ({
    events: undefined,
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
jest.mock("../git-commit-drawer", () => ({ GitCommitDrawer: () => null }));
jest.mock("../input", () => ({ __esModule: true, default: () => null }));
jest.mock("@cocalc/frontend/editors/markdown-input/mentionable-users", () => ({
  useMentionableUsers: () => () => [],
}));

function renderPosted(extra: Record<string, unknown> = {}) {
  const message = {
    date: 3000,
    message_id: "posted-1",
    thread_id: "thread-1",
    sender_id: "viewer",
    post_only: true,
    history: [{ content: "a note for later", author_id: "viewer" }],
    ...extra,
  };
  const actions = {
    isLanguageModelThread: () => "codex",
    getMessagesInThread: () => [],
    getMessageById: () => undefined,
    getThreadMetadata: () => undefined,
    store: { get: () => undefined },
    setEditing: jest.fn(),
    sendChat: jest.fn(() => true),
    deleteMessage: jest.fn(() => true),
    save_to_disk: jest.fn(async () => {}),
    syncdb: {
      save: jest.fn(async () => {}),
      get_one: () => undefined,
      get: () => [],
      on: jest.fn(),
      removeListener: jest.fn(),
    },
  } as any;
  render(
    <IntlProvider locale="en">
      <Message
        project_id="11111111-1111-4111-8111-111111111111"
        path="a.chat"
        index={0}
        actions={actions}
        message={message as any}
        messages={new Map([["3000", message]])}
        account_id="viewer"
        get_user_name={() => "Viewer"}
        mode="standalone"
        is_thread_body={false}
      />
    </IntlProvider>,
  );
  return actions;
}

test("a posted message offers Edit and Send like a queued one", async () => {
  const actions = renderPosted();
  expect(screen.getByText("posted")).toBeTruthy();
  expect(screen.queryByText(/Not sent to agent/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(actions.setEditing).toHaveBeenCalledWith(
    expect.objectContaining({ message_id: "posted-1" }),
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(actions.sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        input: "a note for later",
        reply_thread_id: "thread-1",
      }),
    ),
  );
  await waitFor(() => expect(actions.deleteMessage).toHaveBeenCalled());
});

test("a delivered post keeps its receipt instead of send controls", () => {
  renderPosted({ acp_guidance_delivered_at_ms: 5000 });
  expect(screen.getByText("Received by agent")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
});

test("while editing, a posted message keeps its tag without actions", () => {
  renderPosted({ editing: ["viewer"] });
  expect(screen.getByText("posted")).toBeTruthy();
  expect(screen.queryByText(/Not sent to agent/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
});
