import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import type {
  PeopleInvitationDraft,
  PeopleInvitationOperation,
  PeopleInvitationTarget,
} from "@cocalc/util/people-invitations";
import type {
  InvitationApi,
  InvitationProject,
  InviteProjectsDraft,
} from "./invitation-api";
import { InviteProjects } from "./invite-projects";

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => ({ erase_active_key_handler: jest.fn() }) },
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: { account_id: "me" },
}));
jest.mock("./invitations-api", () => ({ boundInvitationsApi: jest.fn() }));

const person = { account_id: "person", display_name: "Bella" };
const target: PeopleInvitationTarget = {
  project_id: "first",
  kind: "artifact",
  resource_id: "notebook",
  label: "Prime numbers",
};
const first: InvitationProject = {
  project_id: "first",
  title: "First project",
  current_access: "none",
  content_access: "unknown",
  can_invite: true,
  can_notify: false,
};
const second: InvitationProject = {
  ...first,
  project_id: "second",
  title: "Second project",
};

function makeApi(projects = [first, second]) {
  let draft: PeopleInvitationDraft;
  let result: PeopleInvitationOperation;
  const api = {
    resolveRecipient: jest.fn(async () => ({
      recipients: [
        {
          kind: "account" as const,
          account_id: "person",
          label: "Bella",
          username: "bella",
        },
      ],
    })),
    listProjects: jest.fn(async () => ({ projects })),
    prepareInvitation: jest.fn(async (input) => {
      draft = {
        draft_id: input.draft_id,
        revision: input.expected_revision + 1,
        account_id: "me",
        payload: input.payload,
        preflight: input.payload.projects.map((p) => ({
          project_id: p.project_id,
          action: p.action,
          recipient_access: p.action === "notify" ? "sufficient" : "unknown",
          warnings: [],
        })),
        created_at: Date.now(),
        expires_at: Date.now() + 600000,
      };
      return draft;
    }),
    reviewInvitation: jest.fn(async () => ({
      review_id: `review-${draft.revision}`,
      draft,
      expires_at: Date.now() + 600000,
    })),
    sendInvitation: jest.fn(async (input) => {
      result = {
        operation_id: input.idempotency_key,
        account_id: "me",
        draft_id: input.draft_id,
        revision: input.revision,
        payload: draft.payload,
        status: "complete",
        outcomes: draft.payload.projects.map((p) => ({
          project_id: p.project_id,
          child_operation_id: p.project_id,
          action: p.action,
          status: p.action === "notify" ? "notified" : "created",
          delivery: [
            { channel: "notification", status: "queued" },
            { channel: "email", status: "suppressed" },
          ],
        })),
        created_at: Date.now(),
        updated_at: Date.now(),
        source_version: 1,
      };
      return result;
    }),
    getInvitationOperation: jest.fn(async () => result),
  } satisfies InvitationApi;
  return api;
}

async function continuePerson(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Continue with Bella" }));
}
async function reviewAndSend(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("button", { name: "Review exact invitation" }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Send reviewed invitation" }),
  );
}

it("is person-first, uses keyboard selection, and sends only the exact reviewed revision", async () => {
  const user = userEvent.setup();
  const api = makeApi();
  render(<InviteProjects api={api} onClose={jest.fn()} />);
  expect(screen.queryByRole("table")).toBeNull();
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "Choose person" }),
    ).toHaveFocus(),
  );
  await user.tab();
  expect(
    screen.getByRole("textbox", { name: "Email, name, or @username" }),
  ).toHaveFocus();
  await user.keyboard("@bella{Enter}");
  await user.click(
    await screen.findByRole("button", { name: "Choose Bella (@bella)" }),
  );
  expect(api.resolveRecipient).toHaveBeenCalledWith({ query: "@bella" });
  expect(api.prepareInvitation).not.toHaveBeenCalled();
  const select = screen.getByRole("checkbox", { name: "Select First project" });
  act(() => select.focus());
  await user.keyboard(" ");
  await user.type(
    screen.getByRole("textbox", { name: "Invitation message" }),
    "Please review this work",
  );
  await user.click(
    screen.getByRole("button", { name: "Review exact invitation" }),
  );
  const exact = await screen.findByRole("region", {
    name: "Exact reviewed invitation",
  });
  expect(exact).toHaveTextContent("Please review this work");
  expect(exact).toHaveTextContent("project read/write and runtimes");
  expect(api.sendInvitation).not.toHaveBeenCalled();
  expect(api.prepareInvitation.mock.lastCall![0].payload.recipient).toEqual({
    kind: "account",
    account_id: "person",
  });
  await user.click(
    screen.getByRole("button", { name: "Send reviewed invitation" }),
  );
  expect(api.sendInvitation).toHaveBeenCalledWith({
    draft_id: api.prepareInvitation.mock.lastCall![0].draft_id,
    revision: 1,
    review_id: "review-1",
    idempotency_key: expect.any(String),
  });
  expect(
    await screen.findByRole("region", { name: "Durable invitation outcomes" }),
  ).toHaveTextContent("Invitation created");
  expect(screen.getByText("Notification queued")).toBeVisible();
  expect(screen.getByText("No email sent")).toBeVisible();
});

it("never resolves an email to an account and shows unknown membership", async () => {
  const user = userEvent.setup();
  const api = makeApi([{ ...first, current_access: "unknown" }]);
  render(<InviteProjects api={api} onClose={jest.fn()} />);
  await user.type(
    screen.getByRole("textbox", { name: "Email, name, or @username" }),
    "new@example.com{Enter}",
  );
  await user.click(
    screen.getByRole("button", { name: "Choose new@example.com" }),
  );
  expect(api.resolveRecipient).not.toHaveBeenCalled();
  expect(
    screen.getByText("Current access unknown for this email/contact"),
  ).toBeVisible();
  await user.click(
    screen.getByRole("checkbox", { name: "Select First project" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Review exact invitation" }),
  );
  expect(api.prepareInvitation.mock.lastCall![0].payload.recipient).toEqual({
    kind: "email",
    email_address: "new@example.com",
  });
});

it("skips unnecessary project selection for existing collaborator content and preserves notification-only intent", async () => {
  const user = userEvent.setup();
  const api = makeApi([
    {
      ...first,
      current_access: "collaborator",
      content_access: "allowed",
      can_notify: true,
    },
  ]);
  render(
    <InviteProjects
      api={api}
      person={person}
      target={target}
      onClose={jest.fn()}
    />,
  );
  await continuePerson(user);
  expect(
    await screen.findByRole("heading", { name: "Review invitation" }),
  ).toHaveFocus();
  expect(screen.queryByRole("table")).toBeNull();
  const payload = api.prepareInvitation.mock.lastCall![0].payload;
  expect(payload.target).toEqual(target);
  expect(payload.projects).toEqual([{ project_id: "first", action: "notify" }]);
  await user.type(
    screen.getByRole("textbox", { name: "Invitation message" }),
    "What do you think?",
  );
  expect(
    screen.queryByRole("button", { name: "Send reviewed invitation" }),
  ).toBeNull();
  await reviewAndSend(user);
  expect(api.sendInvitation.mock.lastCall![0].review_id).toBe("review-2");
  expect(
    screen.getByRole("region", { name: "Durable invitation outcomes" }),
  ).toHaveTextContent("no access change");
});

it("does not silently upgrade a viewer who cannot open the content", async () => {
  const user = userEvent.setup();
  const api = makeApi([
    {
      ...first,
      current_access: "viewer",
      content_access: "denied",
      can_notify: false,
      read_policy: { rules: [{ action: "include", path: "public/**" }] },
    },
  ]);
  render(
    <InviteProjects
      api={api}
      person={person}
      target={target}
      onClose={jest.fn()}
    />,
  );
  await continuePerson(user);
  expect(
    screen.getByRole("button", { name: "Review exact invitation" }),
  ).toBeDisabled();
  expect(
    screen.getByText(
      "Current access does not allow opening the intended content.",
    ),
  ).toBeVisible();
  expect(api.prepareInvitation).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", {
      name: "Offer collaborator access to First project",
    }),
  );
  await user.click(
    screen.getByRole("button", { name: "Review exact invitation" }),
  );
  expect(api.prepareInvitation.mock.lastCall![0].payload.projects).toEqual([
    { project_id: "first", action: "offer_access", role: "collaborator" },
  ]);
});

it("preserves recipient, message, roles, source target and selections through explicit creation", async () => {
  const user = userEvent.setup();
  const api = makeApi();
  const create = jest.fn();
  const view = render(
    <InviteProjects
      api={api}
      person={person}
      target={target}
      onClose={jest.fn()}
      onCreateProject={create}
    />,
  );
  await continuePerson(user);
  await user.type(
    screen.getByRole("textbox", { name: "Invitation message" }),
    "Draft survives",
  );
  await user.click(
    screen.getByRole("button", { name: "Create a new project together" }),
  );
  expect(api.prepareInvitation).not.toHaveBeenCalled();
  const [selected, draft] = create.mock.lastCall as [
    string[],
    InviteProjectsDraft,
  ];
  expect(selected).toEqual(["first"]);
  expect(draft.message).toBe("Draft survives");
  expect(draft.target).toEqual(target);
  expect(draft).not.toHaveProperty("review_id");
  view.unmount();
  api.listProjects.mockResolvedValue({
    projects: [
      first,
      { ...second, project_id: "created", title: "Created project" },
    ],
  });
  render(
    <InviteProjects
      api={api}
      initialDraft={draft}
      initialProjectIds={[...selected, "created"]}
      createdProjectId="created"
      onClose={jest.fn()}
    />,
  );
  expect(
    screen.getByRole("region", { name: "Created projects" }),
  ).toHaveTextContent("No content was copied");
  await continuePerson(user);
  expect(
    screen.getByRole("textbox", { name: "Invitation message" }),
  ).toHaveValue("Draft survives");
  expect(
    screen.getByRole("checkbox", { name: "Select First project" }),
  ).toBeChecked();
  expect(
    screen.getByRole("checkbox", { name: "Select Created project" }),
  ).toBeChecked();
  expect(api.sendInvitation).not.toHaveBeenCalled();
});

it("keeps selection and message across project pages and refreshes without moving focus", async () => {
  const user = userEvent.setup();
  const api = makeApi();
  api.listProjects
    .mockResolvedValueOnce({ projects: [first], next_cursor: "next" } as any)
    .mockResolvedValue({ projects: [second] });
  render(
    <InviteProjects
      api={api}
      person={person}
      initialProjectIds={["first"]}
      onClose={jest.fn()}
    />,
  );
  await continuePerson(user);
  await user.type(
    screen.getByRole("textbox", { name: "Invitation message" }),
    "Keep draft",
  );
  await user.click(screen.getByRole("button", { name: "Next projects" }));
  expect(api.listProjects).toHaveBeenLastCalledWith(
    expect.objectContaining({ cursor: "next" }),
  );
  expect(
    screen.getByRole("button", { name: "Remove First project" }),
  ).toBeVisible();
  expect(
    screen.getByRole("textbox", { name: "Invitation message" }),
  ).toHaveValue("Keep draft");
  const refresh = screen.getByRole("button", { name: "Refresh projects" });
  await user.click(refresh);
  expect(refresh).toHaveFocus();
  expect(api.sendInvitation).not.toHaveBeenCalled();
});

it("inspects unknown sends by their stable operation ID without resending", async () => {
  const user = userEvent.setup();
  const api = makeApi();
  api.sendInvitation.mockRejectedValueOnce(Error("timeout"));
  api.getInvitationOperation.mockRejectedValueOnce(
    Error("temporarily offline"),
  );
  render(
    <InviteProjects
      api={api}
      person={person}
      initialProjectIds={["first"]}
      onClose={jest.fn()}
    />,
  );
  await continuePerson(user);
  await reviewAndSend(user);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Send outcome unknown",
  );
  expect(
    screen.queryByRole("button", { name: "Retry same reviewed send" }),
  ).toBeNull();
  const sent = api.sendInvitation.mock.lastCall![0];
  await user.click(
    screen.getByRole("button", { name: "Check delivery and operation status" }),
  );
  expect(api.getInvitationOperation).toHaveBeenCalledWith({
    operation_id: sent.idempotency_key,
  });
  expect(api.sendInvitation).toHaveBeenCalledTimes(1);
  await user.click(
    screen.getByRole("button", { name: "Retry same reviewed send" }),
  );
  expect(api.sendInvitation).toHaveBeenLastCalledWith(sent);
});

it("re-reviews only confirmed failed projects and keeps successful outcomes visible", async () => {
  const user = userEvent.setup();
  const api = makeApi();
  const normalSend = api.sendInvitation.getMockImplementation()!;
  api.sendInvitation.mockImplementationOnce(async (input) => {
    const op = await normalSend(input);
    return {
      ...op,
      status: "partial",
      outcomes: op.outcomes.map((receipt) =>
        receipt.project_id === "second"
          ? { ...receipt, status: "failed" }
          : receipt,
      ),
    };
  });
  render(
    <InviteProjects
      api={api}
      person={person}
      initialProjectIds={["first", "second"]}
      onClose={jest.fn()}
    />,
  );
  await continuePerson(user);
  await reviewAndSend(user);
  await user.click(
    screen.getByRole("button", { name: "Review failed projects only" }),
  );
  expect(
    screen.getByRole("region", { name: "Durable invitation outcomes" }),
  ).toHaveTextContent("First project: Invitation created");
  await user.click(
    screen.getByRole("button", { name: "Review exact invitation" }),
  );
  expect(api.prepareInvitation.mock.lastCall![0].payload.projects).toEqual([
    { project_id: "second", action: "offer_access", role: "collaborator" },
  ]);
  expect(api.sendInvitation).toHaveBeenCalledTimes(1);
});

it("blocks dismissal while sending and restores focus when closed", async () => {
  const user = userEvent.setup();
  const api = makeApi();
  let finish!: (value: PeopleInvitationOperation) => void;
  const normalSend = api.sendInvitation.getMockImplementation()!;
  api.sendInvitation.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  function Harness() {
    const [open, setOpen] = React.useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Invite person</button>
        {open && (
          <InviteProjects
            api={api}
            person={person}
            initialProjectIds={["first"]}
            onClose={() => setOpen(false)}
          />
        )}
      </>
    );
  }
  render(<Harness />);
  const opener = screen.getByRole("button", { name: "Invite person" });
  await user.click(opener);
  await continuePerson(user);
  await reviewAndSend(user);
  expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  fireEvent.keyDown(
    screen.getByRole("heading", { name: "Invitation results" }),
    { key: "Escape" },
  );
  expect(screen.getByRole("dialog")).toBeVisible();
  await act(async () =>
    finish(await normalSend(api.sendInvitation.mock.lastCall![0])),
  );
  await user.keyboard("{Escape}");
  await waitFor(() => expect(opener).toHaveFocus());
});

it("retains a viewer's notify-only action when current access permits the target", async () => {
  const user = userEvent.setup();
  const api = makeApi([
    {
      ...first,
      current_access: "viewer",
      content_access: "allowed",
      can_notify: true,
    },
  ]);
  render(
    <InviteProjects
      api={api}
      person={person}
      target={target}
      onClose={jest.fn()}
    />,
  );
  await continuePerson(user);
  expect(api.prepareInvitation.mock.lastCall![0].payload.projects).toEqual([
    { project_id: "first", action: "notify" },
  ]);
  expect(
    within(
      screen.getByRole("region", { name: "Exact reviewed invitation" }),
    ).getByText(/Notification only/),
  ).toBeVisible();
});

it("requires a new review after expiry and never sends with the expired review id", async () => {
  const user = userEvent.setup();
  const api = makeApi();
  const normalReview = api.reviewInvitation.getMockImplementation()!;
  api.reviewInvitation.mockImplementationOnce(async () => ({
    ...(await normalReview()),
    expires_at: Date.now() - 1,
  }));
  render(
    <InviteProjects
      api={api}
      person={person}
      initialProjectIds={["first"]}
      onClose={jest.fn()}
    />,
  );
  await continuePerson(user);
  await user.click(
    screen.getByRole("button", { name: "Review exact invitation" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Review expired");
  expect(
    screen.queryByRole("button", { name: "Send reviewed invitation" }),
  ).toBeNull();
  expect(api.sendInvitation).not.toHaveBeenCalled();
  await reviewAndSend(user);
  expect(api.sendInvitation.mock.lastCall![0].review_id).toBe("review-2");
});

it("can close a pending search and ignores its late response", async () => {
  const user = userEvent.setup();
  const api = makeApi();
  let resolve!: (value: any) => void;
  api.resolveRecipient.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  function Harness() {
    const [open, setOpen] = React.useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Invite person</button>
        {open && <InviteProjects api={api} onClose={() => setOpen(false)} />}
      </>
    );
  }
  render(<Harness />);
  const opener = screen.getByRole("button", { name: "Invite person" });
  await user.click(opener);
  await user.type(
    screen.getByRole("textbox", { name: "Email, name, or @username" }),
    "Bella{Enter}",
  );
  await waitFor(() => expect(api.resolveRecipient).toHaveBeenCalledTimes(1));
  await user.keyboard("{Escape}");
  await waitFor(() => expect(opener).toHaveFocus());
  await act(async () =>
    resolve({
      recipients: [
        { kind: "account", account_id: "person", label: "Late person" },
      ],
    }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.listProjects).not.toHaveBeenCalled();
});

it("cannot imply source-content access by selecting only another project", async () => {
  const user = userEvent.setup();
  const api = makeApi();
  render(
    <InviteProjects
      api={api}
      person={person}
      target={target}
      onClose={jest.fn()}
    />,
  );
  await continuePerson(user);
  await user.click(
    screen.getByRole("button", { name: "Remove First project" }),
  );
  await user.click(
    screen.getByRole("checkbox", { name: "Select Second project" }),
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "another project does not grant access",
  );
  expect(
    screen.getByRole("button", { name: "Review exact invitation" }),
  ).toBeDisabled();
  await user.click(
    screen.getByRole("button", { name: "Remove content context" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Review exact invitation" }),
  );
  expect(
    api.prepareInvitation.mock.lastCall![0].payload.target,
  ).toBeUndefined();
});
