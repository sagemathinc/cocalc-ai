import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Button } from "antd";
import type { ProjectAccessLandingInfo } from "@cocalc/conat/hub/api/projects";

let mockAccount = "account-1";
const mockInfo = jest.fn();
const mockRequest = jest.fn();
const mockRespond = jest.fn();
const mockOpen = jest.fn();
const mockRefresh = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => mockAccount,
  redux: {
    getActions: () => ({
      open_project: mockOpen,
      ensureRealtimeFeedForCurrentAccount: mockRefresh,
    }),
  },
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    project_collaborators: {
      get_access_landing_info: (...args) => mockInfo(...args),
      request_access: (...args) => mockRequest(...args),
      respond_invite: (...args) => mockRespond(...args),
    },
  },
}));
jest.mock("@cocalc/frontend/account/avatar/avatar", () => ({
  Avatar: () => null,
}));
import { ProjectAccessDialog, ProjectAccessLandingPage } from "./access";

const info: ProjectAccessLandingInfo = {
  project_id: "project-1",
  title: "Notebook project",
  relationship: "none",
};

beforeEach(() => {
  mockAccount = "account-1";
  mockInfo.mockReset().mockResolvedValue(info);
  mockRequest
    .mockReset()
    .mockResolvedValue({ request_id: "r1", requested_role: "collaborator" });
  mockRespond.mockReset().mockResolvedValue(undefined);
  mockRefresh.mockReset().mockResolvedValue(undefined);
  mockOpen.mockReset();
});

function Harness({ onAccessGranted = jest.fn() } = {}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Request access</Button>
      <ProjectAccessDialog
        projectId={info.project_id}
        open={open}
        onClose={() => setOpen(false)}
        onAccessGranted={onAccessGranted}
      />
    </>
  );
}

test("requests collaborator access in place and closes back to the triggering control", async () => {
  render(<Harness />);
  await userEvent.tab();
  const trigger = screen.getByRole("button", { name: "Request access" });
  expect(trigger).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog", { name: "Project access" });
  await within(dialog).findByRole("radio", { name: "Collaborator" });
  expect(mockRequest).not.toHaveBeenCalled();
  await userEvent.click(
    within(dialog).getByRole("radio", { name: "Collaborator" }),
  );
  await userEvent.type(
    within(dialog).getByRole("textbox", { name: "Optional message" }),
    "To review the notebook",
  );
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Request access" }),
  );
  expect(mockRequest).toHaveBeenCalledWith({
    project_id: info.project_id,
    requested_role: "collaborator",
    message: "To review the notebook",
    source: "project-url",
  });
  expect(
    await within(dialog).findByText("Access request pending"),
  ).toBeInTheDocument();
  expect(mockOpen).not.toHaveBeenCalled();
  await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  await waitFor(() => expect(trigger).toHaveFocus());
});

test("Escape closes the modal without requesting access", async () => {
  render(<Harness />);
  const trigger = screen.getByRole("button", { name: "Request access" });
  await userEvent.click(trigger);
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByRole("radio", { name: "Viewer" });
  await userEvent.click(
    within(dialog).getByRole("textbox", { name: "Optional message" }),
  );
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(mockRequest).not.toHaveBeenCalled();
});

test("accepts an existing invite without navigating away from the chat", async () => {
  mockInfo.mockResolvedValue({
    ...info,
    pending_invite: { invite_id: "i1", invite_role: "viewer" },
  });
  const granted = jest.fn();
  render(<Harness onAccessGranted={granted} />);
  await userEvent.click(screen.getByRole("button", { name: "Request access" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "Accept invite" }),
  );
  await waitFor(() => expect(granted).toHaveBeenCalledTimes(1));
  expect(mockRespond).toHaveBeenCalledWith({
    project_id: info.project_id,
    invite_id: "i1",
    action: "accept",
  });
  expect(mockOpen).not.toHaveBeenCalled();
});

test("the standalone page retains project navigation but supports a custom return action", async () => {
  const back = jest.fn();
  render(
    <ProjectAccessLandingPage
      info={info}
      loading={false}
      error={null}
      onChange={jest.fn()}
      onBack={back}
      backLabel="Back to conversation"
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Back to conversation" }),
  );
  expect(back).toHaveBeenCalledTimes(1);
  expect(mockOpen).not.toHaveBeenCalled();
});

test("late access information from another account does not appear in the dialog", async () => {
  let resolve!: (value: unknown) => void;
  mockInfo.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const props = { projectId: info.project_id, open: true, onClose: jest.fn() };
  const view = render(<ProjectAccessDialog {...props} />);
  mockAccount = "account-2";
  mockInfo.mockResolvedValue({ ...info, title: "Current account project" });
  view.rerender(<ProjectAccessDialog {...props} />);
  await screen.findByText("Current account project");
  await act(async () =>
    resolve({ ...info, title: "Previous account project" }),
  );
  expect(
    screen.queryByText("Previous account project"),
  ).not.toBeInTheDocument();
});

test("existing collaborators are not offered a redundant access request", async () => {
  mockInfo.mockResolvedValue({ ...info, relationship: "collaborator" });
  render(
    <ProjectAccessDialog
      projectId={info.project_id}
      open
      onClose={jest.fn()}
    />,
  );
  await screen.findByText("You already have access to this project.");
  expect(screen.queryByRole("radio")).not.toBeInTheDocument();
});
