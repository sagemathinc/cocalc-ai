import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { search } from "../search";
import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";
import useSearchIndex from "@cocalc/frontend/frame-editors/generic/search/use-search-index";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

jest.mock("@cocalc/frontend/frame-editors/frame-tree/frame-context", () => ({
  useFrameContext: jest.fn(),
}));

jest.mock(
  "@cocalc/frontend/frame-editors/generic/search/use-search-index",
  () => jest.fn(),
);

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        projects: {
          chatStoreSearch: jest.fn(),
          chatStoreReadArchived: jest.fn(),
          chatStoreReadArchivedHit: jest.fn(),
        },
      },
    },
  },
}));

jest.mock("@cocalc/frontend/components", () => ({
  TimeAgo: ({ date }: { date: number }) => <span>{date}</span>,
}));

jest.mock("antd", () => {
  const InputBase = ({ value, onChange, allowClear, ...props }: any) => (
    <input value={value ?? ""} onChange={(e) => onChange?.(e)} {...props} />
  );
  const InputSearch = ({
    value,
    onChange,
    onSearch,
    allowClear,
    optionFilterProp,
    ...props
  }: any) => (
    <input
      data-testid="chat-search-input"
      value={value ?? ""}
      onChange={(e) => onChange?.(e)}
      onKeyDown={(e: any) => {
        if (e.key === "Enter") onSearch?.((e.target as HTMLInputElement).value);
      }}
      {...props}
    />
  );
  return {
    Card: ({ children }: any) => <div>{children}</div>,
    Input: Object.assign(InputBase, { Search: InputSearch }),
  };
});

describe("chat search archived integration", () => {
  const useFrameContextMock = useFrameContext as jest.Mock;
  const useSearchIndexMock = useSearchIndex as jest.Mock;
  const chatStoreSearchMock = (webapp_client.conat_client?.hub?.projects as any)
    ?.chatStoreSearch as jest.Mock;
  const chatStoreReadArchivedMock = (
    webapp_client.conat_client?.hub?.projects as any
  )?.chatStoreReadArchived as jest.Mock;
  const chatStoreReadArchivedHitMock = (
    webapp_client.conat_client?.hub?.projects as any
  )?.chatStoreReadArchivedHit as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    chatStoreReadArchivedMock.mockResolvedValue({
      rows: [],
      next_offset: undefined,
    });
    chatStoreReadArchivedHitMock.mockResolvedValue({
      row: {
        row_id: 7,
        segment_id: "seg-a",
        thread_id: "thread-1",
        date_ms: 1700000099999,
        row: {
          event: "chat",
          date: "2023-11-14T22:14:59.999Z",
          thread_id: "thread-1",
          history: [{ content: "hydrated row" }],
        },
      },
    });
    useSearchIndexMock.mockReturnValue({
      error: "",
      setError: jest.fn(),
      index: undefined,
      doRefresh: jest.fn(),
      fragmentKey: "chat",
      isIndexing: false,
    });
  });

  it("calls chatStoreSearch in all-message scope when archived rows exist", async () => {
    const messages = new Map();
    const chatActions = {
      getAllMessages: () => messages,
      listThreadConfigRows: () => [
        {
          event: "chat-thread-config",
          thread_id: "thread-1",
          archived_chat_rows: 123,
          archived: false,
        },
      ],
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
          thread_id: undefined,
          exclude_thread_ids: [],
        }),
      );
    });

    expect(screen.queryByTestId("thread-scope-select")).toBeNull();
    expect(
      (await screen.findAllByText(/stored on backend/i)).length,
    ).toBeGreaterThan(0);
    expect(await screen.findByText("archived match")).toBeTruthy();
    const result = screen.getByText("stored on backend").parentElement!;
    expect(result.style.background).toBe(UI_COLORS.surface);
    expect(result.style.color).toBe(UI_COLORS.text);
    expect(screen.getByText("stored on backend").style.color).toBe(
      UI_COLORS.secondary,
    );
  });

  it("opens clicked backend hits through the chat actions", async () => {
    const now = Date.now();
    const messages = new Map([
      [
        "1700000000000",
        {
          date: "2026-02-20T00:00:00.000Z",
          thread_id: "thread-1",
          history: [{ content: "live thread one" }],
        },
      ],
      [
        "1700000001000",
        {
          date: "2026-02-20T00:00:01.000Z",
          thread_id: "thread-archived",
          history: [{ content: "live archived thread" }],
        },
      ],
    ]);
    const listThreadConfigRows = () => [
      {
        event: "chat-thread-config",
        thread_id: "thread-1",
        name: "Thread One",
        archived_chat_rows: 50,
        archived: false,
        updated_at: new Date(now).toISOString(),
      },
      {
        event: "chat-thread-config",
        thread_id: "thread-archived",
        name: "Thread Archived",
        archived_chat_rows: 60,
        archived: true,
        updated_at: new Date(now - 1000).toISOString(),
      },
    ];
    const chatActions = {
      getAllMessages: () => messages,
      listThreadConfigRows,
      hydrateArchivedRows: jest.fn(),
      clearAllFilters: jest.fn(),
      setSelectedThread: jest.fn(),
      scrollToDate: jest.fn(),
      messageCache: undefined,
    };
    const frameActions = {
      getChatActions: () => chatActions,
      gotoFragment: jest.fn(),
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
          thread_id: "thread-1",
          date_ms: 1700000099999,
          snippet: "cross-thread backend match",
        },
      ],
      total_hits: 1,
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
          thread_id: undefined,
          exclude_thread_ids: ["thread-archived"],
        }),
      );
    });

    fireEvent.click(await screen.findByText("cross-thread backend match"));

    await waitFor(() => {
      expect(chatStoreReadArchivedHitMock).toHaveBeenCalledWith(
        expect.objectContaining({
          project_id: "project-1",
          chat_path: "lite2.chat",
          row_id: 7,
          thread_id: "thread-1",
        }),
      );
      expect(chatActions.hydrateArchivedRows).toHaveBeenCalled();
      expect(frameActions.gotoFragment).toHaveBeenCalledWith({
        chat: "1700000099999",
        thread: "thread-1",
      });
      expect(chatActions.scrollToDate).not.toHaveBeenCalled();
    });
  });

  it("opens clicked live hits in their thread", async () => {
    const messages = new Map([
      [
        "1700000000000",
        {
          date: "2026-02-20T00:00:00.000Z",
          thread_id: "thread-live",
          history: [{ content: "live matched message" }],
        },
      ],
    ]);
    const chatActions = {
      getAllMessages: () => messages,
      listThreadConfigRows: () => [],
      clearAllFilters: jest.fn(),
      setSelectedThread: jest.fn(),
      scrollToDate: jest.fn(),
      messageCache: undefined,
    };
    const frameActions = {
      getChatActions: () => chatActions,
      set_frame_data: jest.fn(),
      gotoFragment: jest.fn(),
    };
    useFrameContextMock.mockReturnValue({
      actions: frameActions,
      path: "lite2.chat",
      id: "frame-1",
      project_id: "project-1",
    });
    useSearchIndexMock.mockReturnValue({
      error: "",
      setError: jest.fn(),
      index: {
        search: jest.fn().mockResolvedValue({
          hits: [
            {
              id: "1700000000000",
              document: {
                id: "1700000000000",
                content: "live matched message",
              },
            },
          ],
        }),
      },
      doRefresh: jest.fn(),
      fragmentKey: "chat",
      isIndexing: false,
    });

    const Component = search.component as any;
    render(
      <Component
        font_size={14}
        desc={{
          get: (key: string) => (key === "data-search" ? "matched" : undefined),
        }}
      />,
    );

    fireEvent.click(await screen.findByText("live matched message"));

    await waitFor(() => {
      expect(frameActions.gotoFragment).toHaveBeenCalledWith({
        chat: "1700000000000",
        thread: "thread-live",
      });
      expect(chatActions.scrollToDate).not.toHaveBeenCalled();
    });
  });
});
