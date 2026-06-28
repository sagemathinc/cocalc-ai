import { render, screen } from "@testing-library/react";
import { from_str } from "@cocalc/sync/editor/immer-db/doc";
import PublicViewerChatRenderer, {
  createChatViewerDocument,
} from "./renderers/chat";

jest.mock("@cocalc/frontend/chat/viewer", () => ({
  __esModule: true,
  default: ({ doc, readOnly }: { doc: () => any; readOnly?: boolean }) => {
    const rows = doc()?.get?.() ?? [];
    return (
      <div data-testid="chat-viewer" data-readonly={`${readOnly === true}`}>
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
