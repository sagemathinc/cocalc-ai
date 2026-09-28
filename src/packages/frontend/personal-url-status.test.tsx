import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const resolvePersonalUrl = jest.fn();
const getAccessInfo = jest.fn();
const respondInvite = jest.fn();
jest.mock("./personal-url-navigation", () => ({
  resolvePersonalUrl: (...args) => resolvePersonalUrl(...args),
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => "viewer",
  redux: {
    getActions: () => ({ ensureRealtimeFeedForCurrentAccount: jest.fn() }),
  },
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    project_collaborators: {
      get_access_landing_info: (...args) => getAccessInfo(...args),
      respond_invite: (...args) => respondInvite(...args),
    },
  },
}));
jest.mock("@cocalc/frontend/account/avatar/avatar", () => ({
  Avatar: () => null,
}));
import { PersonalUrlStatus } from "./personal-url-status";

const url = "u/bob/artifacts/notes";
beforeEach(() => {
  jest.clearAllMocks();
  getAccessInfo.mockResolvedValue({
    project_id: "project",
    relationship: "none",
  });
});

test("denied links offer keyboard access requests, Escape and focus restoration", async () => {
  const user = userEvent.setup();
  render(
    <PersonalUrlStatus
      url={url}
      loading={false}
      error="Access denied"
      projectId="project"
    />,
  );
  expect(screen.getByRole("heading", { name: "Personal alias" })).toHaveFocus();
  await user.tab();
  const trigger = screen.getByRole("button", { name: "Request access" });
  expect(trigger).toHaveFocus();
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog", { name: "Project access" });
  await within(dialog).findByRole("radio", { name: "Viewer" });
  expect(getAccessInfo).toHaveBeenCalledWith({ project_id: "project" });
  await user.click(
    within(dialog).getByRole("textbox", { name: "Optional message" }),
  );
  await user.keyboard("{Escape}");
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(resolvePersonalUrl).not.toHaveBeenCalled();
});

test("accepting an invite retries the same owner-qualified link rather than opening a local alias", async () => {
  getAccessInfo.mockResolvedValue({
    project_id: "project",
    relationship: "none",
    pending_invite: { invite_id: "invite", invite_role: "viewer" },
  });
  const user = userEvent.setup();
  render(<PersonalUrlStatus url={url} loading={false} projectId="project" />);
  await user.click(screen.getByRole("button", { name: "Request access" }));
  await user.click(
    await screen.findByRole("button", { name: "Accept invite" }),
  );
  await waitFor(() => expect(resolvePersonalUrl).toHaveBeenCalledWith(url));
});

test("unavailable and loading routes disclose no access target and support keyboard retry", async () => {
  const user = userEvent.setup();
  const view = render(<PersonalUrlStatus url={url} loading />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Resolving personal alias",
  );
  expect(
    screen.getByRole("button", { name: "Retry personal link" }),
  ).toBeDisabled();
  view.rerender(
    <PersonalUrlStatus url={url} loading={false} error="Unavailable" />,
  );
  expect(
    screen.queryByRole("button", { name: "Request access" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Unavailable");
  await user.tab();
  await user.keyboard("{Enter}");
  expect(resolvePersonalUrl).toHaveBeenCalledWith(url);
});
