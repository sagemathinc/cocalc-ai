import { act, renderHook } from "@testing-library/react";
import {
  clearSentFromReader,
  clearViewedTurnsForTests,
  noteSentFromReader,
  readerReplyContext,
  readerTurnKey,
  setViewedTurn,
  turnPreview,
  useSentFromReader,
  viewedTurn,
  viewedTurnNote,
} from "../reader-viewed-turn";

beforeEach(() => clearViewedTurnsForTests());

describe("the turn open in the reader", () => {
  const key = readerTurnKey("p", "a.chat", "t");

  it("needs no note when the newest turn is open", () => {
    expect(
      viewedTurnNote({ item_id: "m1", latest: true, preview: "hello" }),
    ).toBeUndefined();
    expect(viewedTurnNote(undefined)).toBeUndefined();
  });

  it("tells the agent which earlier turn was open", () => {
    const note = viewedTurnNote({
      item_id: "m1",
      latest: false,
      date: "2026-10-30T16:00:00.000Z",
      preview: 'Fix the "deploy" script',
    })!;
    expect(note).toMatch(/not written by the person/);
    expect(note).toMatch(/earlier turn of this conversation/);
    expect(note).toContain("2026-10-30T16:00:00.000Z");
    expect(note).toContain('"Fix the \\"deploy\\" script"');
  });

  it("is kept per thread, and a preview is one bounded line", () => {
    setViewedTurn(key, { item_id: "m1", latest: false });
    expect(viewedTurn(key)?.item_id).toBe("m1");
    expect(viewedTurn(readerTurnKey("p", "a.chat", "other"))).toBeUndefined();
    setViewedTurn(key, undefined);
    expect(viewedTurn(key)).toBeUndefined();
    const preview = turnPreview(`line one\n\nline two ${"x".repeat(300)}`);
    expect(preview.startsWith("line one line two")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(160);
  });

  it("publishes the message just sent, until it is cleared", () => {
    const { result } = renderHook(() => useSentFromReader(key));
    expect(result.current).toBeUndefined();
    act(() => noteSentFromReader(key, "msg-2"));
    expect(result.current).toBe("msg-2");
    act(() => clearSentFromReader(key));
    expect(result.current).toBeUndefined();
  });
});

describe("the composer's context for the agent", () => {
  const where = { projectId: "p", path: "a.chat", threadId: "t" };
  beforeEach(() =>
    setViewedTurn(readerTurnKey("p", "a.chat", "t"), {
      item_id: "m1",
      latest: false,
      preview: "older",
    }),
  );

  it("is added for an agent turn sent from the reader with an earlier turn open", () => {
    expect(
      readerReplyContext({ readerMode: true, agentTurn: true, ...where }),
    ).toMatch(/older/);
  });

  it("is not added outside the reader, to people, or for a new thread", () => {
    expect(
      readerReplyContext({ readerMode: false, agentTurn: true, ...where }),
    ).toBeUndefined();
    expect(
      readerReplyContext({ readerMode: true, agentTurn: false, ...where }),
    ).toBeUndefined();
    expect(
      readerReplyContext({
        readerMode: true,
        agentTurn: true,
        ...where,
        threadId: undefined,
      }),
    ).toBeUndefined();
  });
});
