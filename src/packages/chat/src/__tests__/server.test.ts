import { EventEmitter } from "node:events";

const mockImmerdb = jest.fn();

jest.mock("@cocalc/conat/sync-doc/immer-db", () => ({
  immerdb: (...args: any[]) => mockImmerdb(...args),
}));

jest.mock("@cocalc/conat/logger", () => ({
  getLogger: () => ({
    debug: jest.fn(),
  }),
}));

import {
  acquireChatSyncDB,
  canonicalChatPath,
  releaseChatSyncDB,
} from "../server";

class MockSyncDB extends EventEmitter {
  close = jest.fn(async () => {});

  constructor(private readonly ready: boolean) {
    super();
  }

  isReady(): boolean {
    return this.ready;
  }
}

describe("chat SyncDB pool", () => {
  it("canonicalizes relative project chat paths under the project home", () => {
    expect(canonicalChatPath("thread.chat")).toBe("/home/user/thread.chat");
    expect(canonicalChatPath("./nested/../thread.chat")).toBe(
      "/home/user/thread.chat",
    );
    expect(canonicalChatPath("/tmp/thread.chat")).toBe("/tmp/thread.chat");
  });

  it("pools relative and absolute names for the same project chat", async () => {
    const ready = new MockSyncDB(true);
    mockImmerdb.mockReturnValueOnce(ready);
    const opts = {
      client: {} as any,
      project_id: "project-canonical",
      path: "nested/test.chat",
    };

    await expect(acquireChatSyncDB(opts)).resolves.toBe(ready);
    await expect(
      acquireChatSyncDB({
        ...opts,
        path: "/home/user/nested/test.chat",
      }),
    ).resolves.toBe(ready);
    expect(mockImmerdb).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/home/user/nested/test.chat" }),
    );

    await releaseChatSyncDB(opts.project_id, opts.path);
    await releaseChatSyncDB(opts.project_id, "/home/user/nested/test.chat");
  });

  it("times out a stalled open and releases its lease", async () => {
    const stalled = new MockSyncDB(false);
    const ready = new MockSyncDB(true);
    mockImmerdb.mockReturnValueOnce(stalled).mockReturnValueOnce(ready);
    const opts = {
      client: {} as any,
      project_id: "project-1",
      path: "/root/test.chat",
      readyTimeoutMs: 5,
    };

    await expect(acquireChatSyncDB(opts)).rejects.toThrow(
      "timed out waiting for chat SyncDB",
    );
    expect(stalled.close).toHaveBeenCalledTimes(1);

    await expect(acquireChatSyncDB(opts)).resolves.toBe(ready);
    await releaseChatSyncDB(opts.project_id, opts.path);
  });
});
