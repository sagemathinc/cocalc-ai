/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  PeopleContact,
  PeopleContactPage,
} from "@cocalc/util/people-invitation-history";
import type { PeopleHistoryApi } from "./people-history-api";
import { ContactOverview, PeopleContacts } from "./people-contacts";
import { notifyCollabInvitesChanged } from "./invite-events";

const mockHistory = jest.fn();
jest.mock("./invitation-history", () => ({
  InvitationHistory: (props) => {
    mockHistory(props);
    return <section aria-label="Contact invitation history" />;
  },
}));
jest.mock("@cocalc/frontend/components/icon", () => ({ Icon: () => null }));
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => ({ erase_active_key_handler: jest.fn() }) },
}));

const CONTACT = "33333333-3333-4333-8333-333333333333";
const contact: PeopleContact = {
  person_id: CONTACT,
  account_id: "owner-account",
  display_label: "Ada contact",
  email: "ada@example.test",
  linked_account_id: null,
  link_provenance: null,
  archived: false,
  created_at: "2026-09-29T00:00:00Z",
  updated_at: "2026-09-29T00:00:00Z",
};
const second: PeopleContact = {
  ...contact,
  person_id: "44444444-4444-4444-8444-444444444444",
  display_label: "Bea contact",
};
function page(items = [contact], next_cursor?: string): PeopleContactPage {
  return { items, total: items.length, revision: "1", next_cursor };
}
function api() {
  return {
    listPeopleContacts: jest.fn().mockResolvedValue(page()),
    getPeopleContact: jest.fn().mockResolvedValue(contact),
    listInvitationHistory: jest.fn(),
    manage: jest.fn(),
  } satisfies PeopleHistoryApi;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
beforeEach(() => jest.clearAllMocks());

test("keyboard selection returns the contact identity without inventing an account identity", async () => {
  const user = userEvent.setup();
  const client = api();
  const onSelect = jest.fn();
  render(<PeopleContacts api={client} active onSelect={onSelect} />);
  const list = await screen.findByRole("list", { name: "Invited people" });
  const button = within(list).getByRole("button", { name: "Ada contact" });
  await user.tab();
  expect(screen.getByRole("button", { name: "Results options" })).toHaveFocus();
  await user.tab();
  expect(button).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(onSelect).toHaveBeenLastCalledWith(contact);
  expect(onSelect.mock.calls[0][0].person_id).toBe(CONTACT);
  expect(onSelect.mock.calls[0][0].account_id).toBe("owner-account");
  expect(onSelect.mock.calls[0][0].linked_account_id).toBeNull();
  await user.keyboard(" ");
  expect(onSelect).toHaveBeenCalledTimes(2);
  expect(button).toHaveFocus();
  expect(client.listPeopleContacts).toHaveBeenCalledWith({
    cursor: undefined,
    limit: 25,
    without_shared_projects: true,
  });
  expect(client.getPeopleContact).not.toHaveBeenCalled();
  expect(client.manage).not.toHaveBeenCalled();
});

test("paging deduplicates by contact ID, not the shared owner account ID", async () => {
  const user = userEvent.setup();
  const client = api();
  client.listPeopleContacts
    .mockResolvedValueOnce(page([contact], "next"))
    .mockResolvedValueOnce(page([contact, second]));
  render(<PeopleContacts api={client} active onSelect={jest.fn()} />);
  const more = await screen.findByRole("button", { name: "Load more" });
  more.focus();
  await user.keyboard("{Enter}");
  expect(
    await screen.findByRole("button", { name: "Bea contact" }),
  ).toBeVisible();
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(client.listPeopleContacts).toHaveBeenLastCalledWith({
    cursor: "next",
    limit: 25,
    without_shared_projects: true,
  });
  expect(screen.getByRole("group", { name: "End of results" })).toHaveFocus();
});

test("inactive lists do not fetch and hide pending replies until reactivated", async () => {
  const client = api();
  const pending = deferred<PeopleContactPage>();
  client.listPeopleContacts.mockReturnValueOnce(pending.promise);
  const onSelect = jest.fn();
  const { rerender } = render(
    <PeopleContacts api={client} active={false} onSelect={onSelect} />,
  );
  expect(client.listPeopleContacts).not.toHaveBeenCalled();
  rerender(<PeopleContacts api={client} active onSelect={onSelect} />);
  expect(client.listPeopleContacts).toHaveBeenCalledTimes(1);
  rerender(<PeopleContacts api={client} active={false} onSelect={onSelect} />);
  await act(async () => pending.resolve(page()));
  expect(screen.queryByRole("button", { name: "Ada contact" })).toBeNull();
  rerender(<PeopleContacts api={client} active onSelect={onSelect} />);
  expect(
    await screen.findByRole("button", { name: "Ada contact" }),
  ).toBeVisible();
  expect(client.listPeopleContacts).toHaveBeenCalledTimes(2);
});

test("invitation changes refresh the list and unsubscribe on unmount", async () => {
  const client = api();
  const { unmount } = render(
    <PeopleContacts api={client} active onSelect={jest.fn()} />,
  );
  await screen.findByRole("button", { name: "Ada contact" });
  client.listPeopleContacts.mockResolvedValue(page([second]));
  act(() => notifyCollabInvitesChanged("project"));
  expect(
    await screen.findByRole("button", { name: "Bea contact" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Ada contact" })).toBeNull();
  unmount();
  act(() => notifyCollabInvitesChanged("project"));
  expect(client.listPeopleContacts).toHaveBeenCalledTimes(2);
});

test("list errors expose a keyboard-operable retry", async () => {
  const user = userEvent.setup();
  const client = api();
  client.listPeopleContacts.mockRejectedValueOnce(Error("offline"));
  render(<PeopleContacts api={client} active onSelect={jest.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("offline");
  screen.getByRole("button", { name: "Retry" }).focus();
  await user.keyboard("{Enter}");
  expect(
    await screen.findByRole("button", { name: "Ada contact" }),
  ).toBeVisible();
});

test("replacing an account/client-bound list API discards its late reply and loads the new API", async () => {
  const previous = api();
  const next = api();
  const pending = deferred<PeopleContactPage>();
  previous.listPeopleContacts.mockReturnValue(pending.promise);
  next.listPeopleContacts.mockResolvedValue(page([second]));
  const { rerender } = render(
    <PeopleContacts api={previous} active onSelect={jest.fn()} />,
  );
  rerender(<PeopleContacts api={next} active onSelect={jest.fn()} />);
  await act(async () => pending.resolve(page()));
  expect(screen.queryByRole("button", { name: "Ada contact" })).toBeNull();
  expect(
    await screen.findByRole("button", { name: "Bea contact" }),
  ).toBeVisible();
  expect(next.listPeopleContacts).toHaveBeenCalledTimes(1);
});

test("contact overview uses person_id for contact/history lookup, never account_id", async () => {
  const user = userEvent.setup();
  const client = api();
  const onInvite = jest.fn();
  render(
    <ContactOverview api={client} contactId={CONTACT} onInvite={onInvite} />,
  );
  expect(
    await screen.findByRole("heading", { name: "Ada contact" }),
  ).toBeVisible();
  expect(client.getPeopleContact).toHaveBeenCalledWith({ person_id: CONTACT });
  expect(mockHistory).toHaveBeenLastCalledWith({
    api: client,
    personId: CONTACT,
  });
  expect(screen.getByText(/private email contact/)).toBeVisible();
  await user.tab();
  expect(
    screen.getByRole("button", { name: "Invite to projects" }),
  ).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(onInvite).toHaveBeenCalledWith(contact);
});

test.each(["contact", "api"] as const)(
  "overview ignores a late success after %s replacement",
  async (change) => {
    const previous = api();
    const next = change === "api" ? api() : previous;
    const pending = deferred<PeopleContact | null>();
    previous.getPeopleContact.mockReturnValueOnce(pending.promise);
    next.getPeopleContact.mockResolvedValueOnce(second);
    const { rerender } = render(
      <ContactOverview
        api={previous}
        contactId={CONTACT}
        onInvite={jest.fn()}
      />,
    );
    rerender(
      <ContactOverview
        api={next}
        contactId={change === "contact" ? second.person_id : CONTACT}
        onInvite={jest.fn()}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "Bea contact" }),
    ).toBeVisible();
    await act(async () => pending.resolve(contact));
    expect(screen.queryByRole("heading", { name: "Ada contact" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Bea contact" })).toBeVisible();
  },
);

test("overview ignores a stale failure after moving to another contact", async () => {
  const client = api();
  const pending = deferred<PeopleContact | null>();
  client.getPeopleContact
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(second);
  const { rerender } = render(
    <ContactOverview api={client} contactId={CONTACT} onInvite={jest.fn()} />,
  );
  rerender(
    <ContactOverview
      api={client}
      contactId={second.person_id}
      onInvite={jest.fn()}
    />,
  );
  await screen.findByRole("heading", { name: "Bea contact" });
  await act(async () => pending.reject(Error("stale failure")));
  expect(screen.queryByRole("alert")).toBeNull();
});

test("missing contacts show an error without an invitation action", async () => {
  const client = api();
  client.getPeopleContact.mockResolvedValue(null);
  render(
    <ContactOverview api={client} contactId={CONTACT} onInvite={jest.fn()} />,
  );
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("no longer available"),
  );
  expect(
    screen.queryByRole("button", { name: "Invite to projects" }),
  ).toBeNull();
  expect(mockHistory).not.toHaveBeenCalled();
});
