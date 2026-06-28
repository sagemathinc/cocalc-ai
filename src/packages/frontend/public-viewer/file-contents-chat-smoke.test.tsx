import { render, screen } from "@testing-library/react";
import { from_str } from "@cocalc/sync/editor/immer-db/doc";
import { getSortedDates } from "@cocalc/frontend/chat/chat-log";
import PublicViewerChatRenderer, {
  createChatViewerDocument,
} from "./renderers/chat";

jest.mock("@cocalc/frontend/chat/viewer", () => ({
  __esModule: true,
  default: ({
    doc,
    readOnly,
    virtualized,
    showThreadList,
  }: {
    doc: () => any;
    readOnly?: boolean;
    virtualized?: boolean;
    showThreadList?: boolean;
  }) => {
    const rows = doc()?.get?.() ?? [];
    return (
      <div
        data-testid="chat-viewer"
        data-readonly={`${readOnly === true}`}
        data-virtualized={`${virtualized !== false}`}
        data-show-thread-list={`${showThreadList === true}`}
      >
        {JSON.stringify(rows)}
      </div>
    );
  },
}));

test("renders chat content with the real chat viewer adapter", async () => {
  const content = [
    JSON.stringify({
      event: "chat-thread-config",
      thread_id: "thread-1",
      name: "Demo Thread",
      date: "1970-01-01T00:00:00.000Z",
    }),
    JSON.stringify({
      event: "chat",
      sender_id: "alice",
      date: "2026-03-20T06:00:00.000Z",
      thread_id: "thread-1",
      history: [
        {
          author_id: "alice",
          content: "# Hello from chat\n\nThis is a shared log.",
          date: "2026-03-20T06:00:00.000Z",
        },
      ],
    }),
  ].join("\n");

  render(
    <PublicViewerChatRenderer
      content={content}
      fileContext={{ noSanitize: false }}
    />,
  );

  const viewer = await screen.findByTestId("chat-viewer");
  expect(viewer.dataset.readonly).toBe("true");
  expect(viewer.dataset.virtualized).toBe("false");
  expect(viewer.dataset.showThreadList).toBe("true");
  expect(viewer.parentElement).toHaveStyle({
    display: "flex",
    flexDirection: "column",
    height: "100%",
  });
  expect(viewer.textContent).toContain("chat-thread-config");
  expect(viewer.textContent).toContain("Demo Thread");
  expect(viewer.textContent).toContain("alice");
  expect(viewer.textContent).toContain("Hello from chat");
});

test("adapts native chat files stored as immer syncdb content", () => {
  const doc = from_str(
    "",
    ["date", "sender_id", "event", "message_id", "thread_id"],
    ["input"],
  )
    .set({
      event: "chat-thread-config",
      sender_id: "system",
      date: "2026-03-20T05:59:00.000Z",
      thread_id: "thread-2",
      name: "Native Thread",
    })
    .set({
      event: "chat",
      sender_id: "bob",
      date: "2026-03-20T06:00:00.000Z",
      message_id: "msg-1",
      thread_id: "thread-2",
      history: [
        {
          author_id: "bob",
          content: "Rendered from the project-host file.",
          date: "2026-03-20T06:00:00.000Z",
        },
      ],
    });

  const rows = createChatViewerDocument(doc.to_str()).get() as any[];
  expect(rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event: "chat-thread-config",
        name: "Native Thread",
      }),
      expect.objectContaining({
        event: "chat",
        sender_id: "bob",
        message_id: "msg-1",
      }),
    ]),
  );
});

test("parsed json-lines chat rows produce visible chat dates", () => {
  const content = [
    JSON.stringify({
      event: "chat",
      sender_id: "gpt-5.4-mini",
      date: "2026-06-28T21:29:10.604Z",
      history: [
        {
          author_id: "gpt-5.4-mini",
          content: "Codex authentication expired.",
          date: "2026-06-28T21:29:29.581Z",
        },
      ],
      message_id: "assistant-1",
      thread_id: "thread-1",
      parent_message_id: "human-1",
    }),
    JSON.stringify({
      sender_id: "user-1",
      event: "chat",
      schema_version: 2,
      history: [
        {
          author_id: "user-1",
          content: "hi ther",
          date: "2026-06-28T21:29:38.136Z",
        },
      ],
      date: "2026-06-28T21:29:38.136Z",
      message_id: "human-2",
      thread_id: "thread-2",
      editing: {},
    }),
  ].join("\n");
  const rows = createChatViewerDocument(content).get() as any[];
  const messages = new Map<string, any>();
  for (const row of rows) {
    messages.set(`${new Date(row.date).valueOf()}`, {
      ...row,
      date: new Date(row.date),
    });
  }

  const { dates } = getSortedDates(messages as any, "user-1");

  expect(dates).toHaveLength(2);
});
