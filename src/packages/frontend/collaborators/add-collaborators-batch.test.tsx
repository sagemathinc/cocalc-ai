import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { fromJS } from "immutable";
import React from "react";
import userEvent from "@testing-library/user-event";
import { AddCollaborators } from "./add-collaborators";

const recipient = "00000000-0000-4000-8000-000000000001";
let mockProjectMap: any;
let mockCustomize: any;
let mockStudent = {};
const mockInvite = jest.fn();
const mockEmailInvite = jest.fn();
const mockUsage = jest.fn();
const mockClient = {
  account_id: "me",
  conat_client: {},
  project_collaborators: { get_invite_usage: mockUsage },
};
const mockStore = {
  getIn: (path) =>
    fromJS({ project_map: mockProjectMap, customize: mockCustomize }).getIn(
      path,
    ),
  get_fullname: () => "Sender",
  get_email_address: () => "sender@example.test",
  get: () => undefined,
};

jest.mock("@cocalc/frontend/app-framework", () => ({
  React,
  useState: React.useState,
  useRef: React.useRef,
  useEffect: React.useEffect,
  useIsMountedRef: () => {
    const mounted = React.useRef(true);
    React.useEffect(
      () => () => {
        mounted.current = false;
      },
      [],
    );
    return mounted;
  },
  useProjectFromMap: (id) => mockProjectMap.get(id),
  useTypedRedux: (store, key) =>
    key === "customize" ? mockCustomize : fromJS({}),
  useActions: () => ({
    invite_collaborator: mockInvite,
    invite_collaborators_by_email: mockEmailInvite,
  }),
  redux: { getStore: () => mockStore },
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  get webapp_client() {
    return mockClient;
  },
}));
jest.mock("react-intl", () => ({
  useIntl: () => ({ formatMessage: () => "Invite" }),
}));
jest.mock("@cocalc/frontend/i18n", () => ({ labels: {} }));
jest.mock("@cocalc/frontend/course", () => ({
  useStudentProjectFunctionality: () => ({}),
  getStudentProjectFunctionality: () => mockStudent,
}));
jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  Gap: () => null,
  Loading: () => null,
  ErrorDisplay: () => null,
}));
jest.mock("@cocalc/frontend/account/avatar/avatar", () => ({
  Avatar: () => null,
}));
jest.mock("@cocalc/frontend/antd-bootstrap", () => ({
  Well: ({ children }) => <div>{children}</div>,
}));
jest.mock("@cocalc/frontend/alerts", () => ({ alert_message: jest.fn() }));
jest.mock("@cocalc/frontend/support/link", () => ({
  ShowSupportLink: () => null,
}));
jest.mock("./viewer-read-policy", () => ({
  ViewerReadPolicyEditor: () => null,
  viewerPolicyHasReadablePath: () => true,
}));
jest.mock("./invite-email-address-requirement", () => ({
  InviteEmailAddressRequirement: () => null,
}));
jest.mock("./invite-events", () => ({
  onCollabInvitesChanged: () => () => {},
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockCustomize = fromJS({});
  mockStudent = {};
  mockClient.account_id = "me";
  mockProjectMap = fromJS({
    first: { title: "First", users: { me: { group: "owner" } } },
    second: { title: "Second", users: { me: { group: "collaborator" } } },
  });
  mockUsage.mockResolvedValue({ remaining: 5, limit: 5, current: 0 });
  mockInvite.mockResolvedValue({ in_app_notification_sent: true });
});

function mount(
  ids = ["first", "second"],
  person: any = { account_id: recipient, display_name: "Recipient" },
) {
  render(
    <AddCollaborators
      project_id="first"
      project_ids={ids}
      initialPerson={person}
      where="collaborators"
    />,
  );
  return screen.getByRole("button", {
    name: `Invite selected person to ${ids.length} projects`,
  });
}

it("sends only on explicit confirmation, locks double clicks, and retains partial results", async () => {
  let finish!: (value: any) => void;
  mockInvite.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  mockInvite.mockResolvedValueOnce(undefined);
  const submit = mount();
  expect(mockInvite).not.toHaveBeenCalled();
  fireEvent.click(submit);
  fireEvent.click(submit);
  await waitFor(() => expect(mockInvite).toHaveBeenCalledTimes(1));
  await act(async () => finish({ in_app_notification_sent: true }));
  await screen.findByText("Second: Failed");
  expect(screen.getByText("First: Invitation created")).toBeTruthy();
  expect(
    screen.getByRole("region", { name: "Project invitation results" }),
  ).toHaveFocus();
  expect(mockInvite.mock.calls.map(([id]) => id)).toEqual(["first", "second"]);
  expect(
    screen.queryByRole("button", { name: /Invite selected person/ }),
  ).toBeNull();
});

it("stops before the next invitation if unmounted during a pending attempt", async () => {
  let finish!: (value: any) => void;
  mockInvite.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { unmount } = render(
    <AddCollaborators
      project_id="first"
      project_ids={["first", "second"]}
      initialPerson={{ account_id: recipient, display_name: "Recipient" }}
      where="collaborators"
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: /Invite selected person/ }),
  );
  await waitFor(() => expect(mockInvite).toHaveBeenCalledTimes(1));
  unmount();
  await act(async () => finish({ in_app_notification_sent: true }));
  expect(mockInvite).toHaveBeenCalledTimes(1);
});

it("forwards viewer read policy to each project without requiring collaborator slots", async () => {
  const user = userEvent.setup();
  const submit = mount();
  mockUsage.mockResolvedValue({ remaining: 0 });
  const role = screen.getByRole("combobox", { name: "Access level" });
  await user.click(role);
  fireEvent.keyDown(role, { key: "ArrowDown", keyCode: 40, which: 40 });
  fireEvent.keyDown(role, { key: "Enter", keyCode: 13, which: 13 });
  fireEvent.click(submit);
  await screen.findByText("Second: Invitation created");
  expect(mockInvite).toHaveBeenCalledTimes(2);
  for (const args of mockInvite.mock.calls) {
    expect(args[7]).toBe("viewer");
    expect(args[8]).toBeDefined();
  }
});

it("skips existing members and refuses viewer-only projects", async () => {
  mockProjectMap = mockProjectMap
    .setIn(["first", "users", recipient], fromJS({ group: "collaborator" }))
    .setIn(["second", "users", "me", "group"], "viewer");
  fireEvent.click(mount());
  await screen.findByText("First: Skipped");
  await screen.findByText("Second: Failed");
  expect(mockInvite).not.toHaveBeenCalled();
});

it.each(["account", "student", "slots"])(
  "respects %s invitation restrictions",
  async (restriction) => {
    const submit = mount();
    if (restriction === "account")
      mockCustomize = fromJS({ disableCollaborators: true });
    if (restriction === "student") mockStudent = { disableCollaborators: true };
    if (restriction === "slots") mockUsage.mockResolvedValue({ remaining: 0 });
    fireEvent.click(submit);
    await waitFor(() => expect(mockInvite).not.toHaveBeenCalled());
    if (restriction !== "account") await screen.findByText("Second: Failed");
  },
);

it("rechecks the session after asynchronous preflight and sends nothing after an account switch", async () => {
  let finish!: (value: any) => void;
  mount();
  await act(async () => {});
  mockUsage.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: /Invite selected person/ }),
  );
  await waitFor(() => expect(finish).toBeDefined());
  mockClient.account_id = "someone-else";
  await act(async () => finish({ remaining: 5 }));
  await screen.findByText("Second: Failed");
  expect(mockInvite).not.toHaveBeenCalled();
});

it("reuses email invitations and keeps each project's manual delivery link", async () => {
  mockEmailInvite.mockImplementation(async (id) => ({
    manual_delivery_required: true,
    invites: [{ invite_url: `https://example.test/${id}` }],
  }));
  fireEvent.click(
    mount(undefined, { email_address: "recipient@example.test" }),
  );
  await screen.findByText("Second: Invitation created");
  expect(mockEmailInvite.mock.calls.map(([id, email]) => [id, email])).toEqual([
    ["first", "recipient@example.test"],
    ["second", "recipient@example.test"],
  ]);
  expect(
    screen.getByRole("textbox", { name: "Invitation link for First" }),
  ).toHaveValue("https://example.test/first");
  expect(mockInvite).not.toHaveBeenCalled();
});
