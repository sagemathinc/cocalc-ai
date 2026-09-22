import {
  act,
  render,
  screen,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentArtifactBrowser } from "./artifact-browser";
import { agentSearchStore } from "./search-state";
import type { NamedAgent } from "@cocalc/conat/agents/personal";

// rc-util's constant test ID otherwise collides in nested popup Escape stacks.
jest.mock("@rc-component/util/lib/hooks/useId", () => ({
  __esModule: true,
  ...jest.requireActual("@rc-component/util/lib/hooks/useId"),
  default: jest.requireActual("react").useId,
}));

const listProject = jest.fn();
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        artifactCatalog: { listProject: (...args) => listProject(...args) },
      },
    },
  },
}));
const setPinned = jest.fn();
jest.mock("@cocalc/frontend/chat/use-artifact-pins", () => ({
  useArtifactPins: () => ({ pins: [], error: "", setPinned }),
}));
jest.mock("@cocalc/frontend/components", () => ({ Icon: () => null }));
const agents = ["one", "two"].map(
  (name) =>
    ({
      name,
      project_title: `Project ${name}`,
      endpoint: { project_id: `p-${name}`, agent_id: name },
      path: `/${name}.chat`,
      thread_id: `t-${name}`,
    }) as NamedAgent,
);
const entry = (name: string, id = "same-id") => ({
  entry_id: id,
  project_id: `p-${name}`,
  chat_path: `/${name}.chat`,
  item: {
    thread_id: `t-${name}`,
    artifact_id: id,
    title: `Result ${name}`,
    kind: "file",
    description: `Description ${name}`,
    created_at: 1,
    publication: { operation_id: "op", message_id: "msg" },
  },
});
beforeEach(() => {
  listProject.mockReset();
  setPinned.mockReset();
  listProject.mockImplementation(async ({ project_id }) => ({
    entries: [entry(project_id.slice(2))],
    indexed_sources: 1,
  }));
});

test("warms while closed; opening and local keyboard search never issue RPCs", async () => {
  const accountId = "catalog-browser-local";
  const onSelect = jest.fn(async () => {});
  const view = render(
    <AgentArtifactBrowser
      accountId={accountId}
      agents={agents}
      active
      onSelect={onSelect}
    />,
  );
  await waitFor(() => expect(listProject).toHaveBeenCalledTimes(2));
  act(() => {
    agentSearchStore(accountId).set({ artifactsOpen: true });
  });
  const input = await screen.findByRole("searchbox", {
    name: "Search all agent artifacts",
  });
  const user = userEvent.setup();
  await user.type(input, "description two{Enter}");
  expect(
    screen.queryByRole("button", { name: "Open Result one from one" }),
  ).not.toBeInTheDocument();
  const target = screen.getByRole("button", {
    name: "Open Result two from two",
  });
  expect(listProject).toHaveBeenCalledTimes(2);
  view.rerender(
    <AgentArtifactBrowser
      accountId={accountId}
      agents={[...agents]}
      active
      onSelect={onSelect}
    />,
  );
  expect(listProject).toHaveBeenCalledTimes(2);
  target.focus();
  expect(target).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(onSelect).toHaveBeenCalledWith(
    expect.objectContaining({
      agent: agents[1],
      threadId: "t-two",
      historical: false,
      hit: expect.objectContaining({
        artifact_id: "same-id",
        operation_id: "op",
        message_id: "msg",
      }),
    }),
  );
  await waitFor(() =>
    expect(agentSearchStore(accountId).get().artifactsOpen).toBe(false),
  );
});

test("project filter, sort, pin and Escape are keyboard operable and local", async () => {
  const accountId = "catalog-browser-keyboard";
  agentSearchStore(accountId).set({ artifactsOpen: true });
  render(
    <AgentArtifactBrowser
      accountId={accountId}
      agents={agents}
      active
      onSelect={async () => {}}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Open Result two from two" }),
    ).toBeVisible(),
  );
  const user = userEvent.setup();
  const filter = screen.getByRole("combobox", {
    name: "Filter artifact projects",
  });
  act(() => filter.focus());
  expect(filter).toHaveFocus();
  // rc-select uses legacy keyCode, which user-event's keyboard omits.
  fireEvent.keyDown(filter, { key: "ArrowDown", keyCode: 40, which: 40 });
  await waitFor(() => expect(filter).toHaveAttribute("aria-expanded", "true"));
  fireEvent.keyDown(filter, { key: "Enter", keyCode: 13, which: 13 });
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Open Result two from two" }),
    ).not.toBeInTheDocument(),
  );
  const sort = screen.getByRole("combobox", {
    name: "Sort discovered artifacts",
  });
  act(() => sort.focus());
  fireEvent.keyDown(sort, { key: "ArrowDown", keyCode: 40, which: 40 });
  await waitFor(() => expect(sort).toHaveAttribute("aria-expanded", "true"));
  fireEvent.keyDown(sort, { key: "ArrowDown", keyCode: 40, which: 40 });
  fireEvent.keyDown(sort, { key: "Enter", keyCode: 13, which: 13 });
  await waitFor(() => expect(sort).toHaveAttribute("aria-expanded", "false"));
  const pin = screen.getByRole("button", { name: "Pin Result one" });
  pin.focus();
  await user.keyboard("{Enter}");
  expect(setPinned).toHaveBeenCalledWith(
    JSON.stringify(["p-one", "/one.chat", "t-one", "same-id"]),
    true,
  );
  expect(listProject).toHaveBeenCalledTimes(2);
  const input = screen.getByRole("searchbox", {
    name: "Search all agent artifacts",
  });
  input.focus();
  await waitFor(() =>
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
  );
  fireEvent.keyDown(input, { key: "Escape", keyCode: 27, which: 27 });
  await waitFor(() =>
    expect(agentSearchStore(accountId).get().artifactsOpen).toBe(false),
  );
});

test("account switch clears the old view and rejects late loads", async () => {
  let resolve!: (value: unknown) => void;
  listProject.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  agentSearchStore("catalog-browser-old").set({ artifactsOpen: true });
  agentSearchStore("catalog-browser-new").set({ artifactsOpen: true });
  const view = render(
    <AgentArtifactBrowser
      accountId="catalog-browser-old"
      agents={agents.slice(0, 1)}
      active
      onSelect={async () => {}}
    />,
  );
  view.rerender(
    <AgentArtifactBrowser
      accountId="catalog-browser-new"
      agents={agents.slice(1)}
      active
      onSelect={async () => {}}
    />,
  );
  await screen.findByRole("button", { name: "Open Result two from two" });
  await act(async () => {
    resolve({ entries: [entry("one")], indexed_sources: 1 });
  });
  expect(
    screen.queryByRole("button", { name: "Open Result one from one" }),
  ).not.toBeInTheDocument();
});

test("large cache renders only 200 matches with short coverage note and expandable details", async () => {
  listProject.mockResolvedValue({
    entries: Array.from({ length: 250 }, (_, i) => entry("one", `id-${i}`)),
    indexed_sources: 1,
  });
  const accountId = "catalog-browser-bound";
  agentSearchStore(accountId).set({ artifactsOpen: true });
  render(
    <AgentArtifactBrowser
      accountId={accountId}
      agents={agents.slice(0, 1)}
      active
      onSelect={async () => {}}
    />,
  );
  await screen.findByText(/Showing the first 200 of 250 matches/);
  expect(
    screen.getAllByRole("button", { name: "Open Result one from one" }),
  ).toHaveLength(200);
  await waitFor(() =>
    expect(
      screen.getByText(/some sources may still be indexing/),
    ).toBeVisible(),
  );
  const details = screen.getByText("Preview details");
  // JSDOM does not implement the native summary keyboard default action.
  await userEvent.setup().click(details);
  expect(details.closest("details")).toHaveAttribute("open");
  expect(screen.getByText(/not a completeness count/)).toBeVisible();
});
