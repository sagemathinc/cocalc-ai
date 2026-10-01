/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import type { ProjectAgent } from "@cocalc/util/people";
import { AgentsOverview, filterAgents, sortAgents } from "./agents-overview";

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
    thread_id: "t",
    available: true,
    updated_at: "2026-09-01T00:00:00Z",
    ...extra,
  };
}

const mine = [agent("a1", "alpha"), agent("a2", "beta"), agent("a3", "gamma")];
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
    ...extra,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  order = [];
  listAgents.mockResolvedValue({ agents: shared, unavailable_bays: 0 });
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
