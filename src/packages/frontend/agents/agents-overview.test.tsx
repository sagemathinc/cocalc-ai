/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import type { ProjectAgent } from "@cocalc/util/people";
import { AgentsOverview, filterAgents, sortAgents } from "./agents-overview";
import { WithAgentRuntimeMark } from "./agent-runtime-mark";

const bob = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const project = "11111111-1111-4111-8111-111111111111";
const listAgents = jest.fn();
const setOrder = jest.fn();
let order: string[] = [];

jest.mock("@cocalc/frontend/app-framework", () => {
  const { Map } = require("immutable");
  return {
    redux: { getActions: () => ({ setState: jest.fn() }) },
    useTypedRedux: (store: string, field: string) =>
      store === "projects" && field === "project_map"
        ? Map({ [project]: Map({ title: "Research" }) })
        : store === "users" && field === "user_map"
          ? Map({ [bob]: Map({ first_name: "Bob", last_name: "Lee" }) })
          : undefined,
  };
});
jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  TimeAgo: () => null,
}));
jest.mock("@cocalc/frontend/people/api", () => ({
  peopleApi: () => ({ listAgents: (...a) => listAgents(...a) }),
}));
const SUB_A = "aaaaaaaa-0000-4000-8000-000000000001";
const SUB_B = "aaaaaaaa-0000-4000-8000-000000000002";
const listPaymentSelections = jest.fn();
const setPaymentSelections = jest.fn(async () => ({ updated: 1 }));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        agent: {
          listPaymentSelections: (...a) => listPaymentSelections(...a),
          setPaymentSelections: (...a) => setPaymentSelections(...a),
          getPaymentSelections: async () => ({ selections: [], defaults: {} }),
          copyPaymentSelection: async () => ({ copied: false }),
        },
        system: {
          getCodexPaymentSource: async () => ({
            subscriptions: [
              { id: SUB_A, label: "Work", isDefault: true },
              { id: SUB_B, label: "Personal" },
            ],
          }),
          listExternalCredentials: async () => [],
        },
      },
    },
  },
}));
jest.mock("@cocalc/frontend/components/use-collection-preferences", () => ({
  useCollectionPreferences: () => ({
    value: { view: "list", order },
    setView: jest.fn(),
    setOrder: (...a) => setOrder(...a),
  }),
}));

function agent(id: string, name: string, extra = {}): NamedAgent {
  return {
    account_id: "me",
    name,
    endpoint: { project_id: project, agent_id: id } as any,
    path: `/home/user/${name}.chat`,
    thread_id: `t-${id}`,
    available: true,
    updated_at: "2026-09-01T00:00:00Z",
    ...extra,
  };
}

const mine = [
  agent("a1", "alpha", { runtime: { kind: "codex" } }),
  agent("a2", "beta", { runtime: { kind: "claude-code" } }),
  agent("a3", "gamma", { runtime: { kind: "acp", name: "pi" } }),
];
jest.mock("@cocalc/frontend/chat/claude-subscription-connect", () => ({
  ClaudeSubscriptionConnect: () => <button>Connect Claude</button>,
}));
jest.mock("@cocalc/frontend/account/codex-credentials-panel", () => ({
  CodexCredentialsPanel: () => <div>ChatGPT plans</div>,
}));
const shared: ProjectAgent[] = [
  {
    agent_id: "s1",
    project_id: project,
    name: "bobs-helper",
    path: "/home/user/h.chat",
    thread_id: "t",
    created_by: bob,
    created_at: 1000,
    collaborator_access: "view",
    appearance: { name: "Bob's Helper", thread_color: "#123456" },
    runtime: { kind: "claude-code" },
  },
];

function props(extra = {}) {
  return {
    active: true,
    mine,
    minePins: ["a2"],
    hiddenIds: ["a3"],
    lastOpened: {},
    agentTitle: (a: NamedAgent) => a.name,
    renderBadge: () => null,
    mineActions: () => [],
    onPinMine: jest.fn(),
    onMoveMine: jest.fn(),
    onOpenMine: jest.fn(),
    onSetHidden: jest.fn(),
    onRemove: jest.fn(),
    ...extra,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  order = [];
  listAgents.mockResolvedValue({ agents: shared, unavailable_bays: 0 });
  listPaymentSelections.mockResolvedValue({
    selections: [
      {
        project_id: project,
        thread_id: "t-a1",
        provider: "codex",
        selection: {
          version: 1,
          provider: "codex",
          mode: "credential",
          credential_id: SUB_B,
        },
        updated_at: "2026-10-01T00:00:00Z",
      },
    ],
    defaults: {},
  });
});

it("shows how each agent is paid", async () => {
  render(<AgentsOverview {...props()} />);
  expect(
    await screen.findByRole("button", { name: "Open @alpha" }),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Open @alpha" }),
    ).toHaveTextContent("ChatGPT: Personal"),
  );
  expect(screen.getByRole("button", { name: "Open @beta" })).toHaveTextContent(
    "Paid with your default",
  );
  // A generic ACP harness has nothing per-account to pay with.
  expect(screen.getByRole("button", { name: "Open @gamma" })).toHaveTextContent(
    "Project-managed credentials",
  );
});

it("marks each agent's runtime on its badge", async () => {
  // Your own agents' badges come from renderBadge (the sidebar's badge,
  // which carries the mark); shared agents are marked here.
  const user = userEvent.setup();
  render(<AgentsOverview {...props()} />);
  await user.click(screen.getByRole("tab", { name: /Shared with me/ }));
  expect(
    await screen.findByRole("img", { name: "Claude Code" }),
  ).toBeInTheDocument();
  render(
    <>
      {[{ kind: "codex" }, { kind: "acp", name: "pi" }].map((runtime: any) => (
        <WithAgentRuntimeMark key={runtime.kind} runtime={runtime}>
          <span />
        </WithAgentRuntimeMark>
      ))}
    </>,
  );
  expect(screen.getByRole("img", { name: "Codex" })).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "ACP: pi" })).toBeInTheDocument();
});

it("offers only the choices that apply to the selected agents", async () => {
  const user = userEvent.setup();
  render(<AgentsOverview {...props()} />);
  // Project-managed only: nothing to set.
  await user.click(screen.getByRole("checkbox", { name: "Select @gamma" }));
  expect(
    screen.getByRole("button", { name: "Set payment method…" }),
  ).toBeDisabled();
  // A Claude Code agent with no Claude credential: connect right here.
  await user.click(screen.getByRole("checkbox", { name: "Select @beta" }));
  await user.click(screen.getByRole("button", { name: "Set payment method…" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(/1 Claude Code agent/)).toBeInTheDocument();
  expect(
    within(dialog).getByRole("button", { name: "Connect Claude" }),
  ).toBeInTheDocument();
  expect(within(dialog).queryByText(/ChatGPT subscription/)).toBeNull();
  expect(
    within(dialog).getByText(/1 agent uses project-managed/),
  ).toBeInTheDocument();
});

it("bulk operations act on the selected agents", async () => {
  const p = props();
  const user = userEvent.setup();
  render(<AgentsOverview {...p} />);
  expect(screen.queryByRole("toolbar", { name: "Selected agents" })).toBeNull();
  await user.click(screen.getByRole("checkbox", { name: "Select @alpha" }));
  await user.click(screen.getByRole("checkbox", { name: "Select @gamma" }));
  const toolbar = screen.getByRole("toolbar", { name: "Selected agents" });
  await user.click(
    within(toolbar).getByRole("button", { name: "Hide from sidebar" }),
  );
  expect(p.onSetHidden).toHaveBeenCalledWith(["a1", "a3"], true);
  await user.click(within(toolbar).getByRole("button", { name: "Remove…" }));
  expect(p.onRemove).toHaveBeenCalledWith([mine[0], mine[2]]);
  await user.click(screen.getByRole("checkbox", { name: "Select all agents" }));
  expect(screen.getByText(/3 selected/)).toBeInTheDocument();
});

it("sets the payment method for every selected agent at once", async () => {
  const user = userEvent.setup();
  render(<AgentsOverview {...props()} />);
  await user.click(screen.getByRole("checkbox", { name: "Select all agents" }));
  await user.click(screen.getByRole("button", { name: "Set payment method…" }));
  const dialog = await screen.findByRole("dialog");
  await user.click(
    within(dialog).getByRole("combobox", {
      name: "ChatGPT subscription for selected agents",
    }),
  );
  await user.click(await screen.findByTitle("Personal"));
  await user.click(within(dialog).getByRole("button", { name: "Apply" }));
  await waitFor(() => expect(setPaymentSelections).toHaveBeenCalledTimes(1));
  // Only the Codex agent takes a ChatGPT subscription.
  expect(setPaymentSelections).toHaveBeenCalledWith({
    targets: [
      {
        project_id: project,
        thread_id: mine[0].thread_id,
        path: mine[0].path,
        title: mine[0].name,
      },
    ],
    selection: {
      version: 1,
      provider: "codex",
      mode: "credential",
      credential_id: SUB_B,
    },
  });
});

it("shows the sidebar's pins in their own section, and hidden agents too", async () => {
  const p = props();
  const user = userEvent.setup();
  render(<AgentsOverview {...p} />);
  const pinned = screen.getByRole("region", { name: "Pinned" });
  expect(
    within(pinned).getByRole("button", { name: "Open @beta" }),
  ).toBeInTheDocument();
  expect(screen.getByText(/hidden from sidebar/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Pin @alpha" }));
  expect(p.onPinMine).toHaveBeenCalledWith("a1", true);
  await user.click(screen.getByRole("button", { name: "Open @alpha" }));
  expect(p.onOpenMine).toHaveBeenCalledWith(mine[0]);
});

it("lists other people's agents, with creator and view-only note, and pins them locally", async () => {
  const user = userEvent.setup();
  render(<AgentsOverview {...props()} />);
  await user.click(screen.getByRole("tab", { name: /Shared with me/ }));
  expect(
    await screen.findByRole("button", { name: "Open @bobs-helper" }),
  ).toHaveTextContent("Bob Lee");
  // The stored theme's title, before any chat is loaded.
  expect(
    screen.getByRole("button", { name: "Open @bobs-helper" }),
  ).toHaveTextContent("Bob's Helper");
  expect(screen.getByText(/view only, by request/)).toBeInTheDocument();
  expect(listAgents).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Pin @bobs-helper" }));
  expect(setOrder).toHaveBeenCalledWith(["s1"]);
});

it("search matches names, project titles and creators", async () => {
  const user = userEvent.setup();
  render(<AgentsOverview {...props()} />);
  await user.type(screen.getByRole("searchbox"), "beta");
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Open @alpha" }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("button", { name: "Open @beta" })).toBeVisible();
});

test("filter and sort helpers", () => {
  const items = [
    {
      id: "1",
      name: "b",
      title: "B",
      project_id: "p",
      activity: 1,
      available: true,
    },
    {
      id: "2",
      name: "a",
      title: "A",
      project_id: "p",
      activity: 2,
      available: true,
    },
  ];
  expect(sortAgents(items, "name").map((i) => i.id)).toEqual(["2", "1"]);
  expect(sortAgents(items, "recent").map((i) => i.id)).toEqual(["2", "1"]);
  expect(filterAgents(items, "@b").map((i) => i.id)).toEqual(["1"]);
  expect(filterAgents(items, "lab", () => ["Lab"]).length).toBe(2);
});
