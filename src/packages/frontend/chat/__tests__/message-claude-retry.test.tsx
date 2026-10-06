/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntlProvider } from "react-intl";
import Message from "../message";
import { resubmitAcpTurnAsNew } from "../acp-api";

jest.mock("../git-commit-drawer", () => ({ GitCommitDrawer: () => null }));
jest.mock("../acp-api", () => ({
  ...jest.requireActual("../acp-api"),
  resubmitAcpTurnAsNew: jest.fn(),
}));
jest.mock("../claude-sign-in-recovery", () => ({
  ...jest.requireActual("../claude-sign-in-recovery"),
  useClaudeSubscriptionCredentialId: () => "credential-1",
}));
jest.mock("../claude-subscription-connect", () => ({
  ClaudeSubscriptionConnect: ({ onConnected }) => (
    <button onClick={() => onConnected("credential-2")}>
      Reconnect Claude
    </button>
  ),
}));
jest.mock("../use-codex-log", () => ({
  useCodexLog: () => ({
    events: [],
    liveStatus: "connected",
    hasLogRef: false,
    loadState: "idle",
  }),
}));
jest.mock("../agent-message-status", () => ({
  AgentMessageStatus: () => null,
  AttachedSteerStatusList: () => null,
}));
jest.mock("@cocalc/frontend/editors/markdown-input/mentionable-users", () => ({
  useMentionableUsers: () => () => [],
}));

test.each(["rejected", "false"])(
  "Claude recovery displays a failed %s resubmit from Message inline",
  async (outcome) => {
    const resend = jest.mocked(resubmitAcpTurnAsNew);
    resend.mockReset();
    if (outcome === "rejected")
      resend.mockImplementation(() => {
        throw Error("offline");
      });
    else resend.mockReturnValue(false);
    const parent = {
      message_id: "user-1",
      thread_id: "thread-1",
      sender_id: "viewer",
      acp_state: "not-sent",
    };
    const message = {
      date: 2000,
      message_id: "assistant-1",
      parent_message_id: "user-1",
      thread_id: "thread-1",
      sender_id: "codex",
      acp_account_id: "codex",
      history: [{ content: "Failed to authenticate: OAuth session expired" }],
    };
    const actions = {
      isLanguageModelThread: () => "codex",
      getMessagesInThread: () => [],
      getMessageById: () => parent,
      getThreadMetadata: () => undefined,
      store: { get: () => undefined },
    } as any;
    render(
      <IntlProvider locale="en">
        <Message
          project_id="00000000-0000-4000-8000-000000000001"
          path="test.chat"
          index={0}
          actions={actions}
          message={message as any}
          messages={new Map([["2000", message]])}
          account_id="viewer"
          get_user_name={() => "Claude"}
          mode="standalone"
          is_thread_body={false}
          acpState="error"
        />
      </IntlProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Reconnect Claude" }));
    await user.click(screen.getByRole("button", { name: "Retry request" }));
    expect(
      await screen.findByText(
        "We couldn't retry this request. Please send it again.",
      ),
    ).toHaveAttribute("role", "alert");
    expect(resend).toHaveBeenCalledTimes(1);
    expect(resend).toHaveBeenCalledWith({
      actions,
      message: parent,
    });
  },
);
