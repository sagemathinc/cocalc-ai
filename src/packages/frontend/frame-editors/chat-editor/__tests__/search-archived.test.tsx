import { render, screen, waitFor } from "@testing-library/react";
import { search } from "../search";
import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";
import useSearchIndex from "@cocalc/frontend/frame-editors/generic/search/use-search-index";
import { webapp_client } from "@cocalc/frontend/webapp-client";

jest.mock("@cocalc/frontend/frame-editors/frame-tree/frame-context", () => ({
  useFrameContext: jest.fn(),
}));

jest.mock("@cocalc/frontend/frame-editors/generic/search/use-search-index", () =>
  jest.fn(),
);

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        projects: {
          chatStoreSearch: jest.fn(),
        },
      },
    },
  },
}));

jest.mock("@cocalc/frontend/components", () => ({
  TimeAgo: ({ date }: { date: number }) => <span>{date}</span>,
}));

describe("chat search archived integration", () => {
  const useFrameContextMock = useFrameContext as jest.Mock;
  const useSearchIndexMock = useSearchIndex as jest.Mock;
  const chatStoreSearchMock = (
    webapp_client.conat_client?.hub?.projects as any
  )?.chatStoreSearch as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    useSearchIndexMock.mockReturnValue({
      error: "",
      setError: jest.fn(),
      index: undefined,
      doRefresh: jest.fn(),
      fragmentKey: "chat",
      isIndexing: false,
    });
  });

  it("calls chatStoreSearch for thread scope when archived rows exist", async () => {
    const messages = new Map();
    const threadIndex = new Map([
      [
        "thread-1",
        {
          key: "thread-1",
          newestTime: Date.now(),
          messageKeys: new Set<string>(),
        },
      ],
    ]);
    const chatActions = {
      getAllMessages: () => messages,
      getThreadIndex: () => threadIndex,
      listThreadConfigRows: () => [],
      getThreadMetadata: () => ({ archived_chat_rows: 123 }),
      messageCache: undefined,
    };
    const frameActions = {
      getChatActions: () => chatActions,
    };
    useFrameContextMock.mockReturnValue({
      actions: frameActions,
      path: "lite2.chat",
      id: "frame-1",
      project_id: "project-1",
    });
    chatStoreSearchMock.mockResolvedValue({
      hits: [
        {
          segment_id: "seg-a",
          row_id: 7,
          date_ms: 1700000000000,
          snippet: "archived match",
        },
      ],
      total: 1,
      next_offset: undefined,
    });

    const Component = search.component as any;
    render(
      <Component
        font_size={14}
        desc={{
          get: (key: string) => (key === "data-search" ? "the" : undefined),
        }}
      />,
    );

    await waitFor(() => {
      expect(chatStoreSearchMock).toHaveBeenCalledWith(
        expect.objectContaining({
          project_id: "project-1",
          chat_path: "lite2.chat",
          query: "the",
          thread_id: "thread-1",
        }),
      );
    });

    expect(await screen.findByText("backend")).toBeTruthy();
    expect(await screen.findByText("archived match")).toBeTruthy();
  });
});
