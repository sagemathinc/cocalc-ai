import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InvitationHistory } from "./invitation-history";
import type {
  PeopleAccessInvitation,
  PeopleInvitationHistoryPage,
} from "@cocalc/util/people-invitation-history";

const invitation: PeopleAccessInvitation = {
  invitation_id: "invite-one",
  kind: "access",
  project_id: "project-one",
  sender_account_id: "alice",
  recipient_account_id: null,
  person_id: "contact-one",
  accepted_account_id: null,
  message: "Come work on this",
  status: "pending",
  role: "collaborator",
  read_policy: null,
  invite_source: "email",
  scope: null,
  created_at: "2026-09-29T00:00:00Z",
  updated_at: "2026-09-29T00:00:00Z",
  expires_at: null,
  responded_at: null,
  last_sent_at: null,
  resend_count: 0,
  source_version: "1",
  source_bay_id: "bay-one",
};
function page(items = [invitation], extra = {}): PeopleInvitationHistoryPage {
  return {
    items,
    total: 301,
    pending: { sent: 301, received: 0 },
    unread: null,
    revision: "1",
    coverage: "complete",
    ...extra,
  };
}
function api() {
  return {
    listInvitationHistory: jest.fn(async () => page()),
    manage: jest.fn(async () => {}),
  };
}

beforeAll(() => {
  const getComputedStyle = window.getComputedStyle;
  jest
    .spyOn(window, "getComputedStyle")
    .mockImplementation((element) => getComputedStyle(element));
});
afterAll(() => jest.restoreAllMocks());

test("compact cards use shared collection views without pinning and expand with the keyboard", async () => {
  const user = userEvent.setup();
  render(
    <InvitationHistory
      api={api()}
      collectionView="grid"
      projectTitle={() => "Research"}
    />,
  );
  const toggle = await screen.findByRole("button", {
    name: "Details and actions",
  });
  expect(screen.getByText("Research")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Copy invitation link" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: /Pin / })).toBeNull();
  toggle.focus();
  await user.keyboard("{Enter}");
  expect(
    screen.getByRole("button", { name: "Copy invitation link" }),
  ).toBeVisible();
  await user.keyboard("{Enter}");
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(toggle).toHaveFocus();
});

test("uses server totals, pages with keyboard, and keeps email delivery explicit", async () => {
  const user = userEvent.setup();
  const service = api();
  service.listInvitationHistory
    .mockResolvedValueOnce(page([invitation], { next: "two" }))
    .mockResolvedValueOnce(
      page([{ ...invitation, invitation_id: "invite-two" }]),
    );
  render(<InvitationHistory api={service} />);
  expect(await screen.findByText(/301 matching invitations/)).toBeVisible();
  const details = screen.getByRole("button", { name: "Details and actions" });
  expect(details).toHaveAttribute("aria-expanded", "false");
  details.focus();
  await user.keyboard("{Enter}");
  expect(details).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText(/No email delivery has been recorded/)).toBeVisible();
  const more = screen.getByRole("button", { name: "Load more invitations" });
  more.focus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(service.listInvitationHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({ after: "two", limit: 25 }),
    ),
  );
  expect(await screen.findAllByRole("listitem")).toHaveLength(2);
});

test("late filtered response cannot replace current invitations", async () => {
  const service = api();
  let resolve!: (page: PeopleInvitationHistoryPage) => void;
  service.listInvitationHistory.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const rendered = render(
    <InvitationHistory api={service} personId="old-contact" />,
  );
  rendered.rerender(<InvitationHistory api={service} personId="new-contact" />);
  await screen.findByText("Come work on this");
  await act(async () =>
    resolve(page([{ ...invitation, message: "Old contact private history" }])),
  );
  expect(screen.queryByText("Old contact private history")).toBeNull();
});

test("filter switches reset cursors and an error never reports zero complete results", async () => {
  const user = userEvent.setup();
  const service = api();
  render(<InvitationHistory api={service} />);
  await screen.findByText(/301 matching/);
  service.listInvitationHistory.mockRejectedValueOnce(
    Error("Owner bay unavailable"),
  );
  await user.click(screen.getByRole("tab", { name: "Received" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Owner bay unavailable",
  );
  expect(screen.queryByText("No invitations match these filters.")).toBeNull();
  expect(service.listInvitationHistory).toHaveBeenLastCalledWith(
    expect.objectContaining({ view: "received", after: undefined }),
  );
});

test("copy is an explicit action and does not resend invitations", async () => {
  const user = userEvent.setup();
  const service = api();
  render(<InvitationHistory api={service} />);
  await user.click(
    await screen.findByRole("button", { name: "Details and actions" }),
  );
  const copy = await screen.findByRole("button", {
    name: "Copy invitation link",
  });
  copy.focus();
  await user.keyboard("{Enter}");
  expect(service.manage).toHaveBeenCalledWith(invitation, "copy");
  expect(await screen.findByText("Invitation link copied.")).toBeVisible();
  expect(copy).toHaveFocus();
});

test("a notification deep link selects Received and the exact invitation until explicitly cleared", async () => {
  const user = userEvent.setup();
  const service = api();
  render(<InvitationHistory api={service} invitationId="chosen-invitation" />);
  await screen.findByText(/301 matching/);
  expect(screen.getByRole("tab", { name: "Received" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(service.listInvitationHistory).toHaveBeenLastCalledWith(
    expect.objectContaining({
      view: "received",
      invitation_id: "chosen-invitation",
    }),
  );
  await user.click(
    screen.getByRole("button", { name: "Show all invitations" }),
  );
  await waitFor(() =>
    expect(service.listInvitationHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({ invitation_id: undefined, after: undefined }),
    ),
  );
});
