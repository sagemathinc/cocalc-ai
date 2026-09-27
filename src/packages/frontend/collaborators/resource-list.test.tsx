import { render, screen } from "@testing-library/react";
import { fromJS } from "immutable";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import { emptyCollaborationPersonalState } from "@cocalc/util/collaborators";
import { ResourceList } from "./resource-list";

const author = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let mockUsers = fromJS({});
let mockAccount = "viewer";
const mockFetch = jest.fn().mockResolvedValue(undefined);
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (store: string) =>
    store === "users" ? mockUsers : mockAccount,
  redux: { getActions: () => ({ fetch_non_collaborator: mockFetch }) },
}));
beforeEach(() => {
  mockUsers = fromJS({});
  mockAccount = "viewer";
  mockFetch.mockClear();
});

const resource: CollaborationResource = {
  project_id: "project",
  resource_id: "thread",
  thread_id: "thread",
  kind: "conversation",
  title: "Shared work",
  chat_path: "/room.chat",
  participant_ids: [],
  created_at: 1,
  updated_at: 1,
  activity: 4,
  reason: "mention",
  personal: {
    ...emptyCollaborationPersonalState(),
    following: true,
    muted: true,
  },
};

test.each(["agent", "artifact"] as const)(
  "%s never displays conversation attention tags or reasons",
  (kind) => {
    render(<ResourceList items={[{ ...resource, kind }]} onOpen={jest.fn()} />);
    expect(screen.getByRole("button", { name: /Shared work/ })).toBeEnabled();
    for (const label of [
      "Unread",
      "Mention",
      "Following",
      "Muted",
      "You were mentioned",
    ])
      expect(screen.queryByText(label, { exact: true })).toBeNull();
  },
);

test("human conversations retain attention tags and reasons", () => {
  render(<ResourceList items={[resource]} onOpen={jest.fn()} />);
  for (const label of [
    "Unread",
    "Mention",
    "Following",
    "Muted",
    "You were mentioned",
  ])
    expect(screen.getByText(label, { exact: true })).toBeInTheDocument();
});

test("conversation row names the latest sender through the existing account display-name surface", () => {
  mockUsers = fromJS({
    [author]: {
      display_name: "Dr. Alice",
      first_name: "Old",
      last_name: "Name",
    },
  });
  render(
    <ResourceList
      items={[{ ...resource, latest_message_author_id: author }]}
      onOpen={jest.fn()}
    />,
  );
  expect(
    screen.getByRole("button", { name: /Latest message by Dr\. Alice/ }),
  ).toBeEnabled();
  expect(screen.queryByText(author, { exact: false })).toBeNull();
});

test.each([undefined, author])(
  "unavailable latest author %s is honest, never creator or raw ID",
  (latest_message_author_id) => {
    mockUsers = fromJS({ creator: { display_name: "Thread creator" } });
    render(
      <ResourceList
        items={[
          { ...resource, created_by: "creator", latest_message_author_id },
        ]}
        onOpen={jest.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Latest message by Unknown author/ }),
    ).toBeEnabled();
    expect(screen.queryByText(/Thread creator/)).toBeNull();
    expect(screen.queryByText(author, { exact: false })).toBeNull();
  },
);

test("legacy first/last names render, while message-free and nonconversation rows omit the label", () => {
  mockUsers = fromJS({
    [author]: { first_name: "Alice", last_name: "Example" },
  });
  const { rerender } = render(
    <ResourceList
      items={[{ ...resource, latest_message_author_id: author }]}
      onOpen={jest.fn()}
    />,
  );
  expect(
    screen.getByRole("button", { name: /Latest message by Alice Example/ }),
  ).toBeEnabled();
  for (const item of [
    { ...resource, activity: 0 },
    { ...resource, kind: "agent" as const },
    { ...resource, kind: "artifact" as const },
  ]) {
    rerender(<ResourceList items={[item]} onOpen={jest.fn()} />);
    expect(screen.queryByText(/Latest message by/)).toBeNull();
  }
});

test("uncached authors resolve without duplicate requests or interactive children", () => {
  const items = [
    { ...resource, latest_message_author_id: author },
    { ...resource, resource_id: "second", latest_message_author_id: author },
  ];
  const view = render(<ResourceList items={items} onOpen={jest.fn()} />);
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(mockFetch).toHaveBeenCalledWith(author);
  mockUsers = fromJS({ unrelated: { display_name: "Someone else" } });
  view.rerender(<ResourceList items={[...items]} onOpen={jest.fn()} />);
  expect(mockFetch).toHaveBeenCalledTimes(1);
  mockUsers = fromJS({ [author]: { display_name: "Resolved author" } });
  view.rerender(<ResourceList items={items} onOpen={jest.fn()} />);
  expect(
    screen.getAllByRole("button", {
      name: /Latest message by Resolved author/,
    }),
  ).toHaveLength(2);
  expect(screen.queryByRole("link")).toBeNull();
  expect(mockFetch).toHaveBeenCalledTimes(1);
  mockAccount = "another-viewer";
  mockUsers = fromJS({});
  view.rerender(<ResourceList items={items} onOpen={jest.fn()} />);
  expect(mockFetch).toHaveBeenCalledTimes(2);
});
