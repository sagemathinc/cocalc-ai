import { render, screen } from "@testing-library/react";
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
