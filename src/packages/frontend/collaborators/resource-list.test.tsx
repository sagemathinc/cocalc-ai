import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import { emptyCollaborationPersonalState } from "@cocalc/util/collaborators";
import { ResourceList } from "./resource-list";

let mockAbsolute = false;
jest.mock("@cocalc/frontend/app/use-context", () => ({
  __esModule: true,
  default: () => ({ timeAgoAbsolute: mockAbsolute }),
}));
jest.mock("@cocalc/frontend/account/avatar/avatar", () => ({
  Avatar: ({ account_id }) => <span data-testid={`avatar-${account_id}`} />,
}));
beforeEach(() => {
  mockAbsolute = false;
});

const resource: CollaborationResource = {
  project_id: "project",
  project_title: "Geometry Lab",
  resource_id: "thread",
  thread_id: "thread",
  kind: "conversation",
  title: "Shared work",
  chat_path: "/room.chat",
  participant_ids: ["alice", "bob"],
  created_at: 1,
  updated_at: Date.now() - 3600_000,
  activity: 4,
  reason: "mention",
  personal: {
    ...emptyCollaborationPersonalState(),
    alias: "work",
    following: true,
    muted: true,
  },
};

test.each(["agent", "artifact"] as const)(
  "%s never displays conversation attention indicators",
  (kind) => {
    render(<ResourceList items={[{ ...resource, kind }]} onOpen={jest.fn()} />);
    expect(screen.getByRole("button", { name: /Shared work/ })).toBeEnabled();
    expect(screen.queryByRole("img", { name: "Unread" })).toBeNull();
    expect(
      screen.queryByRole("img", { name: "You were mentioned" }),
    ).toBeNull();
  },
);

test("compact conversation rows show identity, avatars and meaningful unread state without redundant prose", () => {
  render(<ResourceList items={[resource]} onOpen={jest.fn()} />);
  expect(
    screen.getByRole("button", {
      name: /Shared work @work Geometry Lab 2 participants/,
    }),
  ).toBeEnabled();
  expect(screen.getByTestId("avatar-alice")).toBeInTheDocument();
  expect(screen.getByTestId("avatar-bob")).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "Unread" })).toBeInTheDocument();
  expect(
    screen.getByRole("img", { name: "You were mentioned" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByText(/Following|Latest message by|You follow this/),
  ).toBeNull();
});

test("keyboard selection and timestamp focus are separate; dates honor the existing user preference", async () => {
  const user = userEvent.setup();
  const onOpen = jest.fn();
  const { rerender } = render(
    <ResourceList items={[resource]} onOpen={onOpen} />,
  );
  const row = screen.getByRole("button", { name: /Shared work/ });
  expect(row.querySelector("button,a,[tabindex]")).toBeNull();
  row.focus();
  await user.keyboard("{Enter}");
  expect(onOpen).toHaveBeenCalledTimes(1);
  await user.tab();
  expect(screen.getByLabelText(/^Last activity:/)).toHaveFocus();
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    new Date(resource.updated_at!).toLocaleString(),
  );
  expect(screen.getByText("1 hour ago")).toBeInTheDocument();
  mockAbsolute = true;
  rerender(
    <ResourceList
      items={[{ ...resource, updated_at: resource.updated_at! + 1 }]}
      onOpen={onOpen}
    />,
  );
  expect(
    screen.getAllByText(new Date(resource.updated_at! + 1).toLocaleString())
      .length,
  ).toBeGreaterThan(0);
});

test("read and message-free conversations do not invent activity or unread state", () => {
  render(
    <ResourceList items={[{ ...resource, activity: 0 }]} onOpen={jest.fn()} />,
  );
  expect(screen.queryByRole("img", { name: "Unread" })).toBeNull();
  expect(screen.queryByLabelText(/^Last activity:/)).toBeNull();
});

test("bounded avatars preserve the full participant count", () => {
  render(
    <ResourceList
      items={[
        { ...resource, participant_count: 120, participants_truncated: true },
      ]}
      onOpen={jest.fn()}
    />,
  );
  expect(
    screen.getByRole("img", {
      name: "120 participants (partial participant preview)",
    }),
  ).toBeInTheDocument();
  expect(screen.getByText("+118")).toBeInTheDocument();
});
