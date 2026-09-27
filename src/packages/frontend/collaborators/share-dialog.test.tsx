import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import { collaborationReferenceFromResource } from "@cocalc/util/collaboration-references";
import {
  ShareConversationDialog,
  ShareToConversationButton,
} from "./share-dialog";

let mockAccount = "alice";
const mockWrite = jest.fn();
const mockOpen = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => mockAccount,
  redux: {
    getStore: () => ({ get: () => mockAccount }),
    getActions: () => ({ erase_active_key_handler: jest.fn() }),
  },
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: { conat_client: {} },
}));
jest.mock("@cocalc/frontend/chat/use-chat-composer-draft", () => ({
  writeChatComposerDraft: (...args) => mockWrite(...args),
}));
jest.mock("./navigation", () => ({
  openCollaborators: (...args) => mockOpen(...args),
}));
const computedStyle = window.getComputedStyle;
beforeAll(() =>
  jest
    .spyOn(window, "getComputedStyle")
    .mockImplementation((element) => computedStyle(element)),
);
afterAll(() => jest.restoreAllMocks());
const source: CollaborationResource = {
  project_id: "11111111-1111-4111-8111-111111111111",
  resource_id: "artifact",
  kind: "artifact",
  title: "Original result",
  chat_path: "/source.chat",
  thread_id: "source-thread",
  participant_ids: [],
  activity: 1,
  created_at: 1,
  updated_at: 1,
};
const destination: CollaborationResource = {
  ...source,
  kind: "conversation",
  resource_id: "human",
  title: "Research discussion",
  project_title: "Research team",
  chat_path: "/human.chat",
  thread_id: "human-thread",
};
const reference = collaborationReferenceFromResource(source);
let api: { listResources: jest.Mock; getResource: jest.Mock };
beforeEach(() => {
  mockAccount = "alice";
  mockWrite.mockReset().mockResolvedValue("existing draft plus reference");
  mockOpen.mockReset();
  api = {
    listResources: jest
      .fn()
      .mockResolvedValue({ items: [destination], coverage: "complete" }),
    getResource: jest.fn(async ({ kind }) =>
      kind === "artifact" ? source : destination,
    ),
  };
});
function button() {
  return (
    <ShareToConversationButton accountId="alice" resource={source} api={api} />
  );
}
async function choose() {
  await userEvent.click(
    screen.getByRole("button", { name: "Share to conversation" }),
  );
  await userEvent.click(
    await screen.findByRole("button", {
      name: "Research discussion Human conversation / Research team",
    }),
  );
}

test("keyboard chooses an explicit project audience, adds only a draft and opens only on separate request", async () => {
  render(button());
  await userEvent.tab();
  expect(
    screen.getByRole("button", { name: "Share to conversation" }),
  ).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(
    (
      await screen.findByRole("dialog", { name: "Share to conversation" })
    ).closest(".collaborators-modal"),
  ).not.toBeNull();
  const search = screen.getByRole("textbox", { name: "Search conversations" });
  await waitFor(() => expect(search).toHaveFocus());
  await screen.findByRole("button", { name: /Research discussion/ });
  await userEvent.tab();
  expect(
    screen.getByRole("checkbox", { name: "Search all accessible projects" }),
  ).toHaveFocus();
  await userEvent.tab();
  expect(
    screen.getByRole("button", { name: /Research discussion/ }),
  ).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(
    screen.getByRole("heading", { name: "Destination: Research discussion" }),
  ).toHaveFocus();
  expect(
    screen.getByText(/all collaborators in Research team/),
  ).toBeInTheDocument();
  expect(mockWrite).not.toHaveBeenCalled();
  await userEvent.tab();
  await userEvent.tab();
  expect(
    screen.getByRole("button", { name: "Add reference to draft" }),
  ).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("heading", { name: "Reference added to draft" });
  expect(
    screen.getByRole("heading", { name: "Reference added to draft" }),
  ).toHaveFocus();
  expect(mockWrite).toHaveBeenCalledTimes(1);
  expect(mockWrite.mock.calls[0][0]).toMatchObject({
    append: true,
    project_id: destination.project_id,
    path: destination.chat_path,
  });
  expect(mockOpen).not.toHaveBeenCalled();
  await userEvent.tab();
  expect(
    screen.getByRole("button", { name: "Open conversation" }),
  ).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(mockOpen).toHaveBeenCalledWith({
    view: "conversations",
    projectId: destination.project_id,
    resourceKind: "conversation",
    resourceId: "human",
  });
});

test("Escape cancels and restores opener focus without modifying a draft", async () => {
  render(button());
  await choose();
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(
    screen.getByRole("button", { name: "Share to conversation" }),
  ).toHaveFocus();
  expect(mockWrite).not.toHaveBeenCalled();
});

test("bounded global search, paging, coverage, and client-side human-only filtering", async () => {
  api.listResources
    .mockResolvedValueOnce({
      items: [
        destination,
        source,
        {
          ...destination,
          resource_id: "archived",
          title: "Archived",
          archived: true,
        },
      ],
      coverage: "partial",
      coverage_message: "Index quota reached.",
      next: "next-cursor",
    })
    .mockResolvedValue({ items: [], coverage: "complete" });
  render(button());
  await userEvent.click(
    screen.getByRole("button", { name: "Share to conversation" }),
  );
  await screen.findByRole("button", { name: /Research discussion/ });
  expect(
    screen.queryByRole("button", { name: /Original result|Archived/ }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Index quota reached.")).toBeInTheDocument();
  expect(api.listResources).toHaveBeenLastCalledWith({
    account_id: "alice",
    project_id: source.project_id,
    kind: "conversation",
    scope: "all",
    search: "",
    after: undefined,
    limit: 25,
  });
  await userEvent.click(
    screen.getByRole("button", { name: "Next conversations" }),
  );
  expect(
    screen.getByRole("heading", { name: "Destination conversations" }),
  ).toHaveFocus();
  await screen.findByText("No matching human conversations.");
  expect(api.listResources).toHaveBeenLastCalledWith(
    expect.objectContaining({ after: "next-cursor", limit: 25 }),
  );
  await userEvent.click(
    screen.getByRole("checkbox", { name: "Search all accessible projects" }),
  );
  await waitFor(() =>
    expect(api.listResources).toHaveBeenLastCalledWith(
      expect.objectContaining({
        project_id: undefined,
        after: undefined,
        kind: "conversation",
        limit: 25,
      }),
    ),
  );
});

test("search replaces old results immediately; safe load errors are retryable", async () => {
  render(button());
  await userEvent.click(
    screen.getByRole("button", { name: "Share to conversation" }),
  );
  await screen.findByRole("button", { name: /Research discussion/ });
  api.listResources.mockRejectedValueOnce(Error("private backend detail"));
  await userEvent.type(
    screen.getByRole("textbox", { name: "Search conversations" }),
    "new",
  );
  expect(
    screen.queryByRole("button", { name: /Research discussion/ }),
  ).not.toBeInTheDocument();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not load conversations",
  );
  expect(screen.queryByText(/private backend detail/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("button", { name: /Research discussion/ });
});

test("canceled pending access checks cannot write; reopening starts a fresh selection", async () => {
  let finish!: (value: CollaborationResource) => void;
  api.getResource.mockImplementation(async ({ kind }) =>
    kind === "artifact"
      ? source
      : new Promise((resolve) => {
          finish = resolve;
        }),
  );
  render(button());
  await choose();
  await userEvent.click(
    screen.getByRole("button", { name: "Add reference to draft" }),
  );
  await waitFor(() => expect(finish).toBeDefined());
  await userEvent.keyboard("{Escape}");
  await act(async () => finish(destination));
  expect(mockWrite).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole("button", { name: "Share to conversation" }),
  );
  expect(
    await screen.findByRole("textbox", { name: "Search conversations" }),
  ).toBeInTheDocument();
});

test("late list response from a previous account stays hidden", async () => {
  let finish!: (value: unknown) => void;
  api.listResources.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const props = {
    open: true,
    accountId: "alice",
    api,
    reference,
    onClose: jest.fn(),
  };
  const view = render(<ShareConversationDialog {...props} />);
  await waitFor(() => expect(finish).toBeDefined());
  mockAccount = "bob";
  view.rerender(<ShareConversationDialog {...props} />);
  await act(async () => finish({ items: [destination], coverage: "complete" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Your account changed");
  expect(
    screen.queryByRole("button", { name: /Research discussion/ }),
  ).not.toBeInTheDocument();
  expect(mockWrite).not.toHaveBeenCalled();
});

test("choosing the same row again does not revive a canceled in-flight share", async () => {
  let finish!: (value: CollaborationResource) => void;
  api.getResource.mockImplementation(async ({ kind }) =>
    kind === "artifact"
      ? source
      : new Promise((resolve) => {
          finish = resolve;
        }),
  );
  render(button());
  await choose();
  await userEvent.click(
    screen.getByRole("button", { name: "Add reference to draft" }),
  );
  await waitFor(() => expect(finish).toBeDefined());
  await userEvent.click(
    screen.getByRole("button", { name: "Choose another conversation" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: /Research discussion Human/ }),
  );
  await act(async () => finish(destination));
  expect(mockWrite).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("heading", { name: "Reference added to draft" }),
  ).not.toBeInTheDocument();
});

test("revoked destination or agent conversion leaves an actionable error and no draft write", async () => {
  api.getResource.mockImplementation(async ({ kind }) =>
    kind === "artifact" ? source : { ...destination, kind: "agent" },
  );
  render(button());
  await choose();
  await userEvent.click(
    screen.getByRole("button", { name: "Add reference to draft" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not add the reference",
  );
  expect(mockWrite).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole("button", { name: "Choose another conversation" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Search conversations" }),
    ).toHaveFocus(),
  );
});

test("a replaced source selection callback invalidates an already pending share", async () => {
  let finish!: (value: CollaborationResource) => void;
  api.getResource.mockImplementation(async ({ kind }) =>
    kind === "artifact"
      ? source
      : new Promise((resolve) => {
          finish = resolve;
        }),
  );
  const props = {
    open: true,
    accountId: "alice",
    api,
    reference,
    onClose: jest.fn(),
  };
  const view = render(
    <ShareConversationDialog {...props} isCurrent={() => true} />,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: /Research discussion Human/ }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Add reference to draft" }),
  );
  await waitFor(() => expect(finish).toBeDefined());
  view.rerender(<ShareConversationDialog {...props} isCurrent={() => false} />);
  await act(async () => finish(destination));
  expect(mockWrite).not.toHaveBeenCalled();
});
