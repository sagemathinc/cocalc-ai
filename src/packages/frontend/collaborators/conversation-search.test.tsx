import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import type { DirectoryApi } from "./workspace-api";
import { HumanConversationSearch } from "./conversation-search";
import { conversationSearchStore } from "../chat/conversation-search/state";

const mockSearch = jest.fn();
let mockAccount = "";
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        projects: {
          chatStoreSearch: (...args) => mockSearch(...args),
        },
      },
    },
  },
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: () => undefined,
    getStore: () => ({ get: () => mockAccount }),
  },
}));
jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  TimeAgo: ({ date }) => <span>{date.toISOString()}</span>,
}));

function resource(id: string, activity: number): CollaborationResource {
  return {
    kind: "conversation",
    project_id: "p",
    resource_id: id,
    thread_id: id,
    chat_path: "/human.chat",
    title: id,
    participant_ids: [],
    created_at: 1,
    updated_at: 1,
    activity,
  };
}
const hit = {
  row_id: -1,
  segment_id: "head",
  date_ms: 1700000000000,
  excerpt: "hello world",
};
let serial = 0;
function setup() {
  mockAccount = `human-search-test-${++serial}`;
  const listResources = jest.fn();
  const getResource = jest.fn();
  const onSelect = jest.fn();
  const api = { listResources, getResource } as unknown as DirectoryApi;
  const props = {
    api,
    accountId: mockAccount,
    active: true,
    projects: [],
    onSelect,
  };
  return { props, listResources, getResource, onSelect };
}

beforeEach(() => mockSearch.mockReset());

test("global human content search uses shared RPC, newest-first targets, pagination, and exact hit selection with keyboard", async () => {
  const user = userEvent.setup();
  const { props, listResources, getResource, onSelect } = setup();
  const older = resource("Older title", 1);
  const newer = resource("Newer title", 10);
  const last = resource("Another page", 0);
  listResources
    .mockResolvedValueOnce({
      items: [older, newer],
      next: "page2",
      coverage: "complete",
    })
    .mockResolvedValueOnce({ items: [last], coverage: "complete" });
  mockSearch.mockImplementation(async ({ thread_id }) => ({
    includes_head: true,
    hits: thread_id === newer.thread_id ? [hit] : [],
  }));
  getResource.mockResolvedValue(newer);
  const view = render(<HumanConversationSearch {...props} />);
  const trigger = screen.getByRole("button", { name: "Search conversations" });
  trigger.focus();
  await user.keyboard("{Enter}");
  expect(
    screen.getByRole("dialog", { name: "Search all human conversations" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("checkbox", { name: "Include past conversations" }),
  ).toBeNull();
  await user.type(
    screen.getByRole("searchbox", { name: "Search human conversations" }),
    "hello{Enter}",
  );
  const result = await screen.findByRole("button", {
    name: /Newer title.*hello world/,
  });
  await waitFor(() => expect(mockSearch).toHaveBeenCalledTimes(2));
  expect(mockSearch.mock.calls[0][0]).toEqual({
    project_id: "p",
    chat_path: "/human.chat",
    thread_id: newer.thread_id,
    query: "hello",
    include_head: true,
    limit: 20,
  });
  expect(listResources).toHaveBeenCalledWith({
    kind: "conversation",
    scope: "all",
    project_id: undefined,
    after: undefined,
    limit: 50,
  });
  expect(screen.getByRole("status")).toHaveTextContent(
    "More conversations are available",
  );
  result.focus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(onSelect).toHaveBeenCalledWith(
      newer,
      expect.objectContaining({ hit }),
    ),
  );
  expect(getResource).toHaveBeenCalledWith({
    project_id: "p",
    kind: "conversation",
    resource_id: newer.resource_id,
  });
  await user.click(
    screen.getByRole("button", { name: "Search more conversations" }),
  );
  await waitFor(() => expect(mockSearch).toHaveBeenCalledTimes(3));
  expect(listResources.mock.calls[1][0].after).toBe("page2");
  expect(
    screen.queryByRole("button", { name: "Search more conversations" }),
  ).toBeNull();
  view.unmount();
  render(<HumanConversationSearch {...props} />);
  expect(
    screen.getByRole("searchbox", { name: "Search human conversations" }),
  ).toHaveValue("hello");
  expect(
    screen.getByRole("button", { name: /Newer title.*hello world/ }),
  ).toBeInTheDocument();
  expect(
    conversationSearchStore(mockAccount, "agent").get().progress,
  ).toBeUndefined();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Search conversations" }),
    ).toHaveFocus(),
  );
});

test("unavailable projects and incomplete discovery are not reported as successful no-match searches", async () => {
  const user = userEvent.setup();
  const { props, listResources } = setup();
  listResources.mockResolvedValue({
    items: [resource("Unavailable", 1)],
    coverage: "partial",
  });
  mockSearch.mockRejectedValue(Error("Project host is offline"));
  render(<HumanConversationSearch {...props} />);
  await user.click(
    screen.getByRole("button", { name: "Search conversations" }),
  );
  await user.type(
    screen.getByRole("searchbox", { name: "Search human conversations" }),
    "hello{Enter}",
  );
  await waitFor(() =>
    expect(screen.getByText(/Searched 0 conversations/)).toHaveTextContent(
      "1 unavailable",
    ),
  );
  expect(
    screen.getByText(/Some conversations may be missing/),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Unavailable: Project host is offline"),
  ).toBeInTheDocument();
});

test("account switch during target discovery cannot start message searches or populate results", async () => {
  const user = userEvent.setup();
  const { props, listResources } = setup();
  let resolve!: (value: unknown) => void;
  listResources.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(<HumanConversationSearch {...props} />);
  await user.click(
    screen.getByRole("button", { name: "Search conversations" }),
  );
  await user.type(
    screen.getByRole("searchbox", { name: "Search human conversations" }),
    "hello{Enter}",
  );
  mockAccount = "someone-else";
  resolve({ items: [resource("private", 1)], coverage: "complete" });
  await waitFor(() =>
    expect(conversationSearchStore(props.accountId, "human").get().busy).toBe(
      false,
    ),
  );
  expect(mockSearch).not.toHaveBeenCalled();
  expect(
    conversationSearchStore(props.accountId, "human").get().progress,
  ).toBeUndefined();
});
