/** @jest-environment jsdom */

import {
  resolveMessageGitBrowserRequest,
  resolveForkThreadNavigation,
  resolveThreadMetadataLookup,
} from "../message";

describe("resolveThreadMetadataLookup", () => {
  it("prefers message thread_id over root timestamp lookup", () => {
    expect(
      resolveThreadMetadataLookup({
        messageThreadId: "thread-abc-123",
        threadRootMs: 1700000000000,
      }),
    ).toEqual({
      threadLookupKey: "thread-abc-123",
      threadId: "thread-abc-123",
    });
  });

  it("falls back to root timestamp only when thread_id is missing", () => {
    expect(
      resolveThreadMetadataLookup({
        messageThreadId: undefined,
        threadRootMs: 1700000000000,
      }),
    ).toEqual({
      threadLookupKey: "1700000000000",
      threadId: undefined,
    });
  });
});

describe("resolveForkThreadNavigation", () => {
  it("selects the canonical original thread_id instead of the root timestamp key", () => {
    const rootDate = "2026-03-11T20:00:00.000Z";
    const latestDate = "2026-03-11T20:05:00.000Z";
    const actions = {
      getMessageByDate: (date: Date) => {
        const iso = date.toISOString();
        if (iso === rootDate || iso === latestDate) {
          return {
            thread_id: "11111111-1111-4111-8111-111111111111",
          } as any;
        }
        return undefined;
      },
    };

    expect(
      resolveForkThreadNavigation({
        actions: actions as any,
        message: {
          forked_from_root_date: rootDate,
          forked_from_latest_message_date: latestDate,
          forked_from_title: "Original thread",
        } as any,
      }),
    ).toEqual({
      threadKey: "11111111-1111-4111-8111-111111111111",
      fragment: `${new Date(latestDate).valueOf()}`,
      title: "Original thread",
    });
  });

  it("falls back to fragment-only navigation when the original thread is not loaded", () => {
    const rootDate = "2026-03-11T20:00:00.000Z";

    expect(
      resolveForkThreadNavigation({
        actions: {
          getMessageByDate: () => undefined,
        } as any,
        message: {
          forked_from_root_date: rootDate,
        } as any,
      }),
    ).toEqual({
      threadKey: undefined,
      fragment: `${new Date(rootDate).valueOf()}`,
      title: undefined,
    });
  });
});

describe("resolveMessageGitBrowserRequest", () => {
  it("targets the canonical thread id and first mentioned commit when present", () => {
    expect(
      resolveMessageGitBrowserRequest({
        messageThreadId: "thread-abc",
        date: 1700000000000,
        activityBasePath: "/work/repo",
        renderedMessageValue: "Please inspect commit abcdef1234567 next.",
      }),
    ).toEqual({
      threadKey: "thread-abc",
      cwdOverride: "/work/repo",
      commitHash: "abcdef1234567",
    });
  });

  it("falls back to HEAD and the row date when thread metadata is missing", () => {
    expect(
      resolveMessageGitBrowserRequest({
        messageThreadId: undefined,
        date: 1700000000000,
        activityBasePath: undefined,
        renderedMessageValue: "No commit hash here.",
      }),
    ).toEqual({
      threadKey: "1700000000000",
      cwdOverride: undefined,
      commitHash: "HEAD",
    });
  });
});
