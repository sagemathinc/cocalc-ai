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
const mockApi = {
  check: jest.fn(),
  listPeople: jest.fn(),
  listProjects: jest.fn(),
  listResources: jest.fn(),
  getResource: jest.fn(),
  setPersonalState: jest.fn(),
  ensureRoom: jest.fn(),
};
jest.mock("./workspace-api", () => ({ boundCollaboratorsApi: () => mockApi }));
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (store: string) =>
    store === "account" ? mockAccount : mockProjects,
  redux: { getActions: () => ({ erase_active_key_handler: jest.fn() }) },
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
    const trigger = screen.getByRole("button", { name: "Filter by project" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", {
      name: "Filter by project",
    });
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
        screen.getByRole("button", { name: "Change project filter" }),
      ).toHaveFocus(),
    );
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
  expect(await screen.findByText("Partial coverage")).toBeInTheDocument();
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
