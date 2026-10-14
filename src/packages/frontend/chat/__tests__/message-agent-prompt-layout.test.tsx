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
jest.mock("../git-commit-drawer", () => ({
  GitCommitDrawer: () => null,
}));
jest.mock("@cocalc/frontend/editors/markdown-input/mentionable-users", () => ({
  useMentionableUsers: () => () => [],
}));

function renderPrompt(
  message: any,
  threadModel: string | undefined,
  extra: { acpState?: string; byId?: Record<string, any> } = {},
) {
  const actions = {
    isLanguageModelThread: () => threadModel,
    getMessagesInThread: () => [],
    getMessageById: (id: string) => extra.byId?.[id],
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
        acpState={extra.acpState}
        {...(extra.acpState || extra.byId
          ? {
              project_id: "11111111-1111-4111-8111-111111111111",
              path: "agent.chat",
            }
          : {})}
      />
    </IntlProvider>,
  );
  const element = container.querySelector(".smc-chat-message") as HTMLElement;
  // The turn's status sits beside the message, not in it.
  return extra.acpState || extra.byId ? container : element;
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

// A sensor's wake is stored under the approving person, like agent messages.
const sensorWake = {
  ...ownPrompt,
  message_id: "wake-1",
  sensor_wake: {
    sensor_id: "7cceef51-07a4-44b4-887f-c2332cae59a6",
    run_id: "run-1",
    title: "CI on sagebrush",
  },
  history: [
    {
      content: [
        '[Sensor wake] "CI on sagebrush" (sensor 7cceef51-07a4-44b4-887f-c2332cae59a6) ran at 2026-10-12T02:36:12Z.',
        "This is not a message from a person.",
        "Summary: CI passed",
        "Data:",
        "```json",
        '{"exit_code": 0}',
        "```",
        "[/Sensor wake] Manage this sensor with `cocalc sensor show 7cceef51-07a4-44b4-887f-c2332cae59a6`.",
      ].join("\n"),
      author_id: "viewer",
    },
  ],
};

test("a sensor wake is a one-line card in the prompt position, not the viewer's own message", () => {
  const own = renderPrompt(ownPrompt, "codex");
  const wake = renderPrompt(sensorWake, "codex");
  expect(wake.className).not.toContain("smc-message-from-viewer");
  expect(wake.style.marginLeft).toBe(own.style.marginLeft);
  expect(within(wake).getByText(/Sensor · CI on sagebrush/)).toBeTruthy();
  expect(within(wake).getByText("CI passed")).toBeTruthy();
  expect(within(wake).getByRole("button", { name: "Read wake" })).toBeTruthy();
});

test("a wake keeps its turn's status and Cancel, but cannot be edited, steered or resent", () => {
  const queued = renderPrompt(sensorWake, "codex", { acpState: "queue" });
  expect(within(queued).getByText("queued")).toBeTruthy();
  expect(within(queued).getByRole("button", { name: "Cancel" })).toBeTruthy();
  expect(within(queued).queryByRole("button", { name: "Edit" })).toBeNull();
  expect(within(queued).queryByRole("button", { name: "Steer" })).toBeNull();
  // Control: the person's own queued message can be edited.
  const own = renderPrompt(ownPrompt, "codex", { acpState: "queue" });
  expect(within(own).getByRole("button", { name: "Edit" })).toBeTruthy();

  const notSent = renderPrompt(sensorWake, "codex", { acpState: "not-sent" });
  expect(within(notSent).getByText("not sent")).toBeTruthy();
  expect(
    within(notSent).queryByRole("button", { name: "Submit again" }),
  ).toBeNull();
});

test("an agent's error reply to a wake does not offer to resubmit the wake", () => {
  const reply = (parent: any) => ({
    date: 2000,
    message_id: "reply-1",
    thread_id: "thread-1",
    parent_message_id: parent.message_id,
    sender_id: "openai-codex-agent",
    acp_state: "error",
    history: [{ content: "The turn failed.", author_id: "openai-codex-agent" }],
  });
  const asParent = (m: any) => ({ ...m, acp_state: "not-sent" });
  // Control: an error reply to the person's own prompt offers Resubmit.
  const own = renderPrompt(reply(ownPrompt), "codex", {
    byId: { [ownPrompt.message_id]: asParent(ownPrompt) },
  });
  expect(
    within(own).queryByRole("button", { name: /Resubmit to Agent/ }),
  ).toBeTruthy();
  const wake = renderPrompt(reply(sensorWake), "codex", {
    byId: { [sensorWake.message_id]: asParent(sensorWake) },
  });
  expect(
    within(wake).queryByRole("button", { name: /Resubmit to Agent/ }),
  ).toBeNull();
});
