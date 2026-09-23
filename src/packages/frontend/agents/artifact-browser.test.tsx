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
import { CATALOG_LIMITS } from "./artifact-catalog-store";
import type { NamedAgent } from "@cocalc/conat/agents/personal";

const listProject = jest.fn();
let artifactNames: any[] = [];
jest.mock("./artifact-names", () => ({
  useArtifactNames: () => ({ names: artifactNames }),
}));
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
jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  isIconName: () => false,
}));
jest.mock("./library-appearance-editor", () => ({
  LibraryAppearanceEditor: ({ target, onClose }) => (
    <div role="dialog" aria-label="Edit appearance">
      {target.artifactId}
      <button onClick={onClose}>Close appearance</button>
    </div>
  ),
}));
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
  artifactNames = [];
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
  const view = render(
    <AgentArtifactBrowser {...props} active={false} activeAgent={agents[0]} />,
  );
  await waitFor(() => expect(listProject).toHaveBeenCalledTimes(2));
  expect(
    screen.queryByRole("region", { name: "Library" }),
  ).not.toBeInTheDocument();
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
    screen.getByRole("searchbox", { name: "Search library" }),
    "description two{Enter}",
  );
  expect(
    screen.queryByRole("button", { name: "Open Result one from one" }),
  ).not.toBeInTheDocument();
  const search = screen.getByRole("searchbox") as HTMLInputElement;
  search.setSelectionRange(3, 8);
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
  expect(screen.getByRole("searchbox")).toBe(search);
  expect(search.selectionStart).toBe(3);
  expect(search.selectionEnd).toBe(8);
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
      catalogEntryId: "same-id",
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

test("navigation shares the heading and participates in keyboard order", async () => {
  const toggle = jest.fn();
  render(
    <AgentArtifactBrowser
      accountId="library-navigation"
      agents={agents}
      active
      onSelect={async () => {}}
      navigation={<button onClick={toggle}>Toggle sidebar</button>}
    />,
  );
  await screen.findByRole("button", { name: "Open Result two from two" });
  const navigation = screen.getByRole("button", { name: "Toggle sidebar" });
  expect(
    screen.getByRole("heading", { name: "Library" }).parentElement,
  ).toContainElement(navigation);
  const user = userEvent.setup();
  await user.tab({ shift: true });
  expect(screen.getByRole("button", { name: "List view" })).toHaveFocus();
  await user.tab({ shift: true });
  expect(screen.getByRole("button", { name: "Grid view" })).toHaveFocus();
  await user.tab({ shift: true });
  expect(navigation).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(toggle).toHaveBeenCalledTimes(1);
  await user.tab();
  await user.tab();
  await user.tab();
  expect(
    screen.getByRole("searchbox", { name: "Search library" }),
  ).toHaveFocus();
  expect(
    screen.queryByRole("button", { name: /Return to agent|Back to agent/ }),
  ).not.toBeInTheDocument();
});

test("grid and list views retain the same artifact actions", async () => {
  const user = userEvent.setup();
  const onSelect = jest.fn(async () => {});
  render(
    <AgentArtifactBrowser
      accountId="library-grid"
      agents={agents}
      active
      onSelect={onSelect}
    />,
  );
  await screen.findByRole("button", { name: "Open Result one from one" });
  await user.click(screen.getByRole("button", { name: "Grid view" }));
  expect(screen.getByRole("button", { name: "Grid view" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("list", { name: "" })).toHaveStyle({
    display: "grid",
  });
  await user.click(
    screen.getByRole("button", { name: "Open Result one from one" }),
  );
  expect(onSelect).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "List view" }));
  expect(screen.getByRole("button", { name: "List view" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("a personal artifact name is visible and searchable in grid view", async () => {
  artifactNames = [
    {
      name: "my-notebook",
      project_id: "p-one",
      entry_id: "same-id",
      active: true,
    },
  ];
  const user = userEvent.setup();
  render(
    <AgentArtifactBrowser
      accountId="library-alias-search"
      agents={agents}
      active
      onSelect={async () => {}}
    />,
  );
  await screen.findByRole("button", { name: "Open Result one from one" });
  await user.click(screen.getByRole("button", { name: "Grid view" }));
  expect(screen.getByText("@my-notebook")).toBeVisible();
  await user.type(
    screen.getByRole("searchbox", { name: "Search library" }),
    "my-notebook",
  );
  expect(
    screen.getByRole("button", { name: "Open Result one from one" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Open Result two from two" }),
  ).not.toBeInTheDocument();
});

test("grid tiles use catalog appearance and open the real appearance action", async () => {
  listProject.mockImplementation(async ({ project_id }) => ({
    entries: [
      {
        ...entry(project_id.slice(2)),
        item: {
          ...entry(project_id.slice(2)).item,
          appearance: {
            color: "#123456",
            accent_color: "#abcdef",
            image_blob: "11111111-1111-4111-8111-111111111111",
          },
        },
      },
    ],
    indexed_sources: 1,
  }));
  const user = userEvent.setup();
  render(
    <AgentArtifactBrowser
      accountId="library-appearance"
      agents={agents}
      active
      onSelect={async () => {}}
    />,
  );
  await screen.findByRole("button", { name: "Open Result one from one" });
  await user.click(screen.getByRole("button", { name: "Grid view" }));
  expect(
    screen
      .getByRole("button", { name: "Open Result one from one" })
      .closest("[role=listitem]"),
  ).toHaveStyle({
    border: "1px solid #123456",
    minHeight: "136px",
  });
  expect(
    screen
      .getByRole("button", { name: "Open Result one from one" })
      .querySelector("img"),
  ).toHaveAttribute(
    "src",
    "/blobs/theme-image.png?uuid=11111111-1111-4111-8111-111111111111",
  );
  await user.click(screen.getByRole("button", { name: "List view" }));
  expect(
    screen
      .getByRole("button", { name: "Open Result one from one" })
      .closest("[role=listitem]"),
  ).toHaveStyle({ borderLeft: "3px solid #123456" });
  expect(
    screen
      .getByRole("button", { name: "Open Result one from one" })
      .querySelector("img"),
  ).toHaveAttribute(
    "src",
    "/blobs/theme-image.png?uuid=11111111-1111-4111-8111-111111111111",
  );
  await user.click(
    screen.getByRole("button", { name: "More options for Result one" }),
  );
  await user.click(screen.getByRole("menuitem", { name: "Edit appearance" }));
  expect(
    await screen.findByRole("dialog", { name: "Edit appearance" }),
  ).toHaveTextContent("same-id");
  await user.click(screen.getByRole("button", { name: "Close appearance" }));
  expect(
    screen.queryByRole("dialog", { name: "Edit appearance" }),
  ).not.toBeInTheDocument();
});

test("returning retains result DOM, search, organization, scroll and opening-row focus", async () => {
  const user = userEvent.setup();
  const props = {
    accountId: "library-return",
    agents,
    onSelect: jest.fn(async () => {}),
  };
  const view = render(<AgentArtifactBrowser {...props} active />);
  const row = await screen.findByRole("button", {
    name: "Open Result two from two",
  });
  await user.type(
    screen.getByRole("searchbox", { name: "Search library" }),
    "description",
  );
  await user.click(
    screen.getByRole("button", { name: "Filters & organization" }),
  );
  await user.click(screen.getByRole("checkbox", { name: "Group by project" }));
  const viewport = screen.getByRole("region", { name: "Library" });
  fireEvent.scroll(viewport, { target: { scrollTop: 480 } });
  const groupedRow = screen.getByRole("button", {
    name: "Open Result two from two",
  });
  act(() => groupedRow.focus());
  await user.keyboard("{Enter}");
  expect(props.onSelect).toHaveBeenCalledTimes(1);
  view.rerender(<AgentArtifactBrowser {...props} active={false} />);
  expect(viewport).not.toBeVisible();
  expect(groupedRow).toBeInTheDocument();
  expect(groupedRow).not.toHaveFocus();
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  // Simulate a browser resetting the hidden scroll box.
  fireEvent.scroll(viewport, { target: { scrollTop: 0 } });
  view.rerender(<AgentArtifactBrowser {...props} active />);
  expect(screen.getByRole("button", { name: "Open Result two from two" })).toBe(
    groupedRow,
  );
  expect(groupedRow).toHaveFocus();
  expect(viewport.scrollTop).toBe(480);
  expect(screen.getByRole("searchbox")).toHaveValue("description");
  expect(
    screen.getByRole("checkbox", { name: "Group by project" }),
  ).toBeChecked();
  expect(
    screen.getByRole("button", { name: "Filters & organization (active)" }),
  ).toHaveAttribute("aria-expanded", "true");
  expect(listProject).toHaveBeenCalledTimes(2);
  // Grouping intentionally changes the row's parent, unlike a hide/show cycle.
  expect(row).not.toBeInTheDocument();
});

test("parent-selected identity restores a row without stealing focus on active updates", async () => {
  const props = {
    accountId: "library-selected",
    agents,
    onSelect: async () => {},
  };
  const view = render(<AgentArtifactBrowser {...props} active />);
  const row = await screen.findByRole("button", {
    name: "Open Result one from one",
  });
  const selectedArtifactIdentity = JSON.stringify([
    "p-one",
    "/one.chat",
    "t-one",
    "same-id",
  ]);
  view.rerender(
    <AgentArtifactBrowser
      {...props}
      active
      selectedArtifactIdentity={selectedArtifactIdentity}
    />,
  );
  expect(screen.getByRole("searchbox")).toHaveFocus();
  view.rerender(
    <AgentArtifactBrowser
      {...props}
      active={false}
      selectedArtifactIdentity={selectedArtifactIdentity}
    />,
  );
  view.rerender(
    <AgentArtifactBrowser
      {...props}
      active
      selectedArtifactIdentity={selectedArtifactIdentity}
    />,
  );
  expect(row).toHaveFocus();
  await userEvent.setup().type(screen.getByRole("searchbox"), "two");
  view.rerender(
    <AgentArtifactBrowser
      {...props}
      active={false}
      selectedArtifactIdentity={selectedArtifactIdentity}
    />,
  );
  view.rerender(
    <AgentArtifactBrowser
      {...props}
      active
      selectedArtifactIdentity={selectedArtifactIdentity}
    />,
  );
  expect(screen.getByRole("searchbox")).toHaveFocus();
  expect(screen.getByRole("searchbox")).toHaveValue("two");
  expect(
    screen.queryByRole("button", { name: "Open Result one from one" }),
  ).not.toBeInTheDocument();
});

test("returning before navigation settles restores focus when the row is enabled", async () => {
  let finish!: () => void;
  const props = {
    accountId: "library-pending-open",
    agents,
    onSelect: jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    ),
  };
  const view = render(<AgentArtifactBrowser {...props} active />);
  const row = await screen.findByRole("button", {
    name: "Open Result two from two",
  });
  await userEvent.setup().click(row);
  expect(row).toBeDisabled();
  view.rerender(<AgentArtifactBrowser {...props} active={false} />);
  view.rerender(<AgentArtifactBrowser {...props} active />);
  await act(async () => finish());
  expect(row).toBeEnabled();
  expect(row).toHaveFocus();
});

test("organization popups cannot escape the inactive library", async () => {
  const props = {
    accountId: "library-hidden-popup",
    agents,
    onSelect: async () => {},
  };
  const view = render(<AgentArtifactBrowser {...props} active />);
  await screen.findByRole("button", { name: "Open Result two from two" });
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Filters & organization" }));
  const filter = screen.getByRole("combobox", { name: "Project" });
  act(() => filter.focus());
  key(filter, "ArrowDown", 40);
  expect(await screen.findByRole("listbox")).toBeInTheDocument();
  view.rerender(<AgentArtifactBrowser {...props} active={false} />);
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(filter).not.toHaveFocus();
  view.rerender(<AgentArtifactBrowser {...props} active />);
  expect(filter).toHaveFocus();
});

test("loading and metadata failures are announced, with retry in organization", async () => {
  let reject!: (error: Error) => void;
  listProject.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  render(
    <AgentArtifactBrowser
      accountId="library-metadata"
      agents={agents}
      active
      onSelect={async () => {}}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Loading library...");
  await act(async () => reject(Error("unavailable")));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Library metadata unavailable",
  );
  expect(screen.getByRole("alert")).toHaveTextContent("retrying periodically");
  expect(screen.queryByText(/No artifacts yet/)).not.toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "Filters & organization" }),
  );
  const refresh = screen.getByRole("button", { name: "Refresh" });
  act(() => refresh.focus());
  await user.keyboard("{Enter}");
  await screen.findByRole("button", { name: "Open Result two from two" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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
  const organization = screen.getByRole("button", {
    name: "Filters & organization",
  });
  expect(organization).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Refresh" }),
  ).not.toBeInTheDocument();
  act(() => organization.focus());
  await user.keyboard("{Enter}");
  expect(organization).toHaveAttribute("aria-expanded", "true");
  await user.tab();
  expect(screen.getByRole("combobox", { name: "Project" })).toHaveFocus();
  const sort = screen.getByRole("combobox", {
    name: "Sort",
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
    name: "Project",
  });
  act(() => filter.focus());
  key(filter, "ArrowDown", 40);
  await waitFor(() => expect(filter).toHaveAttribute("aria-expanded", "true"));
  key(filter, "Escape", 27);
  expect(filter).toHaveFocus();
  expect(organization).toHaveAttribute("aria-expanded", "true");
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
  act(() => group.focus());
  await user.keyboard("{Escape}");
  expect(organization).toHaveFocus();
  expect(organization).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  const back = screen.getByRole("button", { name: "Return to agent" });
  back.focus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Grid view" })).toHaveFocus();
  await user.tab();
  await user.tab();
  expect(screen.getByRole("searchbox")).toHaveFocus();
  await user.tab({ shift: true });
  await user.tab({ shift: true });
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
  await user.click(
    screen.getByRole("button", { name: "Filters & organization" }),
  );
  const sort = screen.getByRole("combobox", {
    name: "Sort",
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
  expect(screen.getByText(/sources may still be indexing/)).not.toBeVisible();
  await user.click(
    screen.getByRole("button", { name: "Filters & organization" }),
  );
  await user.click(screen.getByRole("checkbox", { name: "Group by project" }));
  expect(screen.getAllByRole("listitem")).toHaveLength(200);
  // JSDOM does not implement the native summary keyboard default action.
  const details = screen.getByText("About this library");
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
