import { meta_file } from "@cocalc/util/misc";

import {
  getSideChatPath,
  hasUnreadSideChat,
  listUnreadChatThreads,
} from "../unread";

describe("chat unread helpers", () => {
  it("keeps explicit chat paths unchanged", () => {
    expect(getSideChatPath(".notes.ipynb.sage-chat")).toBe(
      ".notes.ipynb.sage-chat",
    );
  });

  it("derives the side chat path for ordinary documents", () => {
    expect(getSideChatPath("notes.ipynb")).toBe(
      meta_file("notes.ipynb", "chat"),
    );
  });

  it("lists only unread non-archived threads when read state is ready", () => {
    const actions = {
      isProjectReadStateReady: jest.fn(() => true),
      getThreadIndex: jest.fn(
        () =>
          new Map([
            ["thread-1", { key: "thread-1", messageCount: 4 }],
            ["thread-2", { key: "thread-2", messageCount: 2 }],
            ["thread-3", { key: "thread-3", messageCount: 1 }],
          ]),
      ),
      getThreadMetadata: jest.fn((threadKey: string) =>
        threadKey === "thread-3" ? { archived: true } : undefined,
      ),
      getThreadReadCount: jest.fn((threadKey: string) => {
        switch (threadKey) {
          case "thread-1":
            return 3;
          case "thread-2":
            return 2;
          default:
            return 0;
        }
      }),
    } as any;

    expect(
      listUnreadChatThreads({
        actions,
        account_id: "acct-1",
      }),
    ).toEqual([{ key: "thread-1", messageCount: 4 }]);
    expect(
      hasUnreadSideChat({
        actions,
        account_id: "acct-1",
      }),
    ).toBe(true);
  });

  it("suppresses unread threads while read state is still loading", () => {
    const actions = {
      isProjectReadStateReady: jest.fn(() => false),
      getThreadIndex: jest.fn(
        () => new Map([["thread-1", { messageCount: 2 }]]),
      ),
    } as any;

    expect(
      listUnreadChatThreads({
        actions,
        account_id: "acct-1",
      }),
    ).toEqual([]);
    expect(
      hasUnreadSideChat({
        actions,
        account_id: "acct-1",
      }),
    ).toBe(false);
  });
});
