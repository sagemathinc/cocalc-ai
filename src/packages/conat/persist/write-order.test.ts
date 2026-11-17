/*
028 B-3a (AS-B3-ORDER-1, SA 3381, astra, review): the per-connection write
order state, alone.  The storage and client tests use it end to end
(backend/conat/test/persist/durable-write-order.test.ts).
*/

import {
  MAX_REFUSED,
  parseWriteOrder,
  writeOrderError,
  WriteOrderState,
} from "./write-order";

describe("028 B-3a: WriteOrderState", () => {
  it("in order: each write is admitted", () => {
    const st = new WriteOrderState();
    for (let w = 1; w <= 5; w++) {
      expect(st.check(w, 1)).toBe("ok");
      st.noteAdmitted(w);
    }
  });

  it("a refused write blocks every later one until it is resent and admitted", () => {
    const st = new WriteOrderState();
    expect(st.check(1, 1)).toBe("ok");
    st.noteRefused(1); // the budget refused A
    expect(st.check(2, 1)).toBe("blocked");
    st.noteRefused(2);
    expect(st.check(3, 1)).toBe("blocked");
    st.noteRefused(3);
    // A's resend
    expect(st.check(1, 1)).toBe("ok");
    st.noteAdmitted(1);
    // B is still refused, so C still waits; B's resend goes
    expect(st.check(3, 2)).toBe("blocked");
    expect(st.check(2, 2)).toBe("ok");
    st.noteAdmitted(2);
    expect(st.check(3, 3)).toBe("ok");
  });

  it("GAP: a later write that arrives before an earlier one (in transit, e.g. across a reconnect) is blocked until the earlier one is seen", () => {
    const st = new WriteOrderState();
    expect(st.check(2, 1)).toBe("blocked"); // 1 not seen yet
    st.noteRefused(2);
    expect(st.check(1, 1)).toBe("ok");
    st.noteAdmitted(1);
    expect(st.check(2, 2)).toBe("ok");
  });

  it("a NEW connection: writes the client sent elsewhere and has not resolved block until they are resolved (the floor passes them)", () => {
    const st = new WriteOrderState();
    // the client still waits for 3 and 4 (sent on the old connection)
    expect(st.check(5, 3)).toBe("blocked");
    st.noteRefused(5);
    // it resolved 3 and 4 (answers, or timeouts): its floor is now 5
    expect(st.check(5, 5)).toBe("ok");
  });

  it("STALE: a late copy of a write the client gave up on is rejected after the floor passed it (never applied)", () => {
    const st = new WriteOrderState();
    expect(st.check(1, 1)).toBe("ok");
    st.noteRefused(1); // A refused
    // the client gave up on A: B carries floor 2, and A's entry is dropped
    expect(st.check(2, 2)).toBe("ok");
    st.noteAdmitted(2);
    expect(st.refusedCount()).toBe(0);
    // a late copy of A (sent before the give-up, delayed) arrives
    expect(st.check(1, 1)).toBe("stale");
  });

  it("the floor never goes down: an old request with a lower wfloor can't reopen an abandoned wseq", () => {
    const st = new WriteOrderState();
    expect(st.check(4, 4)).toBe("ok");
    st.noteAdmitted(4);
    expect(st.check(5, 1)).toBe("ok"); // an older floor: ignored
    expect(st.floor).toBe(4);
    expect(st.check(3, 1)).toBe("stale");
    expect(st.check(2, 2)).toBe("stale");
  });

  it("a wfloor prunes only entries BELOW it (a live fence at or above the floor stays)", () => {
    const st = new WriteOrderState();
    st.check(1, 1);
    st.noteRefused(1);
    st.check(2, 1);
    st.noteRefused(2);
    expect(st.check(3, 2)).toBe("blocked"); // floor 2 drops 1, keeps 2
    expect(st.refusedCount()).toBe(1); // 2
    st.noteRefused(3);
    expect(st.check(2, 2)).toBe("ok"); // 2's resend
    st.noteAdmitted(2);
    expect(st.check(3, 3)).toBe("ok");
  });

  it("two connections are independent: one's refusal blocks nothing of the other", () => {
    const a = new WriteOrderState();
    const b = new WriteOrderState();
    a.check(1, 1);
    a.noteRefused(1);
    expect(a.check(2, 1)).toBe("blocked");
    expect(b.check(1, 1)).toBe("ok");
    expect(b.check(2, 1)).toBe("ok");
  });

  it(`bounded: at ${MAX_REFUSED} refused entries every further write fails closed (overflow); no live entry is evicted`, () => {
    const st = new WriteOrderState();
    expect(st.check(1, 1)).toBe("ok");
    st.noteRefused(1);
    for (let w = 2; w <= MAX_REFUSED; w++) {
      expect(st.check(w, 1)).toBe("blocked");
      expect(st.noteRefused(w)).toBe(true);
    }
    expect(st.refusedCount()).toBe(MAX_REFUSED);
    expect(st.check(MAX_REFUSED + 1, 1)).toBe("blocked");
    expect(st.noteRefused(MAX_REFUSED + 1)).toBe(false); // no room
    expect(st.refusedCount()).toBe(MAX_REFUSED); // nothing evicted
    // from now on, everything of this connection: overflow (even the head)
    expect(st.check(1, 1)).toBe("overflow");
    expect(st.check(MAX_REFUSED + 2, 1)).toBe("overflow");
  });

  it("parseWriteOrder: absent -> none; present -> strictly valid, else 400; a client-sent writer id is not used", () => {
    const st = new WriteOrderState();
    expect(parseWriteOrder({}, st)).toBeUndefined();
    expect(parseWriteOrder({ wseq: 3, wfloor: 2 }, st)).toEqual({ state: st, wseq: 3, wfloor: 2 });
    const o = parseWriteOrder({ wseq: 3, wfloor: 2, writer: "someone-else" } as any, st)!;
    expect(o.state).toBe(st); // the server's own per-connection state
    for (const bad of [
      { wseq: 3 },
      { wfloor: 1 },
      { wseq: "3", wfloor: 1 },
      { wseq: 3, wfloor: 0 },
      { wseq: 2, wfloor: 3 },
      { wseq: 1.5, wfloor: 1 },
      { wseq: Number.MAX_SAFE_INTEGER + 2, wfloor: 1 },
      { wseq: NaN, wfloor: 1 },
    ]) {
      expect(() => parseWriteOrder(bad as any, st)).toThrow("invalid write order");
    }
  });

  it("the errors: stale and overflow are not rate_limited (never resent)", () => {
    expect(writeOrderError("stale").code).toBe("write_stale");
    expect(writeOrderError("overflow").code).toBe("write_order_overflow");
  });
});
