import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fromJS } from "immutable";
import { NewConversation } from "./new-conversation";
import { ConversationFailure } from "./conversation-failure";
import type { DirectoryApi } from "./workspace-api";

let mockProject: any;
let mockHost: any;
const mockCreate = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => ({ erase_active_key_handler: jest.fn() }) },
  useTypedRedux: () => fromJS({ project: mockProject }),
}));
jest.mock("@cocalc/frontend/projects/host-info", () => ({
  useHostInfo: () => mockHost && fromJS(mockHost),
}));
jest.mock("./start-conversation", () => ({
  createConversation: (args) => mockCreate(args),
}));
beforeEach(() => {
  mockProject = {};
  mockHost = undefined;
  mockCreate.mockReset();
});

test.each([
  [
    { state: { state: "archived" }, last_backup: "2026-09-01T00:00:00Z" },
    undefined,
    "This project is archived.",
  ],
  [
    { state: { state: "archived" }, last_backup: null },
    undefined,
    "This project has not been started yet.",
  ],
  [
    { host_id: "host" },
    { status: "running", online: false },
    "Assigned host is offline",
  ],
  [
    { host_id: "host" },
    { status: "off", online: false },
    "Assigned host is off.",
  ],
  [{}, undefined, "Check the project's availability"],
])(
  "explains known status without inferring offline from missing routing: %j",
  async (project, host, message) => {
    mockProject = project;
    mockHost = host;
    const onManageProject = jest.fn();
    render(
      <ConversationFailure
        projectId="project"
        error="host routing info unavailable"
        dispatched={false}
        onManageProject={onManageProject}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("alert")).toHaveTextContent("was not sent");
    const user = userEvent.setup();
    screen.getByRole("button", { name: "Project settings" }).focus();
    await user.keyboard("{Enter}");
    expect(onManageProject).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/may have reached/)).not.toBeInTheDocument();
  },
);

test("retry retains unknown outcome and operation identity even after a later routing failure", async () => {
  mockCreate
    .mockImplementationOnce(async () => {
      throw Error("host routing info unavailable");
    })
    .mockImplementationOnce(async ({ onDispatch }) => {
      onDispatch();
      throw Error("timeout");
    })
    .mockImplementationOnce(async () => {
      throw Error("host routing info unavailable");
    });
  const user = userEvent.setup();
  render(
    <NewConversation
      api={{} as DirectoryApi}
      accountId="me"
      project={{ id: "project", title: "Shared project" }}
      onCreated={jest.fn()}
      onClose={jest.fn()}
      onChangeProject={jest.fn()}
    />,
  );
  await user.type(
    screen.getByRole("textbox", { name: "Conversation title" }),
    "Seminar",
  );
  await user.click(
    screen.getByRole("button", { name: "Start discussion", exact: true }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("was not sent");
  expect(screen.getByRole("button", { name: "Change project" })).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: "Retry same conversation" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("may have reached"),
  );
  expect(
    screen.queryByRole("button", { name: "Change project" }),
  ).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Retry same conversation" }),
  );
  await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(3));
  expect(screen.getByRole("alert")).toHaveTextContent("may have reached");
  expect(
    new Set(mockCreate.mock.calls.map(([args]) => args.requestId)).size,
  ).toBe(1);
  expect(
    mockCreate.mock.calls.every(([args]) => args.title === "Seminar"),
  ).toBe(true);
});
