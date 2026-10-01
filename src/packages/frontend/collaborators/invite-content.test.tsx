import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InviteContentButton } from "./invite-content";
import type { InviteProjectsDraft } from "./invitation-api";

let mockAccountId = "alice";
const mockGetResource = jest.fn();
const mockInvite = jest.fn();
const mockCreator = jest.fn();
let mockDraft: InviteProjectsDraft;
const createdProjectId = "33333333-3333-4333-8333-333333333333";
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => mockAccountId,
  redux: { getActions: () => ({}) },
}));
jest.mock("@cocalc/frontend/components/icon", () => ({ Icon: () => null }));
jest.mock("./workspace-api", () => ({
  boundCollaboratorsApi: () => ({ getResource: mockGetResource }),
}));
jest.mock("./invite-projects", () => ({
  InviteProjects: (props) => {
    mockInvite(props);
    return (
      <div
        role="dialog"
        aria-label="Invite a person"
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onClose();
        }}
      >
        <button autoFocus onClick={props.onClose}>
          Close invitation
        </button>
        {props.onCreateProject && (
          <button
            onClick={() =>
              props.onCreateProject(
                (props.initialDraft ?? mockDraft).projects.map(
                  ({ project_id }) => project_id,
                ),
                props.initialDraft ?? mockDraft,
              )
            }
          >
            Create a new project together
          </button>
        )}
      </div>
    );
  },
}));
jest.mock("@cocalc/frontend/projects/create-project", () => ({
  NewProjectCreator: (props) => {
    mockCreator(props);
    return (
      <div
        role="dialog"
        aria-label="Create project"
        onKeyDown={(event) => {
          if (event.key === "Escape") props.onClose();
        }}
      >
        <button autoFocus onClick={props.onClose}>
          Cancel project creation
        </button>
        <button
          onClick={() => {
            props.onCreated(createdProjectId);
            props.onClose();
          }}
        >
          Create project
        </button>
      </div>
    );
  },
}));

const resource = {
  project_id: "22222222-2222-4222-8222-222222222222",
  kind: "agent" as const,
  resource_id: "agent-thread:native",
  title: "Research",
};
beforeEach(() => {
  jest.clearAllMocks();
  mockAccountId = "alice";
  mockGetResource.mockResolvedValue(resource);
  mockDraft = {
    recipientQuery: "friend@example.com",
    recipient: {
      kind: "email",
      email_address: "friend@example.com",
      label: "Friend",
    },
    projects: [
      {
        project_id: resource.project_id,
        action: "offer_access",
        role: "viewer",
        read_policy: { rules: [{ action: "include", path: "/notes" }] },
      },
    ],
    message: "Please review these notes",
    target: {
      project_id: resource.project_id,
      resource_id: resource.resource_id,
      kind: resource.kind,
      label: "Edited invitation label",
    },
    channels: { notification: false, email: true },
    createdProjectIds: [],
  };
});

test("keyboard entry rechecks access then supplies typed target to the shared modal and restores focus", async () => {
  const user = userEvent.setup();
  const parent = jest.fn();
  render(
    <div onClick={parent}>
      <InviteContentButton source={resource} title="Research" />
    </div>,
  );
  const trigger = screen.getByRole("button", {
    name: "Invite to collaborate on Research",
  });
  expect(mockGetResource).not.toHaveBeenCalled();
  await user.tab();
  expect(trigger).toHaveFocus();
  await user.keyboard("{Enter}");
  await screen.findByRole("dialog", { name: "Invite a person" });
  expect(mockInvite).toHaveBeenLastCalledWith(
    expect.objectContaining({
      initialProjectIds: [resource.project_id],
      target: {
        project_id: resource.project_id,
        resource_id: resource.resource_id,
        kind: "agent",
        label: "Research",
      },
    }),
  );
  expect(parent).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Close invitation" }),
  ).toHaveFocus();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("background resource metadata changes preserve the open invitation", async () => {
  const user = userEvent.setup();
  const view = render(
    <InviteContentButton source={resource} title="Research" />,
  );
  await user.click(
    screen.getByRole("button", { name: /Invite to collaborate/ }),
  );
  await screen.findByRole("dialog");
  view.rerender(
    <InviteContentButton
      source={{ ...resource, title: "Updated" }}
      title="Updated"
    />,
  );
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(mockGetResource).toHaveBeenCalledTimes(1);
});

test("account switches discard late authorization responses", async () => {
  let resolve;
  mockGetResource.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const user = userEvent.setup();
  const view = render(
    <InviteContentButton source={resource} title="Research" />,
  );
  await user.click(
    screen.getByRole("button", { name: /Invite to collaborate/ }),
  );
  await waitFor(() => expect(mockGetResource).toHaveBeenCalledTimes(1));
  mockAccountId = "bob";
  view.rerender(<InviteContentButton source={resource} title="Research" />);
  await act(async () => resolve(resource));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("lost access announces an error without opening the invitation", async () => {
  mockGetResource.mockResolvedValue(null);
  const user = userEvent.setup();
  render(<InviteContentButton source={resource} title="Research" />);
  await user.click(
    screen.getByRole("button", { name: /Invite to collaborate/ }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "no longer have access",
  );
  expect(mockInvite).not.toHaveBeenCalled();
});

async function openCreation(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("button", { name: /Invite to collaborate/ }),
  );
  const create = await screen.findByRole("button", {
    name: "Create a new project together",
  });
  create.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("dialog", { name: "Create project" });
  expect(
    screen.queryByRole("dialog", { name: "Invite a person" }),
  ).not.toBeInTheDocument();
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(
    screen.getByRole("button", { name: "Cancel project creation" }),
  ).toHaveFocus();
}

test("creation cancel returns to the same editable invitation without stacking dialogs", async () => {
  const user = userEvent.setup();
  render(<InviteContentButton source={resource} title="Research" />);
  await openCreation(user);
  expect(mockCreator).toHaveBeenLastCalledWith(
    expect.objectContaining({
      default_value: "",
      open: true,
      onCreated: expect.any(Function),
    }),
  );
  await user.keyboard("{Escape}");
  await screen.findByRole("dialog", { name: "Invite a person" });
  expect(mockInvite).toHaveBeenLastCalledWith(
    expect.objectContaining({
      initialProjectIds: [resource.project_id],
      initialDraft: mockDraft,
    }),
  );
  expect(
    screen.getByRole("button", { name: "Close invitation" }),
  ).toHaveFocus();
  expect(
    screen.queryByRole("dialog", { name: "Create project" }),
  ).not.toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /Invite to collaborate/ }),
    ).toHaveFocus(),
  );
  expect(mockGetResource).toHaveBeenCalledTimes(1);
});

test("creation followed by close preserves the new project and all draft intent without sending", async () => {
  const user = userEvent.setup();
  render(<InviteContentButton source={resource} title="Research" />);
  await openCreation(user);
  await user.tab();
  expect(screen.getByRole("button", { name: "Create project" })).toHaveFocus();
  await user.keyboard("{Enter}");
  await screen.findByRole("dialog", { name: "Invite a person" });
  expect(mockInvite).toHaveBeenLastCalledWith(
    expect.objectContaining({
      initialProjectIds: [resource.project_id, createdProjectId],
      initialDraft: { ...mockDraft, createdProjectIds: [createdProjectId] },
    }),
  );
  expect(mockGetResource).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByRole("dialog", { name: "Create project" }),
  ).not.toBeInTheDocument();
  // Closing the whole invitation starts a fresh draft, not an implicit retry.
  await user.keyboard("{Escape}");
  await user.click(
    screen.getByRole("button", { name: /Invite to collaborate/ }),
  );
  await screen.findByRole("dialog", { name: "Invite a person" });
  expect(mockInvite).toHaveBeenLastCalledWith(
    expect.objectContaining({
      initialProjectIds: [resource.project_id],
      initialDraft: undefined,
    }),
  );
});

test("a creation handoff does not restore intentionally removed content context", async () => {
  mockDraft = { ...mockDraft, target: undefined };
  const user = userEvent.setup();
  render(<InviteContentButton source={resource} title="Research" />);
  await openCreation(user);
  await user.keyboard("{Escape}");
  await screen.findByRole("dialog", { name: "Invite a person" });
  expect(mockInvite).toHaveBeenLastCalledWith(
    expect.objectContaining({ initialDraft: mockDraft, target: undefined }),
  );
});

test("account changes discard creation drafts and ignore late creator callbacks", async () => {
  const user = userEvent.setup();
  const view = render(
    <InviteContentButton source={resource} title="Research" />,
  );
  await openCreation(user);
  const previousCreator = mockCreator.mock.calls.at(-1)![0];
  mockAccountId = "bob";
  view.rerender(<InviteContentButton source={resource} title="Research" />);
  await act(async () => {
    previousCreator.onCreated(createdProjectId);
    previousCreator.onClose();
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: /Invite to collaborate/ }),
  );
  await screen.findByRole("dialog", { name: "Invite a person" });
  expect(mockInvite).toHaveBeenLastCalledWith(
    expect.objectContaining({
      initialDraft: undefined,
      initialProjectIds: [resource.project_id],
    }),
  );
});
