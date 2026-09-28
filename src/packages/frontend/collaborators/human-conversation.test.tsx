import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HumanConversation } from "./human-conversation";
import type { CollaborationResource } from "@cocalc/util/collaborators";

const mockRemove = jest.fn();
const mockInit = jest.fn();
const mockEmbedding = jest.fn();
let mockAccount = "alice";
const mockLocal = new Map<string, string>();
const mockRemote = new Map<string, unknown>();
const mockSave = jest.fn(async (account, key, value) => {
  mockRemote.set(`${account}:${key}`, value);
});
const mockLoad = jest.fn(async (account, key) =>
  mockRemote.get(`${account}:${key}`),
);
const mockSend = jest.fn();
const mockReadHit = jest.fn();
jest.mock("@cocalc/frontend/misc", () => ({
  get_local_storage: (key) => mockLocal.get(key),
  set_local_storage: (key, value) => mockLocal.set(key, value),
  delete_local_storage: (key) => mockLocal.delete(key),
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        projects: {
          chatStoreReadArchivedHit: (...args) => mockReadHit(...args),
        },
      },
      conat: () => ({
        sync: {
          akv: ({ account_id }) => ({
            get: (key) => mockLoad(account_id, key),
            set: (key, value) => mockSave(account_id, key, value),
            delete: (key) => mockRemote.delete(`${account_id}:${key}`),
            close: jest.fn(),
          }),
        },
      }),
    },
  },
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: () => ({ get: () => mockAccount }),
    getProjectActions: () => ({ fs: () => ({ stat: async () => ({}) }) }),
  },
}));
jest.mock("@cocalc/frontend/app-framework/project-runtime", () => ({
  ensureProjectReduxRuntime: async () => {},
}));
jest.mock("@cocalc/frontend/chat/register", () => ({
  initChat: (...args) => mockInit(...args),
  removeWithInstance: (...args) => mockRemove(...args),
}));
jest.mock("@cocalc/frontend/chat/side-chat", () => ({
  __esModule: true,
  default: function DraftSideChat({ desc, project_id, path }) {
    const {
      useChatComposerDraft,
    } = require("@cocalc/frontend/chat/use-chat-composer-draft");
    const {
      stableDraftKeyFromThreadKey,
    } = require("@cocalc/frontend/chat/utils");
    const draft = useChatComposerDraft({
      account_id: mockAccount,
      project_id,
      path,
      composerDraftKey: stableDraftKeyFromThreadKey(
        desc["data-selectedThreadKey"],
      ),
    });
    return (
      <>
        <textarea
          aria-label={`Human composer ${desc["data-selectedThreadKey"]}`}
          value={draft.input}
          onChange={(event) => draft.setInput(event.target.value)}
        />
        <button
          onClick={() => {
            mockSend(draft.input);
            void draft.clearInput();
          }}
        >
          Send human message
        </button>
      </>
    );
  },
}));
jest.mock("@cocalc/frontend/project/context", () => ({
  ProjectContext: require("react").createContext({}),
  useProjectContextProvider: () => ({}),
}));
jest.mock("@cocalc/frontend/chat/embedding-options", () => ({
  ChatEmbeddingOptionsProvider: ({ children, value }) => {
    mockEmbedding(value);
    return children;
  },
}));

const resource: CollaborationResource = {
  project_id: "project",
  resource_id: "thread",
  kind: "conversation",
  title: "Office hours",
  chat_path: "/room.chat",
  thread_id: "thread",
  participant_ids: [],
  created_at: 1,
  updated_at: 1,
  activity: 0,
};

beforeEach(() => {
  mockAccount = "alice";
  mockInit.mockClear();
  mockSend.mockClear();
  mockSave.mockClear();
  mockInit.mockReturnValue({
    syncdb: { get_state: () => "ready" },
    getThreadMetadata: () => ({ agent_kind: "none" }),
    setSelectedThread: jest.fn(),
  });
});

test("human chat reuses SideChat with the locked humanOnly embedding and disposes its isolated instance", async () => {
  const setSelectedThread = jest.fn();
  mockInit.mockReturnValue({
    syncdb: { get_state: () => "ready" },
    getThreadMetadata: () => ({ agent_kind: "none" }),
    setSelectedThread,
  });
  const view = render(
    <HumanConversation accountId="alice" resource={resource} />,
  );
  await screen.findByRole("textbox", { name: "Human composer thread" });
  expect(mockEmbedding).toHaveBeenCalledWith(
    expect.objectContaining({
      humanOnly: true,
      disableConversationFocus: true,
    }),
  );
  expect(setSelectedThread).toHaveBeenCalledWith("thread");
  const options = mockInit.mock.calls[0][2];
  expect(options).toMatchObject({
    instanceKey: expect.stringContaining("collaborators:alice:"),
    workbenchEnabled: false,
  });
  view.rerender(
    <HumanConversation
      accountId="alice"
      resource={{
        ...resource,
        title: "Renamed title",
        personal: {
          alias: "renamed",
          collected: true,
          following: false,
          muted: false,
          read_through: 0,
        },
      }}
    />,
  );
  expect(mockInit).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole("textbox", { name: "Human composer thread" }),
  ).toBeInTheDocument();
  view.unmount();
  expect(mockRemove).toHaveBeenCalledWith(
    "/room.chat",
    expect.anything(),
    "project",
    { instanceKey: options.instanceKey },
  );
});

test("global search hydrates an archived hit and scrolls without remounting the composer", async () => {
  const scrollToDate = jest.fn();
  const hydrateArchivedRows = jest.fn();
  mockInit.mockReturnValue({
    syncdb: { get_state: () => "ready" },
    getThreadMetadata: () => ({ agent_kind: "none" }),
    setSelectedThread: jest.fn(),
    scrollToDate,
    hydrateArchivedRows,
  });
  const row = { event: "chat", date: 123, payload: { content: "old message" } };
  mockReadHit.mockResolvedValue({ row: { row } });
  const searchHit = {
    target: {
      id: "thread",
      project_id: "project",
      path: "/room.chat",
      thread_id: "thread",
      title: "Office hours",
      activity: 1,
    },
    threadId: "thread",
    historical: false,
    hit: { row_id: 42, segment_id: "archive", date_ms: 123 },
  };
  const view = render(
    <HumanConversation accountId="alice" resource={resource} />,
  );
  const composer = await screen.findByRole("textbox", {
    name: "Human composer thread",
  });
  view.rerender(
    <HumanConversation
      accountId="alice"
      resource={resource}
      searchHit={searchHit}
    />,
  );
  await waitFor(() => expect(scrollToDate).toHaveBeenCalledWith(123));
  expect(mockReadHit).toHaveBeenCalledWith({
    project_id: "project",
    chat_path: "/room.chat",
    thread_id: "thread",
    row_id: 42,
  });
  expect(hydrateArchivedRows).toHaveBeenCalledWith([row]);
  expect(mockInit).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("textbox", { name: "Human composer thread" })).toBe(
    composer,
  );
  view.rerender(
    <HumanConversation
      accountId="alice"
      resource={resource}
      searchHit={{ ...searchHit, threadId: "another-thread" }}
    />,
  );
  expect(scrollToDate).toHaveBeenCalledTimes(1);
});

test("an agent config is not mounted in the human composer", async () => {
  mockInit.mockReturnValue({
    syncdb: { get_state: () => "ready" },
    getThreadMetadata: () => ({ agent_kind: "acp" }),
  });
  render(<HumanConversation accountId="alice" resource={resource} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "not an available human-only conversation",
  );
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

test("legacy chat keeps the strict composer closed and offers a keyboard-operated original viewer", async () => {
  const user = userEvent.setup();
  const openOriginal = jest.fn();
  mockInit.mockReturnValue({
    syncdb: { get_state: () => "ready" },
    getThreadMetadata: () => ({}),
  });
  render(
    <HumanConversation
      accountId="alice"
      resource={resource}
      onOpenOriginal={openOriginal}
    />,
  );
  const open = await screen.findByRole("button", {
    name: "Open original conversation",
  });
  expect(openOriginal).not.toHaveBeenCalled();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  open.focus();
  await user.keyboard("{Enter}");
  expect(openOriginal).toHaveBeenCalledTimes(1);
});

test("human detail/list/alias reopen shares the real draft key, and metadata refresh leaves focus untouched", async () => {
  const user = userEvent.setup();
  const original = { ...resource, chat_path: "/alias-draft.chat" };
  const renamed = {
    ...original,
    title: "Renamed conversation",
    personal: {
      alias: "my-alias",
      collected: true,
      following: false,
      muted: false,
      read_through: 0,
    },
  };
  const view = render(
    <HumanConversation accountId="alice" resource={original} />,
  );
  const composer = await screen.findByRole("textbox", {
    name: "Human composer thread",
  });
  await user.type(composer, "unfinished human message");
  view.rerender(<HumanConversation accountId="alice" resource={renamed} />);
  expect(screen.getByRole("textbox", { name: "Human composer thread" })).toBe(
    composer,
  );
  expect(composer).toHaveFocus();
  expect(mockInit).toHaveBeenCalledTimes(1);
  view.unmount();
  await act(async () => {
    await Promise.resolve();
  });
  render(<HumanConversation accountId="alice" resource={renamed} />);
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Human composer thread" }),
    ).toHaveValue("unfinished human message"),
  );
  expect(mockSend).not.toHaveBeenCalled();
});

test("a stale save from a closed human detail cannot overwrite the reopened draft or restore sent text", async () => {
  const user = userEvent.setup();
  const target = { ...resource, chat_path: "/pending-draft.chat" };
  let finish!: () => void;
  mockSave.mockImplementationOnce(async (account, key, value) => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    mockRemote.set(`${account}:${key}`, value);
  });
  const first = render(
    <HumanConversation accountId="alice" resource={target} />,
  );
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Human composer thread" }),
    { target: { value: "old pending save" } },
  );
  first.unmount();
  await waitFor(() => expect(finish).toBeDefined());
  const second = render(
    <HumanConversation accountId="alice" resource={target} />,
  );
  const reopened = await screen.findByRole("textbox", {
    name: "Human composer thread",
  });
  reopened.focus();
  fireEvent.change(reopened, { target: { value: "newest draft" } });
  expect(reopened).toHaveValue("newest draft");
  expect(reopened).toHaveFocus();
  second.unmount();
  await act(async () => {
    finish();
  });
  const third = render(
    <HumanConversation accountId="alice" resource={target} />,
  );
  const current = await screen.findByRole("textbox", {
    name: "Human composer thread",
  });
  await waitFor(() => expect(current).toHaveValue("newest draft"));
  screen.getByRole("button", { name: "Send human message" }).focus();
  await user.keyboard("{Enter}");
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend).toHaveBeenCalledWith("newest draft");
  expect(current).toHaveValue("");
  third.unmount();
  await act(async () => {
    await Promise.resolve();
  });
  render(<HumanConversation accountId="alice" resource={target} />);
  expect(
    await screen.findByRole("textbox", { name: "Human composer thread" }),
  ).toHaveValue("");
});

test("switching account while a remote human draft loads cannot hydrate the next account's composer", async () => {
  const target = { ...resource, chat_path: "/private-draft.chat" };
  let resolve!: (value: unknown) => void;
  mockLoad.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const first = render(
    <HumanConversation accountId="alice" resource={target} />,
  );
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Human composer thread" }),
    { target: { value: "alice private draft" } },
  );
  first.unmount();
  mockAccount = "bob";
  render(<HumanConversation accountId="bob" resource={target} />);
  const next = await screen.findByRole("textbox", {
    name: "Human composer thread",
  });
  await act(async () =>
    resolve({ text: "stale Alice text", updatedAt: Date.now() }),
  );
  expect(next).toHaveValue("");
  expect(mockSend).not.toHaveBeenCalled();
});
