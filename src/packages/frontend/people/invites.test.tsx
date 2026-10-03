/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const listInvites = jest.fn();
const respond = jest.fn(async () => ({}));
const copyLink = jest.fn(async () => ({ invite_url: "https://x/invite/1" }));

jest.mock("./api", () => ({
  peopleApi: () => ({ listInvites: (...a) => listInvites(...a) }),
}));
jest.mock("./new-conversation", () => ({ useCollaboratorProjects: () => [] }));
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => undefined,
}));
jest.mock("@cocalc/frontend/components", () => ({ TimeAgo: () => null }));
jest.mock("@cocalc/frontend/collaborators", () => ({
  AddCollaborators: () => null,
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        projects: {
          respondCollabInvite: (...a) => respond(...a),
          copyEmailProjectInviteLink: (...a) => copyLink(...a),
        },
      },
    },
  },
}));

import { InvitesPanel } from "./invites";

const invite = (extra = {}) => ({
  invite_id: "i1",
  project_id: "11111111-1111-4111-8111-111111111111",
  project_title: "Lab",
  inviter_account_id: "a",
  inviter_name: "Alice",
  invitee_name: "Bob",
  status: "pending",
  created: new Date("2026-01-01"),
  updated: new Date("2026-01-01"),
  ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
});

it("lists sent invitations with copy-link for email invites and revoke", async () => {
  listInvites.mockResolvedValue({
    invites: [
      invite({
        invite_source: "email",
        invitee_name: null,
        target_email: "bob@x.org",
      }),
    ],
    unavailable_bays: 0,
  });
  const user = userEvent.setup();
  const writeText = jest
    .spyOn(navigator.clipboard, "writeText")
    .mockResolvedValue(undefined);
  render(<InvitesPanel search="" />);
  const row = await screen.findByRole("listitem");
  expect(within(row).getByText(/to bob@x.org \(email\)/)).toBeInTheDocument();
  expect(listInvites).toHaveBeenCalledWith({
    direction: "outbound",
    status: "pending",
  });
  await user.click(
    within(row).getByRole("button", { name: "Copy invitation link" }),
  );
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith("https://x/invite/1"),
  );
  await user.click(within(row).getByRole("button", { name: "Revoke" }));
  expect(respond).toHaveBeenCalledWith({
    invite_id: "i1",
    project_id: invite().project_id,
    action: "revoke",
  });
});

it("accepts a received invitation", async () => {
  listInvites.mockResolvedValue({ invites: [invite()], unavailable_bays: 0 });
  const user = userEvent.setup();
  render(<InvitesPanel search="" />);
  await screen.findByRole("listitem");
  await user.click(screen.getByText("Received"));
  await waitFor(() =>
    expect(listInvites).toHaveBeenLastCalledWith({
      direction: "inbound",
      status: "pending",
    }),
  );
  await user.click(await screen.findByRole("button", { name: "Accept" }));
  expect(respond).toHaveBeenCalledWith(
    expect.objectContaining({ action: "accept" }),
  );
  await screen.findByText("You joined Lab.");
});

it("warns when some bays could not be reached", async () => {
  listInvites.mockResolvedValue({ invites: [], unavailable_bays: 1 });
  render(<InvitesPanel search="" />);
  await screen.findByText(/could not be loaded right now/);
});
