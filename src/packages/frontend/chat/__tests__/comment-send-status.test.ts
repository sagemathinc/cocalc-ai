import {
  commentSendStatus,
  waitForCommentAcceptance,
} from "../comment-send-status";

test("missing acknowledgment times out rather than reporting success", async () => {
  jest.useFakeTimers();
  try {
    const result = waitForCommentAcceptance(
      {} as any,
      "m",
      new AbortController().signal,
    );
    const check = expect(result).rejects.toThrow(
      "Agent submission not confirmed",
    );
    await jest.advanceTimersByTimeAsync(30_000);
    await check;
  } finally {
    jest.useRealTimers();
  }
});

test("a local row alone never acknowledges agent submission", () => {
  expect(
    commentSendStatus(
      { getMessageById: () => ({ message_id: "m" }) } as any,
      "m",
    ),
  ).toBe("unconfirmed");
});

test("a backend-owned reply acknowledges a recovered submission", () => {
  expect(
    commentSendStatus(
      {
        getAllMessages: () =>
          new Map([["r", { parent_message_id: "m", acp_started_at_ms: 123 }]]),
      } as any,
      "m",
    ),
  ).toBe("accepted");
});

test("a locally written error reply is not backend acceptance", () => {
  expect(
    commentSendStatus(
      {
        getAllMessages: () =>
          new Map([["r", { parent_message_id: "m", history: [] }]]),
      } as any,
      "m",
    ),
  ).toBe("unconfirmed");
});
