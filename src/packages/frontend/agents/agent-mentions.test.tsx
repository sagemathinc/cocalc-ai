import { useRef } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { serializeAgentMention } from "@cocalc/util/agent-mentions";
import type { AgentMentionReference } from "@cocalc/util/agent-mentions";
import { useAgentMentions } from "./use-agent-mentions";

const account = "11111111-1111-4111-8111-111111111111";
const source = {
  project_id: "22222222-2222-4222-8222-222222222222",
  agent_id: "33333333-3333-4333-8333-333333333333",
};
const target = {
  project_id: "44444444-4444-4444-8444-444444444444",
  agent_id: "55555555-5555-4555-8555-555555555555",
};
const reference: AgentMentionReference = {
  version: 1,
  naming_account_id: account,
  target,
  name: "reviewer",
};
const agents = [
  {
    account_id: account,
    name: "builder",
    endpoint: source,
    path: "/source.chat",
    thread_id: "source",
    available: true,
    updated_at: new Date().toISOString(),
  },
  {
    account_id: account,
    name: "reviewer",
    endpoint: target,
    path: "/review.chat",
    thread_id: "review",
    available: true,
    updated_at: new Date().toISOString(),
  },
];
const api = {
  resolveIdentity: jest.fn(async () => ({ ...source, thread_id: "source" })),
  getIdentity: jest.fn(async () => ({ ...target, disabled_at: null })),
  registerIdentity: jest.fn(),
  listAgentSessions: jest.fn(),
};

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => account,
}));
jest.mock("./use-ui-preference", () => ({ useAgentMessagingUI: () => true }));
jest.mock("./api", () => ({
  personalAgentApi: () => api,
  sameEndpoint: (a, b) =>
    a.project_id === b.project_id && a.agent_id === b.agent_id,
  useNamedAgents: () => ({
    directory: { enabled: true, agents },
    loading: false,
  }),
}));
jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    freshAuthModalProps: {},
    runFreshAuthAction: async (fn) => {
      await fn();
      return true;
    },
  }),
}));
jest.mock("./session-approval", () => ({
  SessionApproval: ({ onClose }) => (
    <button onClick={() => onClose(false)}>Cancel session approval</button>
  ),
}));

function directory({ paused = false, active = true } = {}) {
  return {
    enabled: true,
    controls: { paused, generation: 0 },
    usage: {
      active_sessions: active ? 1 : 0,
      session_limit: 100,
      member_limit: 8,
    },
    sessions: active
      ? [
          {
            agent_session_id: "66666666-6666-4666-8666-666666666666",
            state: "active",
            members: [
              { kind: "registered", endpoint: source },
              { kind: "registered", endpoint: target },
            ],
          },
        ]
      : [],
  };
}

function Composer({ send }: { send: () => void }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const flow = useAgentMentions({
    projectId: source.project_id,
    path: "/source.chat",
    threadId: "source",
    runnable: true,
    restoreFocus: () => input.current?.focus(),
  });
  const draft = `Ask ${serializeAgentMention(reference)} to review.`;
  return (
    <>
      <textarea ref={input} defaultValue={draft} aria-label="Draft" />
      <button onClick={() => void flow.preflight(draft, send)}>Send</button>
      {flow.ui}
    </>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  api.listAgentSessions.mockResolvedValue(directory());
});

test("an active complete-graph session permits exactly one send", async () => {
  const send = jest.fn();
  const user = userEvent.setup();
  render(<Composer send={send} />);
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(api.listAgentSessions).toHaveBeenCalledWith({ limit: 100 });
});

test("missing session preserves the draft and opens explicit approval", async () => {
  api.listAgentSessions.mockResolvedValue(directory({ active: false }));
  const send = jest.fn();
  const user = userEvent.setup();
  render(<Composer send={send} />);
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(
    await screen.findByRole("button", { name: "Cancel session approval" }),
  ).toBeTruthy();
  expect(
    (screen.getByRole("textbox", { name: "Draft" }) as HTMLTextAreaElement)
      .value,
  ).toContain("reviewer");
  expect(send).not.toHaveBeenCalled();
});

test("account-wide pause fails closed without opening approval", async () => {
  api.listAgentSessions.mockResolvedValue(directory({ paused: true }));
  const send = jest.fn();
  const user = userEvent.setup();
  render(<Composer send={send} />);
  await user.click(screen.getByRole("button", { name: "Send" }));
  const alerts = await screen.findAllByRole("alert");
  expect(alerts.some((alert) => /paused/.test(alert.textContent ?? ""))).toBe(
    true,
  );
  expect(screen.queryByText("Cancel session approval")).toBeNull();
  expect(send).not.toHaveBeenCalled();
});
