import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import api from "@cocalc/frontend/client/api";
import { PublicRedeemProjectInviteView } from "../completion-views";

jest.mock("@cocalc/frontend/client/api", () => jest.fn());
jest.mock("@cocalc/frontend/auth/api", () => ({
  signOutAuthSession: jest.fn(),
}));
const mockApi = jest.mocked(api);
const project_id = "22222222-2222-4222-8222-222222222222";
const target = {
  project_id,
  kind: "artifact",
  resource_id: "artifact:stable",
  label: "Authored notebook",
};
const invite = {
  project_id,
  invite_id: "invite",
  status: "pending",
  context: { people_invitation: { version: 1, target } },
};
beforeEach(() => jest.clearAllMocks());

test("email acceptance offers an explicit typed content continuation and never opens it automatically", async () => {
  const user = userEvent.setup();
  mockApi
    .mockResolvedValueOnce({ invite })
    .mockResolvedValueOnce({ invite: { ...invite, status: "accepted" } });
  render(
    <PublicRedeemProjectInviteView
      token="secret"
      currentAccountId="alice"
      isAuthenticated
    />,
  );
  const accept = await screen.findByRole("button", { name: "Accept invite" });
  expect(screen.getByText("Authored notebook")).toBeInTheDocument();
  expect(
    screen.getByText(/accepting does not run an agent or notebook/),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: /Open artifact/ }),
  ).not.toBeInTheDocument();
  expect(mockApi).toHaveBeenCalledTimes(1);
  accept.focus();
  await user.keyboard("{Enter}");
  const open = await screen.findByRole("link", {
    name: "Open artifact: Authored notebook",
  });
  expect(open).toHaveAttribute(
    "href",
    `/people/conversations/project/${project_id}/resource/artifact/artifact%3Astable`,
  );
  expect(mockApi).toHaveBeenCalledTimes(2);
  expect(mockApi).toHaveBeenLastCalledWith("projects/respond-email-invite", {
    token: "secret",
    action: "accept",
  });
  expect(
    screen.getByRole("link", { name: "Open project" }),
  ).toBeInTheDocument();
});

test("invalid or cross-project continuation falls back to project, not an untyped redirect", async () => {
  const user = userEvent.setup();
  const invalid = {
    ...invite,
    context: {
      people_invitation: {
        version: 1,
        target: { ...target, project_id: "other", url: "https://example.com" },
      },
    },
  };
  mockApi.mockResolvedValue({ invite: invalid });
  render(
    <PublicRedeemProjectInviteView
      token="secret"
      currentAccountId="alice"
      isAuthenticated
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: "Accept invite" }),
  );
  await screen.findByRole("link", { name: "Open project" });
  expect(
    screen.queryByRole("link", { name: /Open artifact/ }),
  ).not.toBeInTheDocument();
});

test("changing account while accepting cannot show a late success in the new session", async () => {
  let resolve;
  const user = userEvent.setup();
  mockApi
    .mockResolvedValueOnce({ invite })
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValueOnce({ invite });
  const view = render(
    <PublicRedeemProjectInviteView
      token="secret"
      currentAccountId="alice"
      isAuthenticated
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: "Accept invite" }),
  );
  view.rerender(
    <PublicRedeemProjectInviteView
      token="secret"
      currentAccountId="bob"
      isAuthenticated
    />,
  );
  await act(async () => resolve({ invite: { ...invite, status: "accepted" } }));
  await screen.findByRole("button", { name: "Accept invite" });
  expect(
    screen.queryByRole("link", { name: /Open artifact/ }),
  ).not.toBeInTheDocument();
});
