import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { serializeComputerMention } from "@cocalc/util/computer-mentions";

const AGENT = { project_id: "p1", agent_id: "a1" };
const OTHER = { project_id: "p1", agent_id: "a2" };
const ID = "1a057860-889d-461a-9073-4b8c69d65123";

let mockComputers: any[] = [];
let mockDirectory: any;
const mockApi = {
  resolveIdentity: jest.fn(async () => ({ agent_id: AGENT.agent_id })),
  registerIdentity: jest.fn(),
  listAgentNetworks: jest.fn(async () => mockDirectory),
};

jest.mock("../account/use-computers", () => ({
  refreshComputers: async () => mockComputers,
}));
jest.mock("./api", () => ({
  personalAgentApi: () => mockApi,
  refreshAgentNetworks: jest.fn(),
  sameEndpoint: (a, b) =>
    a.project_id === b.project_id && a.agent_id === b.agent_id,
  useNamedAgents: () => ({ directory: { agents: [] } }),
}));
jest.mock("../account/computer-pairing", () => ({
  errorText: (err) => `${err}`,
  ReconnectComputer: () => <div>reconnect steps</div>,
}));

import { agentComputers, useComputerMentionCheck } from "./computer-access";

beforeEach(() => jest.clearAllMocks());

const network = (members: any[], state = "active") => ({
  agent_network_id: "n1",
  title: "xyz",
  state,
  members: members.map((endpoint) => ({ kind: "registered", endpoint })),
});
const m1 = (extra: object = {}) => ({
  computer_id: ID,
  name: "m1",
  hostname: "studio.local",
  machine_user: "sage",
  agent_network_id: "n1",
  connected: true,
  revoked_at: null,
  deadline: null,
  effective_policy: { duration: null },
  ...extra,
});
const directory = (n: any, paused = false) => ({
  networks: [n],
  controls: { paused },
});

test("an agent can use a computer when it's in the computer's active network", () => {
  const [item] = agentComputers(
    [m1()] as any,
    directory(network([AGENT])) as any,
    AGENT,
  );
  expect(item).toMatchObject({ state: "connected", canUse: true });
  expect(
    agentComputers([m1()] as any, directory(network([OTHER])) as any, AGENT)[0]
      .canUse,
  ).toBe(false);
  expect(
    agentComputers(
      [m1()] as any,
      directory(network([AGENT], "paused")) as any,
      AGENT,
    )[0].canUse,
  ).toBe(false);
  expect(
    agentComputers(
      [m1()] as any,
      directory(network([AGENT]), true) as any,
      AGENT,
    )[0].canUse,
  ).toBe(false);
});

function useCheck() {
  return useComputerMentionCheck({
    projectId: "p1",
    path: "a.chat",
    threadId: "t1",
    agentLabel: "@claude-1",
    enabled: true,
  });
}
const message = `disk on ${serializeComputerMention({ version: 1, computer_id: ID, name: "m1" })}?`;

test("sends at once when every mentioned computer is connected and usable", async () => {
  mockComputers = [m1()];
  mockDirectory = directory(network([AGENT]));
  const send = jest.fn();
  const { result } = renderHook(useCheck);
  await act(() => result.current.preflight(message, send));
  expect(send).toHaveBeenCalledTimes(1);
});

test("messages without computers, or in plain chats, are untouched", async () => {
  const send = jest.fn();
  const { result } = renderHook(useCheck);
  await act(() => result.current.preflight("no computers here", send));
  expect(send).toHaveBeenCalledTimes(1);
  expect(mockApi.listAgentNetworks).not.toHaveBeenCalled();
});

test("guides the fixes when the computer is offline and the agent can't use it; Send anyway still sends", async () => {
  mockComputers = [m1({ connected: false })];
  mockDirectory = directory(network([OTHER]));
  const send = jest.fn();
  const { result } = renderHook(useCheck);
  await act(() => result.current.preflight(message, send));
  expect(send).not.toHaveBeenCalled();
  render(<>{result.current.ui}</>);
  expect(
    screen.getByText("The computers in this message need attention"),
  ).toBeTruthy();
  expect(screen.getByText("Offline")).toBeTruthy();
  expect(screen.getByText("@claude-1 can't use it")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Reconnect…" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Give @claude-1 access…" }),
  ).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Send anyway" }));
  expect(send).toHaveBeenCalledTimes(1);
});
