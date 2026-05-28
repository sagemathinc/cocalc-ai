import { render, screen } from "@testing-library/react";
import { from_str } from "@cocalc/sync/editor/immer-db/doc";
import PublicViewerChatRenderer from "./renderers/chat";

test("renders chat content as a readable transcript", async () => {
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

  expect(await screen.findByText("Demo Thread")).toBeTruthy();
  expect(await screen.findByText("alice")).toBeTruthy();
  expect(await screen.findByText("Hello from chat")).toBeTruthy();
  expect(await screen.findByText("This is a shared log.")).toBeTruthy();
});

test("renders native chat files stored as immer syncdb content", async () => {
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

  render(
    <PublicViewerChatRenderer
      content={doc.to_str()}
      fileContext={{ noSanitize: false }}
    />,
  );

  expect(await screen.findByText("Native Thread")).toBeTruthy();
  expect(await screen.findByText("bob")).toBeTruthy();
  expect(
    await screen.findByText("Rendered from the project-host file."),
  ).toBeTruthy();
});
