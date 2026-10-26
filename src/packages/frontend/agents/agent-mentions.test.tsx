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
  listAgentNetworks: jest.fn(),
};

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => account,
}));
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
jest.mock("./network-approval", () => ({
  NetworkApproval: ({ onClose }) => (
    <button onClick={() => onClose(false)}>Cancel network approval</button>
  ),
}));

function directory({ paused = false, active = true } = {}) {
  return {
    enabled: true,
    controls: { paused, generation: 0 },
    usage: {
      active_networks: active ? 1 : 0,
      network_limit: 100,
      member_limit: 8,
    },
    networks: active
      ? [
          {
            agent_network_id: "66666666-6666-4666-8666-666666666666",
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

function Composer({
  send,
  mention = reference,
}: {
  send: () => void;
  mention?: AgentMentionReference;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const flow = useAgentMentions({
    projectId: source.project_id,
    path: "/source.chat",
    threadId: "source",
    runnable: true,
    restoreFocus: () => input.current?.focus(),
  });
  const draft = `Ask ${serializeAgentMention(mention)} to review.`;
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
  api.listAgentNetworks.mockResolvedValue(directory());
});

test("an active complete-graph network permits exactly one send", async () => {
  const send = jest.fn();
  const user = userEvent.setup();
  render(<Composer send={send} />);
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(api.listAgentNetworks).toHaveBeenCalledWith({ limit: 100 });
});

test("missing network preserves the draft and opens explicit approval", async () => {
  api.listAgentNetworks.mockResolvedValue(directory({ active: false }));
  const send = jest.fn();
  const user = userEvent.setup();
  render(<Composer send={send} />);
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(
    await screen.findByRole("button", { name: "Cancel network approval" }),
  ).toBeTruthy();
  expect(
    (screen.getByRole("textbox", { name: "Draft" }) as HTMLTextAreaElement)
      .value,
  ).toContain("reviewer");
  expect(send).not.toHaveBeenCalled();
});

test("account-wide pause fails closed without opening approval", async () => {
  api.listAgentNetworks.mockResolvedValue(directory({ paused: true }));
  const send = jest.fn();
  const user = userEvent.setup();
  render(<Composer send={send} />);
  await user.click(screen.getByRole("button", { name: "Send" }));
  const alerts = await screen.findAllByRole("alert");
  expect(alerts.some((alert) => /paused/.test(alert.textContent ?? ""))).toBe(
    true,
  );
  expect(screen.queryByText("Cancel network approval")).toBeNull();
  expect(send).not.toHaveBeenCalled();
});

describe("an agent on another site", () => {
  const remote = {
    kind: "external" as const,
    account_id: "77777777-7777-4777-8777-777777777777",
    agent_id: "88888888-8888-4888-8888-888888888888",
    installation_id: "99999999-9999-4999-8999-999999999999",
  };
  const mention: AgentMentionReference = {
    version: 1,
    naming_account_id: account,
    target: remote,
    name: "ops0",
  };
  const networks = (state: string, withRemote = true) => ({
    ...directory(),
    networks: [
      {
        agent_network_id: "66666666-6666-4666-8666-666666666666",
        state,
        members: [
          { kind: "registered", endpoint: source },
          ...(withRemote
            ? [{ kind: "external", source: remote, label: "ops0 on alpha" }]
            : []),
        ],
      },
    ],
  });

  test("sends when an active network has both, without an identity lookup", async () => {
    api.listAgentNetworks.mockResolvedValue(networks("active"));
    const send = jest.fn();
    const user = userEvent.setup();
    render(<Composer send={send} mention={mention} />);
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(api.getIdentity).not.toHaveBeenCalled();
  });

  test.each([
    ["paused", networks("paused"), /paused or closed/],
    ["absent", networks("active", false), /not in an Agent Network/],
  ])(
    "a %s network keeps the draft and offers no approval",
    async (_label, value, message) => {
      api.listAgentNetworks.mockResolvedValue(value);
      const send = jest.fn();
      const user = userEvent.setup();
      render(<Composer send={send} mention={mention} />);
      await user.click(screen.getByRole("button", { name: "Send" }));
      const alerts = await screen.findAllByRole("alert");
      expect(
        alerts.some((alert) => message.test(alert.textContent ?? "")),
      ).toBe(true);
      expect(screen.queryByText("Cancel network approval")).toBeNull();
      expect(send).not.toHaveBeenCalled();
    },
  );
});
