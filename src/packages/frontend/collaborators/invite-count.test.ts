import {
  getUnreadIncomingInviteCount,
  setUnreadIncomingInviteCount,
  subscribeUnreadIncomingInviteCount,
} from "./invite-count";

describe("invite unread count", () => {
  afterEach(() => {
    setUnreadIncomingInviteCount(0);
  });

  it("normalizes and publishes unread invite counts", () => {
    const seen: number[] = [];
    const unsubscribe = subscribeUnreadIncomingInviteCount((count) => {
      seen.push(count);
    });
    try {
      setUnreadIncomingInviteCount(3.9);
      expect(getUnreadIncomingInviteCount()).toBe(3);
      setUnreadIncomingInviteCount(-10);
      expect(getUnreadIncomingInviteCount()).toBe(0);
    } finally {
      unsubscribe();
    }
    expect(seen).toEqual([3, 0]);
  });
});
