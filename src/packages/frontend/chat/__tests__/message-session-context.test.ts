/** @jest-environment jsdom */

import { resolveThreadMetadataLookup } from "../message";

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
