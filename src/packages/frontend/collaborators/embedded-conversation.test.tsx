import { act, render, screen, waitFor } from "@testing-library/react";
import { EmbeddedConversation } from "./embedded-conversation";
import type { CollaborationResource } from "@cocalc/util/collaborators";

const mockOpen = jest.fn();
const mockClose = jest.fn();
const mockStat = jest.fn();
let mockAlreadyOpen = false;
const mockEmbedding = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: () => ({ get: () => "alice" }),
    getProjectActions: () => ({
      fs: () => ({ stat: mockStat }),
      open_file: mockOpen,
      close_file: mockClose,
    }),
    getProjectStore: () => ({
      get: (key: string) =>
        key === "open_files"
          ? { has: () => mockAlreadyOpen }
          : { includes: () => false },
    }),
  },
}));
jest.mock("@cocalc/frontend/app-framework/project-runtime", () => ({
  ensureProjectReduxRuntime: async () => {},
}));
jest.mock("@cocalc/frontend/project/context", () => ({
  ProjectContext: require("react").createContext({}),
  useProjectContextProvider: () => ({}),
}));
jest.mock("@cocalc/frontend/project/page/content", () => ({
  EmbeddedProjectFile: ({ path }) => (
    <div role="region" aria-label="Shared editor">
      {path}
    </div>
  ),
}));
jest.mock("@cocalc/frontend/chat/embedding-options", () => ({
  ChatEmbeddingOptionsProvider: ({ children, value }) => {
    mockEmbedding(value);
    return children;
  },
}));

const resource: CollaborationResource = {
  project_id: "project",
  resource_id: "agent",
  kind: "agent",
  title: "Shared research",
  chat_path: "/shared.chat",
  thread_id: "same-thread",
  participant_ids: [],
  created_at: 1,
  updated_at: 1,
  activity: 0,
};
beforeEach(() => {
  jest.clearAllMocks();
  mockAlreadyOpen = false;
  mockStat.mockResolvedValue({});
  mockOpen.mockResolvedValue(undefined);
});

test("opens the exact existing thread embedded without changing project/history or identity", async () => {
  const view = render(
    <EmbeddedConversation accountId="alice" resource={resource} />,
  );
  expect(
    await screen.findByRole("region", { name: "Shared editor" }),
  ).toHaveTextContent("/shared.chat");
  expect(mockOpen).toHaveBeenCalledWith({
    path: "/shared.chat",
    embedded: true,
    foreground: false,
    foreground_project: false,
    wait_for_ready: true,
    change_history: false,
    fragmentId: { thread: "same-thread" },
  });
  expect(mockEmbedding).toHaveBeenCalledWith(
    expect.objectContaining({
      openFilesInWorkbench: true,
      disableConversationFocus: true,
    }),
  );
  view.unmount();
  expect(mockClose).toHaveBeenCalledWith("/shared.chat");
});

test("does not close a pre-existing project editor on deselection", async () => {
  mockAlreadyOpen = true;
  const view = render(
    <EmbeddedConversation accountId="alice" resource={resource} />,
  );
  await screen.findByRole("region", { name: "Shared editor" });
  view.unmount();
  expect(mockClose).not.toHaveBeenCalled();
});

test("missing source files fail without creating an empty replacement", async () => {
  mockStat.mockRejectedValue(Error("Source was deleted"));
  render(<EmbeddedConversation accountId="alice" resource={resource} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Source was deleted",
  );
  expect(mockOpen).not.toHaveBeenCalled();
});

test("late file stat after deselection does not open a runtime", async () => {
  let resolve!: (value: unknown) => void;
  mockStat.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const view = render(
    <EmbeddedConversation accountId="alice" resource={resource} />,
  );
  await waitFor(() => expect(mockStat).toHaveBeenCalled());
  view.unmount();
  await act(async () => resolve({}));
  expect(mockOpen).not.toHaveBeenCalled();
});
