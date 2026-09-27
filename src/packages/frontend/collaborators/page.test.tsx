import { useState } from "react";
import { Map, fromJS } from "immutable";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CollaboratorsPage } from "./page";
import type { CollaboratorsRoute } from "./workspace-types";

let mockAccount = "alice";
let mockProjects = Map();
let mockSettings = Map();
const mockSavePreferences = jest.fn(async (key, value) => {
  mockSettings = mockSettings.set(key, value);
});
const mockApi = {
  check: jest.fn(),
  listPeople: jest.fn(),
  listProjects: jest.fn(),
  setProjectPinned: jest.fn(),
  listResources: jest.fn(),
  getResource: jest.fn(),
  setPersonalState: jest.fn(),
  ensureRoom: jest.fn(),
};
jest.mock("./workspace-api", () => ({ boundCollaboratorsApi: () => mockApi }));
jest.mock("@cocalc/frontend/account/avatar/avatar", () => ({
  Avatar: ({ account_id }) => <span data-testid={`avatar-${account_id}`} />,
}));
jest.mock("@cocalc/frontend/projects/theme", () => ({
  ProjectThemeAvatar: ({ theme }) => (
    <span data-testid="project-theme" data-theme={JSON.stringify(theme)} />
  ),
}));
jest.mock("@cocalc/frontend/agents/project-settings-drawer", () => ({
  ProjectSettingsDrawer: ({ open, projectId, onClose }) =>
    open ? (
      <div role="dialog" aria-label="Project settings">
        <span>{projectId}</span>
        <button onClick={onClose}>Close settings</button>
      </div>
    ) : null,
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (store: string, key: string) =>
    store === "account"
      ? key === "other_settings"
        ? mockSettings
        : mockAccount
      : mockProjects,
  redux: {
    getActions: () => ({
      erase_active_key_handler: jest.fn(),
      set_other_settings_and_wait: mockSavePreferences,
    }),
    getStore: () => ({ get: () => mockAccount }),
  },
}));
jest.mock("@cocalc/frontend/app-framework/project-runtime", () => ({
  ensureProjectReduxRuntime: jest.fn(),
}));
jest.mock("@cocalc/frontend/agents/open-agent", () => ({
  openAgentThread: jest.fn(),
}));
jest.mock("./human-conversation", () => ({
  HumanConversation: () => <textarea aria-label="Human message" />,
}));
jest.mock("./add-collaborators", () => ({
  AddCollaborators: () => <input aria-label="Invite a collaborator" />,
}));
jest.mock("@cocalc/frontend/projects/create-project", () => ({
  NewProjectCreator: () => <div role="dialog" aria-label="Create project" />,
}));

const conversation = {
  project_id: "geometry",
  project_title: "Geometry Lab",
  resource_id: "office-hours",
  kind: "conversation",
  title: "Office hours",
  chat_path: "/room.chat",
  thread_id: "office-hours",
  participant_ids: ["alice", "bob"],
  created_at: 1,
  updated_at: 1,
  activity: 2,
  reason: "participation",
};
const page = (items: unknown[], extra = {}) => ({
  items,
  coverage: "complete",
  ...extra,
});

function Workspace({
  initial = { view: "conversations" } as CollaboratorsRoute,
}) {
  const [route, setRoute] = useState(initial);
  return (
    <CollaboratorsPage
      accountId={mockAccount}
      active
      {...route}
      onNavigate={setRoute}
    />
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAccount = "alice";
  mockProjects = Map();
  mockSettings = Map();
  mockApi.check.mockResolvedValue({
    revision: "initial",
    reset: true,
    poll_after_ms: 5000,
  });
  mockApi.listPeople.mockResolvedValue(
    page([{ account_id: "bob", display_name: "Bob", common_project_count: 1 }]),
  );
  mockApi.listProjects.mockResolvedValue(
    page([
      {
        project_id: "geometry",
        title: "Geometry Lab",
        description: "Research",
        role: "owner",
      },
    ]),
  );
  mockApi.listResources.mockResolvedValue(page([conversation]));
  mockApi.getResource.mockResolvedValue(conversation);
});

beforeAll(() => {
  const getComputedStyle = window.getComputedStyle;
  jest
    .spyOn(window, "getComputedStyle")
    .mockImplementation((element) => getComputedStyle(element));
});
afterAll(() => jest.restoreAllMocks());

test("compact tabs support arrow navigation and contextual actions", async () => {
  const user = userEvent.setup();
  render(<Workspace initial={{ view: "people" }} />);
  const people = screen.getByRole("tab", { name: "Collaborators" });
  expect(people).toHaveAttribute("aria-selected", "true");
  expect(
    screen.getByRole("tabpanel", { name: "Collaborators" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Invite", exact: true }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "New conversation" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Create project" })).toBeNull();
  expect(screen.queryByText(/Pins are ordered/)).toBeNull();
  act(() => people.focus());
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("tab", { name: "Shared projects" })).toHaveFocus();
  expect(
    screen.getByRole("button", { name: "Invite to project" }),
  ).toBeVisible();
  await user.keyboard("{Home}");
  expect(screen.getByRole("tab", { name: "Conversations" })).toHaveFocus();
  expect(
    screen.getByRole("button", { name: "New conversation" }),
  ).toBeVisible();
  await user.keyboard("{End}{ArrowLeft}");
  expect(people).toHaveFocus();
});

test("filters are contextual, dismiss with Escape, and restore focus", async () => {
  const user = userEvent.setup();
  render(<Workspace initial={{ view: "people" }} />);
  const filters = screen.getByRole("button", { name: "Filters", exact: true });
  expect(
    screen.queryByRole("button", { name: "Filter by project" }),
  ).toBeNull();
  act(() => filters.focus());
  await user.keyboard("{Enter}");
  const panel = await screen.findByRole("dialog", { name: "People filters" });
  await waitFor(() => expect(panel).toHaveFocus());
  await waitFor(() =>
    expect(
      within(panel).getByRole("button", { name: "Filter by project" }),
    ).toBeVisible(),
  );
  expect(
    within(panel).queryByRole("button", { name: "Filter by person" }),
  ).toBeNull();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(filters).toHaveFocus();
});

test("toolbar and cards share a single layout and pin preference writer", async () => {
  const user = userEvent.setup();
  render(<Workspace initial={{ view: "people" }} />);
  await screen.findByRole("button", { name: "Pin Bob" });
  expect(screen.getAllByRole("button", { name: "Grid view" })).toHaveLength(1);
  const grid = screen.getByRole("button", { name: "Grid view" });
  act(() => grid.focus());
  await user.keyboard("{Enter}");
  expect(grid).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Pin Bob" }));
  await waitFor(() =>
    expect(mockSavePreferences).toHaveBeenLastCalledWith(
      "workspace_collection_people_v1",
      JSON.stringify({ view: "grid", order: ["bob"] }),
    ),
  );
  expect(
    screen
      .getByRole("region", { name: "Pinned" })
      .querySelector('[role="list"]'),
  ).toHaveStyle({ display: "grid" });
});

test("project creation remains available inside the invitation picker", async () => {
  const user = userEvent.setup();
  render(<Workspace initial={{ view: "people" }} />);
  expect(screen.queryByRole("button", { name: "Create project" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Invite", exact: true }));
  const picker = await screen.findByRole("dialog", {
    name: "Choose a project to invite to",
  });
  await user.click(
    within(picker).getByRole("button", { name: "Create project" }),
  );
  expect(
    await screen.findByRole("dialog", { name: "Create project" }),
  ).toBeVisible();
});

test("People navigation uses shared projects, but inviting allows the first collaborator", async () => {
  const user = userEvent.setup();
  render(<Workspace />);
  expect(
    screen.getByRole("heading", { name: "People", level: 1 }),
  ).toBeVisible();
  const views = screen.getByRole("tablist", { name: "People views" });
  await user.click(within(views).getByRole("tab", { name: "Collaborators" }));
  await user.click(within(views).getByRole("tab", { name: "Shared projects" }));
  await waitFor(() =>
    expect(mockApi.listProjects).toHaveBeenLastCalledWith(
      expect.objectContaining({ shared_only: true }),
    ),
  );
  await user.click(within(views).getByRole("tab", { name: "Collaborators" }));
  await user.click(
    screen.getByRole("button", { name: "Filters", exact: true }),
  );
  await user.click(screen.getByRole("button", { name: "Filter by project" }));
  await waitFor(() =>
    expect(mockApi.listProjects).toHaveBeenLastCalledWith(
      expect.objectContaining({ shared_only: true, limit: 25 }),
    ),
  );
  await user.click(screen.getByRole("button", { name: "Cancel", exact: true }));
  await user.click(screen.getByRole("button", { name: "Invite", exact: true }));
  await waitFor(() =>
    expect(mockApi.listProjects).toHaveBeenLastCalledWith(
      expect.objectContaining({ shared_only: false, limit: 25 }),
    ),
  );
});

test.each(["New conversation", "Invite"])(
  "%s uses the reduced-motion modal portal",
  async (name) => {
    const user = userEvent.setup();
    render(
      <Workspace
        initial={{
          view: name === "Invite" ? "people" : "conversations",
          projectId: "geometry",
        }}
      />,
    );
    await user.click(screen.getByRole("button", { name, exact: true }));
    const dialogName = name === "Invite" ? "Invite collaborator" : name;
    const dialog = await screen.findByRole("dialog", {
      name: dialogName,
      exact: true,
    });
    expect(dialog.closest(".collaborators-modal")).not.toBeNull();
    act(() => dialog.focus());
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: dialogName }),
      ).not.toBeInTheDocument(),
    );
  },
);

test("inviting from a person's overview also offers projects not yet shared with that person", async () => {
  const user = userEvent.setup();
  render(<Workspace initial={{ view: "people", personId: "bob" }} />);
  await user.click(
    await screen.findByRole("button", {
      name: "Invite collaborator",
      exact: true,
    }),
  );
  await waitFor(() =>
    expect(mockApi.listProjects).toHaveBeenLastCalledWith(
      expect.objectContaining({
        shared_only: false,
        person_id: undefined,
        limit: 25,
      }),
    ),
  );
});

test("Collaborators renders existing account avatars", async () => {
  render(<Workspace initial={{ view: "people" }} />);
  expect(await screen.findByTestId("avatar-bob")).toBeVisible();
});

test("Shared projects uses both theme colors and passes image and icon to the shared avatar", async () => {
  const theme = {
    color: "#123456",
    accent_color: "#abcdef",
    icon: "rocket",
    image_blob: "image",
  };
  mockApi.listProjects.mockResolvedValue(
    page([
      { project_id: "geometry", title: "Geometry Lab", theme, role: "owner" },
    ]),
  );
  render(<Workspace initial={{ view: "projects" }} />);
  const avatar = await screen.findByTestId("project-theme");
  expect(JSON.parse(avatar.getAttribute("data-theme")!)).toEqual(theme);
  const card = avatar.closest("button")?.parentElement?.parentElement;
  expect(card).toHaveStyle({ borderColor: "#123456" });
  expect(card?.getAttribute("style")).toContain("#abcdef");
});

test("project Settings opens the shared drawer without leaving People", async () => {
  const user = userEvent.setup();
  render(<Workspace initial={{ view: "projects", projectId: "geometry" }} />);
  await user.click(
    await screen.findByRole("button", { name: "Settings", exact: true }),
  );
  expect(
    await screen.findByRole("dialog", { name: "Project settings" }),
  ).toHaveTextContent("geometry");
  expect(
    screen.getByRole("heading", { name: "People", level: 1 }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Close settings" }));
  expect(screen.queryByRole("dialog", { name: "Project settings" })).toBeNull();
});

test("keyboard opens a conversation and restores focus and search on back", async () => {
  const user = userEvent.setup();
  render(<Workspace />);
  const search = screen.getByRole("textbox", { name: "Search conversations" });
  await user.type(search, "Office");
  await waitFor(() =>
    expect(mockApi.listResources).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: "Office", limit: 50 }),
    ),
  );
  const row = await screen.findByRole("button", {
    name: /Office hours.*Geometry Lab/,
  });
  act(() => row.focus());
  await user.keyboard("{Enter}");
  expect(
    await screen.findByText(/Visible to collaborators in Geometry Lab/),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Selected collaboration")).toHaveFocus();
  expect(
    await screen.findByRole("textbox", { name: "Human message" }),
  ).toBeInTheDocument();
  act(() => screen.getByRole("button", { name: "Back to results" }).focus());
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(
      screen.queryByRole("textbox", { name: "Human message" }),
    ).not.toBeInTheDocument(),
  );
  expect(search).toHaveValue("Office");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /Office hours.*Geometry Lab/ }),
    ).toHaveFocus(),
  );
  expect(mockApi.ensureRoom).not.toHaveBeenCalled();
});

test.each(["Escape", "Cancel"])(
  "picker restores focus after %s from inside the dialog",
  async (close) => {
    const user = userEvent.setup();
    render(<Workspace />);
    const trigger = screen.getByRole("button", {
      name: "Filters",
      exact: true,
    });
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Filter by project" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Filter by project",
    });
    expect(dialog.closest(".collaborators-modal")).not.toBeNull();
    const search = within(dialog).getByRole("textbox", {
      name: "Search projects",
    });
    act(() => search.focus());
    expect(search).toHaveFocus();
    if (close === "Escape") await user.keyboard("{Escape}");
    else {
      act(() => within(dialog).getByRole("button", { name: "Cancel" }).focus());
      await user.keyboard("{Enter}");
    }
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Filter by project" }));
    const project = await within(await screen.findByRole("dialog")).findByRole(
      "button",
      { name: "Geometry Lab" },
    );
    project.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(mockApi.listResources).toHaveBeenLastCalledWith(
        expect.objectContaining({ project_id: "geometry" }),
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Filters", exact: true }),
      ).toHaveFocus(),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Clear project filter: Geometry Lab",
      }),
    );
    await waitFor(() =>
      expect(mockApi.listResources).toHaveBeenLastCalledWith(
        expect.objectContaining({ project_id: undefined }),
      ),
    );
    expect(trigger).toHaveFocus();
  },
);

test("shows indexing coverage, cursor paging, and errors without fabricating empty success", async () => {
  const user = userEvent.setup();
  mockApi.listResources
    .mockResolvedValueOnce(
      page([conversation], {
        coverage: "partial",
        coverage_message: "Legacy sources pending",
        next: "cursor",
      }),
    )
    .mockRejectedValueOnce(Error("Directory offline"));
  render(<Workspace />);
  expect(await screen.findByText("About these results")).toBeInTheDocument();
  expect(screen.getByText("Legacy sources pending")).toBeInTheDocument();
  const next = screen.getByRole("button", { name: "Next" });
  next.focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Directory offline",
  );
  expect(mockApi.listResources).toHaveBeenLastCalledWith(
    expect.objectContaining({ after: "cursor", limit: 50 }),
  );
  expect(
    screen.queryByRole("button", { name: /Office hours.*Geometry Lab/ }),
  ).not.toBeInTheDocument();
});

test("account changes unmount selected content and ignore late metadata", async () => {
  let resolve!: (value: unknown) => void;
  mockApi.getResource.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const props = {
    active: true,
    view: "conversations" as const,
    projectId: "geometry",
    resourceKind: "conversation" as const,
    resourceId: "office-hours",
    onNavigate: jest.fn(),
  };
  const { rerender } = render(
    <CollaboratorsPage accountId="alice" {...props} />,
  );
  await waitFor(() => expect(mockApi.getResource).toHaveBeenCalledTimes(1));
  mockAccount = "bob";
  rerender(
    <CollaboratorsPage
      accountId="bob"
      active
      view="people"
      onNavigate={jest.fn()}
    />,
  );
  await act(async () => resolve(conversation));
  expect(
    screen.queryByRole("textbox", { name: "Human message" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText(/Visible to collaborators/),
  ).not.toBeInTheDocument();
});

test("malformed links show an accessible error without querying the directory", () => {
  render(
    <CollaboratorsPage
      accountId="alice"
      active
      routeError="Malformed resource reference"
      onNavigate={jest.fn()}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Malformed resource reference",
  );
  expect(mockApi.listResources).not.toHaveBeenCalled();
});

test("retained inactive overlays hide fallback notices and unmount selected content", async () => {
  const props = {
    accountId: "alice",
    active: true,
    view: "conversations" as const,
    projectId: "geometry",
    resourceKind: "conversation" as const,
    resourceId: "office-hours",
    onNavigate: jest.fn(),
  };
  const { rerender } = render(<CollaboratorsPage {...props} />);
  await screen.findByRole("textbox", { name: "Human message" });
  rerender(<CollaboratorsPage {...props} active={false} />);
  expect(
    screen.queryByRole("textbox", { name: "Human message" }),
  ).not.toBeInTheDocument();
  rerender(
    <CollaboratorsPage {...props} active={false} routeError="Malformed" />,
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  mockAccount = "bob";
  rerender(<CollaboratorsPage {...props} active={false} />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

test("same-project role downgrades invalidate the selected runtime, not just project-id removals", async () => {
  mockProjects = fromJS({
    geometry: { users: { alice: { group: "collaborator" } } },
  });
  const props = {
    accountId: "alice",
    active: true,
    view: "conversations" as const,
    projectId: "geometry",
    resourceKind: "conversation" as const,
    resourceId: "office-hours",
    onNavigate: jest.fn(),
  };
  const { rerender } = render(<CollaboratorsPage {...props} />);
  await screen.findByRole("textbox", { name: "Human message" });
  mockApi.getResource.mockResolvedValue(null);
  mockProjects = fromJS({
    geometry: { users: { alice: { group: "viewer" } } },
  });
  rerender(<CollaboratorsPage {...props} />);
  expect(
    screen.queryByRole("textbox", { name: "Human message" }),
  ).not.toBeInTheDocument();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "no longer have access",
  );
});

test("My collection includes agent and artifact shortcuts without changing follow state", async () => {
  const user = userEvent.setup();
  render(<Workspace />);
  await user.click(
    screen.getByRole("button", { name: "Filters", exact: true }),
  );
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Show" }),
    "collected",
  );
  await waitFor(() =>
    expect(mockApi.listResources).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: undefined,
        scope: "collected",
        limit: 50,
      }),
    ),
  );
  expect(mockApi.setPersonalState).not.toHaveBeenCalled();
});

test("project views bind server filters, reset cursors, and preserve view on detail back", async () => {
  const user = userEvent.setup();
  const project = {
    project_id: "geometry",
    title: "Geometry Lab",
    description: "Research",
    role: "owner",
    pinned: true,
  };
  mockApi.listProjects.mockResolvedValue(page([project], { next: "page-two" }));
  render(<Workspace initial={{ view: "projects" }} />);
  await screen.findByRole("button", { name: /Geometry Lab Research/ });
  const next = screen.getByRole("button", { name: "Next", exact: true });
  next.focus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(mockApi.listProjects).toHaveBeenLastCalledWith(
      expect.objectContaining({ view: "recent", after: "page-two", limit: 50 }),
    ),
  );
  await user.click(
    screen.getByRole("button", { name: "Filters", exact: true }),
  );
  const pinned = screen.getByRole("button", {
    name: "Pinned projects",
    exact: true,
  });
  pinned.focus();
  await user.keyboard("{Enter}");
  expect(pinned).toHaveAttribute("aria-pressed", "true");
  expect(pinned).toHaveFocus();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(mockApi.listProjects).toHaveBeenLastCalledWith(
      expect.objectContaining({ view: "pinned", after: undefined, limit: 50 }),
    ),
  );
  await user.type(
    screen.getByRole("textbox", { name: "Search projects" }),
    "Geometry",
  );
  await waitFor(() =>
    expect(mockApi.listProjects).toHaveBeenLastCalledWith(
      expect.objectContaining({ view: "pinned", search: "Geometry" }),
    ),
  );
  const row = await screen.findByRole("button", {
    name: /Geometry Lab Research/,
  });
  row.focus();
  await user.keyboard("{Enter}");
  const back = await screen.findByRole("button", { name: "Back to results" });
  back.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(row).toHaveFocus());
  expect(
    screen.getByRole("button", {
      name: "Clear pinned projects filter: Pinned projects",
    }),
  ).toBeInTheDocument();
  expect(mockApi.ensureRoom).not.toHaveBeenCalled();
});

test("keyboard pin and unpin refresh bounded results and restore focus after removal", async () => {
  const user = userEvent.setup();
  let pinned = false;
  mockApi.listProjects.mockImplementation(async (opts) =>
    page(
      opts.view === "pinned" && !pinned
        ? []
        : [
            {
              project_id: "geometry",
              title: "Geometry Lab",
              description: "Research",
              role: "owner",
              pinned,
            },
          ],
    ),
  );
  mockApi.setProjectPinned.mockImplementation(async (opts) => {
    pinned = opts.pinned;
    return { pinned };
  });
  render(<Workspace initial={{ view: "projects" }} />);
  const pin = await screen.findByRole("button", {
    name: "Pin project Geometry Lab",
  });
  pin.focus();
  await user.keyboard("{Enter}");
  const unpin = await screen.findByRole("button", {
    name: "Unpin project Geometry Lab",
  });
  await waitFor(() => expect(unpin).toHaveFocus());
  expect(mockApi.setProjectPinned).toHaveBeenCalledWith({
    project_id: "geometry",
    pinned: true,
  });
  await user.click(
    screen.getByRole("button", { name: "Filters", exact: true }),
  );
  await user.click(
    screen.getByRole("button", { name: "Pinned projects", exact: true }),
  );
  await user.keyboard("{Escape}");
  const remove = await screen.findByRole("button", {
    name: "Unpin project Geometry Lab",
  });
  remove.focus();
  await user.keyboard(" ");
  await screen.findByText(/No pinned projects match/);
  await waitFor(() =>
    expect(screen.getByLabelText("People results")).toHaveFocus(),
  );
  expect(mockApi.setPersonalState).not.toHaveBeenCalled();
  expect(mockApi.ensureRoom).not.toHaveBeenCalled();
});

test("changed-favorites cursor errors offer a keyboard-operable restart without dropping filters", async () => {
  const user = userEvent.setup();
  mockApi.listProjects
    .mockResolvedValueOnce(page([], { next: "obsolete" }))
    .mockRejectedValueOnce(
      Error("invalid collaboration cursor; restart paging"),
    )
    .mockResolvedValue(page([]));
  render(<Workspace initial={{ view: "projects" }} />);
  const next = await screen.findByRole("button", { name: "Next", exact: true });
  next.focus();
  await user.keyboard("{Enter}");
  const restart = await screen.findByRole("button", {
    name: "Restart results",
  });
  restart.focus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(mockApi.listProjects).toHaveBeenLastCalledWith(
      expect.objectContaining({ view: "recent", after: undefined }),
    ),
  );
  expect(screen.getByLabelText("People results")).toHaveFocus();
});

test("participant totals do not treat a bounded preview as the full audience", async () => {
  mockApi.listResources.mockResolvedValue(
    page([
      { ...conversation, participant_count: 120, participants_truncated: true },
    ]),
  );
  render(<Workspace />);
  expect(
    await screen.findByRole("button", {
      name: /120 participants \(partial participant preview\)/,
    }),
  ).toBeInTheDocument();
});

test("selected-resource lease resets reauthorize in place, preserve composer focus, and revoke without navigation", async () => {
  jest.useFakeTimers();
  const navigate = jest.fn();
  let resolveRefresh!: (value: unknown) => void;
  mockApi.check
    .mockResolvedValueOnce({
      revision: "baseline",
      reset: true,
      poll_after_ms: 5000,
    })
    .mockResolvedValueOnce({
      revision: "renewed",
      reset: false,
      poll_after_ms: 5000,
    })
    .mockResolvedValue({
      revision: "lease-expired",
      reset: true,
      poll_after_ms: 5000,
    });
  mockApi.getResource
    .mockResolvedValueOnce(conversation)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    )
    .mockResolvedValueOnce(null);
  const view = render(
    <CollaboratorsPage
      accountId="alice"
      active
      view="conversations"
      projectId="geometry"
      resourceKind="conversation"
      resourceId="office-hours"
      onNavigate={navigate}
    />,
  );
  try {
    const composer = await screen.findByRole("textbox", {
      name: "Human message",
    });
    composer.focus();
    fireEvent.change(composer, { target: { value: "unsent draft" } });
    await act(() => jest.advanceTimersByTimeAsync(5000));
    expect(mockApi.getResource).toHaveBeenCalledTimes(1);
    expect(composer).toHaveFocus();
    await act(() => jest.advanceTimersByTimeAsync(5000));
    expect(mockApi.getResource).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("textbox", { name: "Human message" })).toBe(
      composer,
    );
    expect(composer).toHaveFocus();
    await act(async () =>
      resolveRefresh({ ...conversation, title: "New title", activity: 3 }),
    );
    expect(screen.getByRole("textbox", { name: "Human message" })).toBe(
      composer,
    );
    expect(composer).toHaveValue("unsent draft");
    expect(composer).toHaveFocus();
    await act(() => jest.advanceTimersByTimeAsync(5000));
    expect(mockApi.getResource).toHaveBeenCalledTimes(3);
    expect(
      screen.queryByRole("textbox", { name: "Human message" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "no longer have access",
    );
    expect(
      screen.getByRole("button", { name: "Back to results" }),
    ).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    jest.useRealTimers();
  }
});
