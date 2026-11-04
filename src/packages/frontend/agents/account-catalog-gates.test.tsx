/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// PR3 gates: catalog work happens only for visible consumers and stays
// bounded at any catalog size; untrusted metadata renders inert.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fromJS } from "immutable";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { AgentArtifactBrowser } from "./artifact-browser";
import { LibrarySidebar } from "./library-sidebar";
import { resetSharedAccountCatalogsForTests } from "./account-catalog";

const P1 = "11111111-1111-4111-8111-111111111111";
const ME = "99999999-9999-4999-8999-999999999999";
const PATH = "/home/user/a.chat";
const hex = (n: number) => n.toString(16).padStart(64, "0");

const mockHub = {
  capabilities: jest.fn(),
  listAccount: jest.fn(),
  getEntries: jest.fn(),
  listProject: jest.fn(),
};
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        get artifactCatalog() {
          return mockHub;
        },
      },
    },
  },
}));
let mockPins: string[] = [];
jest.mock("@cocalc/frontend/chat/use-artifact-pins", () => ({
  useArtifactPins: () => ({
    pins: mockPins,
    error: "",
    setPinned: jest.fn(),
    move: jest.fn(),
  }),
}));
jest.mock("./artifact-names", () => ({
  useArtifactNames: () => ({ names: [] }),
}));
jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  isIconName: () => false,
}));
jest.mock("./library-appearance-editor", () => ({
  LibraryAppearanceEditor: () => null,
}));
const mockProjectMap = fromJS({
  [P1]: { users: { [ME]: { group: "owner" } } },
});
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (store: string, field: string) =>
    store === "projects" && field === "project_map"
      ? mockProjectMap
      : undefined,
  redux: { getActions: () => ({ setState: () => {} }) },
}));

const agents = [
  {
    name: "helper",
    project_title: "Project",
    endpoint: { project_id: P1, agent_id: "agent" },
    path: PATH,
    thread_id: "t",
  } as NamedAgent,
];
const entry = (n: number, item: object = {}) => ({
  entry_id: hex(n),
  project_id: P1,
  chat_path: PATH,
  item: {
    thread_id: "t",
    artifact_id: `a${n}`,
    kind: "file",
    title: `Artifact ${n}`,
    description: "",
    created_at: n,
    publication: { operation_id: "op", message_id: "m" },
    ...item,
  },
});
// A catalog of 5000 artifacts, served a page at a time.
const CATALOG = Array.from({ length: 5000 }, (_, i) => entry(5000 - i));

function serveCatalog() {
  mockHub.capabilities.mockResolvedValue({ list: 1, deltas: 0, hints: 0 });
  mockHub.listAccount.mockImplementation(async ({ limit = 50, before }) => {
    const start = before
      ? CATALOG.findIndex(
          (e) => `${e.item.created_at}:${e.entry_id}` === before,
        ) + 1
      : 0;
    const page = CATALOG.slice(start, start + limit);
    const last = page[page.length - 1];
    return {
      entries: page,
      view: "mine",
      versions: { [P1]: { epoch: "e", seq: 1 } },
      ...(start + limit < CATALOG.length && last
        ? { next: `${last.item.created_at}:${last.entry_id}` }
        : {}),
    };
  });
  mockHub.getEntries.mockImplementation(async ({ items }) =>
    items.map((ref) => ({ ...entry(1), entry_id: ref.entry_id })),
  );
}

const calls = () => ({
  capabilities: mockHub.capabilities.mock.calls.length,
  listAccount: mockHub.listAccount.mock.calls.length,
  getEntries: mockHub.getEntries.mock.calls.length,
  listProject: mockHub.listProject.mock.calls.length,
});

beforeEach(() => {
  jest.clearAllMocks();
  resetSharedAccountCatalogsForTests();
  mockPins = [JSON.stringify([P1, PATH, "t", "a1"])];
  serveCatalog();
});

test("gate 1: the Agents workspace with the Library hidden and the Artifacts section collapsed makes no catalog call at all", async () => {
  render(
    <>
      <AgentArtifactBrowser
        accountId={ME}
        agents={agents}
        active={false}
        onSelect={async () => {}}
      />
      <LibrarySidebar
        inSection
        onlyCurrent
        search=""
        accountId={ME}
        agents={agents}
        onOpen={() => {}}
        onAll={() => {}}
      />
    </>,
  );
  await act(async () => {});
  expect(calls()).toEqual({
    capabilities: 0,
    listAccount: 0,
    getEntries: 0,
    listProject: 0,
  });
});

test("gate 2: an expanded sidebar makes one pins lookup and one bounded page, whatever the catalog size", async () => {
  render(
    <LibrarySidebar
      inSection
      search=""
      accountId={ME}
      agents={agents}
      onOpen={() => {}}
      onAll={() => {}}
    />,
  );
  await waitFor(() => expect(mockHub.listAccount).toHaveBeenCalled());
  await act(async () => {});
  expect(calls()).toEqual({
    capabilities: 1,
    listAccount: 1,
    getEntries: 1,
    listProject: 0,
  });
  expect(mockHub.listAccount.mock.calls[0][0].limit).toBeLessThanOrEqual(50);
  expect(await screen.findByText("Artifact 5000")).toBeInTheDocument();
});

test("gate 3: the chat's artifact side panel does not use the account catalog", () => {
  const source = readFileSync(
    join(__dirname, "..", "chat", "artifact-browser.tsx"),
    "utf8",
  );
  for (const name of [
    "account-catalog",
    "use-account-catalog",
    "artifact-catalog-store",
    "sharedArtifactCatalog",
    "artifactCatalog.",
  ])
    expect(source).not.toContain(name);
});

test("the Library loads only when shown; Load more is a named button that pages with the cursor", async () => {
  const view = render(
    <AgentArtifactBrowser
      accountId={ME}
      agents={agents}
      active={false}
      onSelect={async () => {}}
    />,
  );
  await act(async () => {});
  expect(calls().listAccount).toBe(0);
  view.rerender(
    <AgentArtifactBrowser
      accountId={ME}
      agents={agents}
      active
      onSelect={async () => {}}
    />,
  );
  const more = await screen.findByRole("button", { name: "Load more" });
  expect(calls().listProject).toBe(0);
  const user = userEvent.setup();
  await user.click(more);
  await waitFor(() => expect(mockHub.listAccount).toHaveBeenCalledTimes(2));
  expect(mockHub.listAccount.mock.calls[1][0]).toMatchObject({
    before: `${CATALOG[49].item.created_at}:${CATALOG[49].entry_id}`,
    versions: true,
  });
  // Appended, not replaced (100 rows plus the pinned one); "loaded" says
  // more remain.
  await waitFor(() =>
    expect(
      screen
        .getAllByRole("status")
        .some((node) => /101 artifacts loaded/.test(node.textContent ?? "")),
    ).toBe(true),
  );
});

test("an incomplete reply is announced and never claims a complete view (R5)", async () => {
  mockHub.listAccount.mockResolvedValue({
    entries: [entry(3)],
    view: "mine",
    versions: { [P1]: { epoch: "e", seq: 1 } },
    incomplete: { unavailable_bays: 1 },
    limited: { aliases: true },
  });
  render(
    <AgentArtifactBrowser
      accountId={ME}
      agents={agents}
      active
      onSelect={async () => {}}
    />,
  );
  expect(
    await screen.findByText(/Some projects couldn't be loaded right now/),
  ).toBeInTheDocument();
  expect(screen.getByText(/Some results may be missing/)).toBeInTheDocument();
});

test("S1: hostile metadata renders as inert text", async () => {
  const hostile = '<img src="x" onerror="window.__pwned=1">';
  mockHub.listAccount.mockResolvedValue({
    entries: [
      entry(7, {
        title: hostile,
        description: "<script>window.__pwned=1</script>",
        target: {
          repository: "javascript:window.__pwned=1",
          path: "javascript:x",
        },
      }),
    ],
    view: "mine",
    versions: { [P1]: { epoch: "e", seq: 1 } },
  });
  const { container } = render(
    <AgentArtifactBrowser
      accountId={ME}
      agents={agents}
      active
      onSelect={async () => {}}
    />,
  );
  expect((await screen.findAllByText(hostile)).length).toBeGreaterThan(0);
  expect(container.querySelector('img[src="x"]')).toBeNull();
  expect(container.querySelector("script")).toBeNull();
  for (const a of Array.from(container.querySelectorAll("a")))
    expect(a.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
  expect((window as any).__pwned).toBeUndefined();
});
