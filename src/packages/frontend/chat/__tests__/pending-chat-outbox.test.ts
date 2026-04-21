jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    browser_id: "browser-test",
  },
}));

import {
  BrowserOutboxStore,
  MemoryBrowserOutboxBackend,
  setDefaultBrowserOutboxForTests,
} from "@cocalc/frontend/browser-outbox";
import {
  claimPendingChatSend,
  getPendingChatBrowserSessionId,
  isCurrentPendingChatSession,
  listPendingChatSends,
  removePendingChatSend,
  storePendingChatSend,
} from "../pending-chat-outbox";

describe("pending chat outbox", () => {
  beforeEach(() => {
    setDefaultBrowserOutboxForTests(
      new BrowserOutboxStore({
        backend: new MemoryBrowserOutboxBackend(),
      }),
    );
  });

  afterEach(() => {
    setDefaultBrowserOutboxForTests(undefined);
  });

  it("stores, claims, and removes pending chat sends by chat path", async () => {
    const pending = {
      project_id: "project-1",
      path: "x.chat",
      browser_session_id: getPendingChatBrowserSessionId(),
      sender_id: "user-1",
      input: "do the important thing",
      date: "2026-04-19T12:00:00.000Z",
      message_id: "message-1",
      thread_id: "thread-1",
      shouldMarkNotSent: true,
    };

    await storePendingChatSend(pending);
    expect(
      (await listPendingChatSends({ project_id: "project-1", path: "x.chat" }))
        .length,
    ).toBe(1);
    expect(
      await listPendingChatSends({ project_id: "project-1", path: "y.chat" }),
    ).toEqual([]);

    const [entry] = await listPendingChatSends({
      project_id: "project-1",
      path: "x.chat",
    });
    const claimed = await claimPendingChatSend(entry);
    expect(claimed?.payload?.message_id).toBe("message-1");
    expect(claimed?.payload?.shouldMarkNotSent).toBe(true);
    expect(isCurrentPendingChatSession(claimed?.payload)).toBe(true);

    await removePendingChatSend(pending);
    expect(
      await listPendingChatSends({ project_id: "project-1", path: "x.chat" }),
    ).toEqual([]);
  });
});
