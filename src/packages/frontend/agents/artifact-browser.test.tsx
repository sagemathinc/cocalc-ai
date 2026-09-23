import {
  act,
  render,
  screen,
  waitFor,
  fireEvent,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentArtifactBrowser } from "./artifact-browser";
import { agentSearchStore } from "./search-state";
import { CATALOG_LIMITS } from "./artifact-catalog-store";
import type { NamedAgent } from "@cocalc/conat/agents/personal";

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
const move = jest.fn();
let pinned: string[] = [];
jest.mock("@cocalc/frontend/chat/use-artifact-pins", () => ({
  useArtifactPins: () => ({ pins: pinned, error: "", setPinned, move }),
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
    created_at: name === "two" ? 2 : 1,
    publication: { operation_id: "op", message_id: "msg" },
  },
});
beforeEach(() => {
  pinned = [];
  listProject.mockReset();
  setPinned.mockReset();
  move.mockReset();
  listProject.mockImplementation(async ({ project_id }) => ({
    entries: [entry(project_id.slice(2))],
    indexed_sources: 1,
  }));
});

test("active alone shows all agents and reuses the warm cache and search", async () => {
  const props = {
    accountId: "library-cache",
    agents,
    onSelect: jest.fn(async () => {}),
  };
  agentSearchStore(props.accountId).set({
    artifactsOpen: true,
  });
  const view = render(
    <AgentArtifactBrowser {...props} active={false} activeAgent={agents[0]} />,
  );
  await waitFor(() => expect(listProject).toHaveBeenCalledTimes(2));
  expect(
    screen.queryByRole("region", { name: "Library" }),
  ).not.toBeInTheDocument();
  act(() => agentSearchStore(props.accountId).set({ artifactsOpen: false }));
  view.rerender(
    <AgentArtifactBrowser {...props} active activeAgent={agents[0]} />,
  );
  expect(screen.getByRole("heading", { name: "Library" })).toBeVisible();
  expect(screen.getByRole("searchbox")).toHaveFocus();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("combobox", { name: "Artifact scope" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Back to agent" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Open Result one from one" }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Open Result two from two" }),
  ).toBeVisible();
  const user = userEvent.setup();
  await user.type(
    screen.getByRole("searchbox", { name: "Search all agent artifacts" }),
    "description two{Enter}",
  );
  expect(
    screen.queryByRole("button", { name: "Open Result one from one" }),
  ).not.toBeInTheDocument();
  view.rerender(<AgentArtifactBrowser {...props} active={false} />);
  view.rerender(
    <AgentArtifactBrowser
      {...props}
      agents={[...agents]}
      active
      activeAgent={agents[1]}
    />,
  );
  expect(screen.getByRole("searchbox")).toHaveValue("description two");
  expect(screen.getByRole("searchbox")).toHaveFocus();
  const target = screen.getByRole("button", {
    name: "Open Result two from two",
  });
  act(() => target.focus());
  expect(target).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(props.onSelect).toHaveBeenCalledWith(
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
  expect(screen.getByRole("heading", { name: "Library" })).toBeVisible();
  expect(listProject).toHaveBeenCalledTimes(2);
});

test("catalog continues refreshing while inactive", async () => {
  jest.useFakeTimers();
  try {
    const props = {
      accountId: "library-background",
      agents,
      onSelect: async () => {},
    };
    const view = render(<AgentArtifactBrowser {...props} active={false} />);
    await act(async () => {});
    expect(listProject).toHaveBeenCalledTimes(2);
    await act(async () => {
      jest.advanceTimersByTime(CATALOG_LIMITS.refreshMs);
    });
    expect(listProject).toHaveBeenCalledTimes(4);
    view.rerender(<AgentArtifactBrowser {...props} active />);
    expect(
      screen.getByRole("button", { name: "Open Result two from two" }),
    ).toBeVisible();
    expect(listProject).toHaveBeenCalledTimes(4);
    view.unmount();
  } finally {
    jest.useRealTimers();
  }
});

// rc-select uses legacy keyCode, which user-event's keyboard omits.
function key(element: HTMLElement, key: string, keyCode: number) {
  fireEvent.keyDown(element, { key, keyCode, which: keyCode });
}

test("keyboard sorting, grouping, filtering, pins and navigation are local", async () => {
  const user = userEvent.setup();
  const onClose = jest.fn();
  const onShowConversation = jest.fn(async () => {});
  const props = {
    accountId: "library-keyboard",
    agents,
    active: true,
    onSelect: jest.fn(async () => {}),
    onClose,
    onShowConversation,
  };
  const view = render(<AgentArtifactBrowser {...props} />);
  await screen.findByRole("button", { name: "Open Result two from two" });
  const titles = () =>
    screen
      .getAllByRole("button", { name: /^Open Result/ })
      .map((button) => button.getAttribute("aria-label"));
  expect(titles()[0]).toBe("Open Result two from two");
  const sort = screen.getByRole("combobox", {
    name: "Sort discovered artifacts",
  });
  act(() => sort.focus());
  key(sort, "ArrowDown", 40);
  await waitFor(() => expect(sort).toHaveAttribute("aria-expanded", "true"));
  key(sort, "ArrowDown", 40);
  key(sort, "Enter", 13);
  expect(titles()[0]).toBe("Open Result one from one");
  const group = screen.getByRole("checkbox", { name: "Group by project" });
  act(() => group.focus());
  await user.keyboard(" ");
  expect(group).toBeChecked();
  expect(group).toHaveFocus();
  for (const name of ["one", "two"]) {
    const section = screen.getByRole("region", { name: `Project ${name}` });
    expect(
      within(section).getByRole("heading", { name: `Project ${name}` }),
    ).toBeVisible();
    expect(within(section).getAllByRole("listitem")).toHaveLength(1);
    expect(
      within(section).getByRole("button", {
        name: `Open Result ${name} from ${name}`,
      }),
    ).toHaveTextContent(`Project ${name} · @${name}`);
  }
  await user.keyboard(" ");
  expect(
    screen.queryByRole("heading", { name: "Project one" }),
  ).not.toBeInTheDocument();
  const pin = screen.getByRole("button", { name: "Pin Result two" });
  pin.focus();
  await user.keyboard("{Enter}");
  const id = JSON.stringify(["p-two", "/two.chat", "t-two", "same-id"]);
  expect(setPinned).toHaveBeenCalledWith(id, true);
  pinned = [id];
  view.rerender(<AgentArtifactBrowser {...props} />);
  expect(titles()[0]).toBe("Open Result one from one");
  const unpin = screen.getByRole("button", { name: "Unpin Result two" });
  expect(unpin).toHaveAttribute("aria-pressed", "true");
  unpin.focus();
  await user.keyboard(" ");
  expect(setPinned).toHaveBeenLastCalledWith(id, false);
  const filter = screen.getByRole("combobox", {
    name: "Filter artifact projects",
  });
  act(() => filter.focus());
  key(filter, "ArrowDown", 40);
  await waitFor(() => expect(filter).toHaveAttribute("aria-expanded", "true"));
  key(filter, "Escape", 27);
  expect(filter).toHaveFocus();
  expect(onClose).not.toHaveBeenCalled();
  key(filter, "ArrowDown", 40);
  key(filter, "ArrowUp", 38);
  key(filter, "Enter", 13);
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Open Result two from two" }),
    ).not.toBeInTheDocument(),
  );
  const conversation = screen.getByRole("button", {
    name: "Show conversation for Result one from one",
  });
  act(() => conversation.focus());
  await user.keyboard("{Enter}");
  expect(onShowConversation).toHaveBeenCalledWith(
    expect.objectContaining({ agent: agents[0] }),
  );
  expect(props.onSelect).not.toHaveBeenCalled();
  const back = screen.getByRole("button", { name: "Back to agent" });
  back.focus();
  await user.tab();
  expect(screen.getByRole("searchbox")).toHaveFocus();
  await user.tab({ shift: true });
  expect(back).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(listProject).toHaveBeenCalledTimes(2);
});

test("Custom exposes pinned drag handles and keyboard move menus scoped to groups", async () => {
  const ids = agents.map((agent) =>
    JSON.stringify([
      agent.endpoint.project_id,
      agent.path,
      agent.thread_id,
      "same-id",
    ]),
  );
  pinned = [...ids];
  const props = {
    accountId: "library-custom",
    agents,
    active: true,
    onSelect: async () => {},
  };
  const view = render(<AgentArtifactBrowser {...props} />);
  await screen.findByRole("button", { name: "Open Result two from two" });
  const user = userEvent.setup();
  const sort = screen.getByRole("combobox", {
    name: "Sort discovered artifacts",
  });
  act(() => sort.focus());
  key(sort, "ArrowDown", 40);
  await waitFor(() => expect(sort).toHaveAttribute("aria-expanded", "true"));
  key(sort, "ArrowDown", 40);
  key(sort, "ArrowDown", 40);
  key(sort, "Enter", 13);
  const handle = await screen.findByRole("button", {
    name: "Drag Result one to reorder",
  });
  expect(handle).toHaveAttribute("tabindex", "0");
  const trigger = screen.getByRole("button", { name: "Reorder Result one" });
  act(() => trigger.focus());
  await user.keyboard("{Enter}");
  const down = await screen.findByRole("menuitem", { name: "Move down" });
  expect(screen.getByRole("menuitem", { name: "Move up" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  act(() => down.focus());
  key(down, "Enter", 13);
  expect(move).toHaveBeenCalledWith(ids, ids[0], 1);
  pinned = [...ids].reverse();
  view.rerender(<AgentArtifactBrowser {...props} />);
  expect(
    screen.getAllByRole("button", { name: /^Open Result/ })[0],
  ).toHaveAccessibleName("Open Result two from two");
  expect(trigger).toHaveFocus();
  await user.click(screen.getByRole("checkbox", { name: "Group by project" }));
  await user.click(screen.getByRole("button", { name: "Reorder Result one" }));
  expect(
    await screen.findByRole("menuitem", { name: "Move up" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("menuitem", { name: "Move down" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await user.keyboard("{Escape}");
  expect(
    screen.getByRole("button", { name: "Reorder Result one" }),
  ).toHaveFocus();
  expect(listProject).toHaveBeenCalledTimes(2);
});

test("account switch clears the old view and rejects late loads", async () => {
  let resolve!: (value: unknown) => void;
  listProject.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const props = { active: true, onSelect: async () => {} };
  const view = render(
    <AgentArtifactBrowser
      {...props}
      accountId="library-old"
      agents={agents.slice(0, 1)}
    />,
  );
  view.rerender(
    <AgentArtifactBrowser
      {...props}
      accountId="library-new"
      agents={agents.slice(1)}
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

test("large cache bounds rows across groups and explains partial coverage", async () => {
  listProject.mockImplementation(async ({ project_id }) => ({
    entries: Array.from({ length: 125 }, (_, i) =>
      entry(project_id.slice(2), `id-${i}`),
    ),
    indexed_sources: 1,
  }));
  render(
    <AgentArtifactBrowser
      accountId="library-bound"
      agents={agents}
      active
      onSelect={async () => {}}
    />,
  );
  await screen.findByText(/Showing the first 200 of 250 matches/);
  const user = userEvent.setup();
  await user.click(screen.getByRole("checkbox", { name: "Group by project" }));
  expect(screen.getAllByRole("listitem")).toHaveLength(200);
  expect(screen.getByText(/some sources may still be indexing/)).toBeVisible();
  // JSDOM does not implement the native summary keyboard default action.
  const details = screen.getByText("Preview details");
  await user.click(details);
  expect(details.closest("details")).toHaveAttribute("open");
  expect(screen.getByText(/not a completeness count/)).toBeVisible();
});

test("failed artifact opens remain visible in the Library", async () => {
  render(
    <AgentArtifactBrowser
      accountId="library-error"
      agents={agents}
      active
      onSelect={async () => {
        throw Error("Cannot open artifact");
      }}
    />,
  );
  await userEvent
    .setup()
    .click(
      await screen.findByRole("button", { name: "Open Result one from one" }),
    );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Cannot open artifact",
  );
  expect(
    screen.getByRole("button", { name: "Open Result one from one" }),
  ).toBeEnabled();
});
