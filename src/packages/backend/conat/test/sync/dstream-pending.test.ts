/*
A dstream's unsaved messages, counted in O(1) (bounded history plan H1b-2):
the transition after a history reset reads them, so a write the history
fence refuses is kept, not dropped.

pnpm test ./dstream-pending.test.ts
*/

import { createDstream as create } from "./util";
import { before, after } from "@cocalc/backend/conat/test/setup";

beforeAll(before);
afterAll(after);

jest.setTimeout(20000);

describe("pending messages and the history fence", () => {
  let s;

  it("counts what is published and not yet saved", async () => {
    s = await create();
    s.setPendingSizeOf((mesg) => mesg.patch.length);
    s.publish({ patch: "abc" });
    s.publish({ patch: "de" });
    expect(s.pendingStats()).toEqual({ count: 2, bytes: 5 });
    expect(s.pendingMessages().map(({ mesg }) => mesg.patch)).toEqual([
      "abc",
      "de",
    ]);
    await s.save();
    expect(s.pendingStats()).toEqual({ count: 0, bytes: 0 });
    expect(s.pendingMessages()).toEqual([]);
  });

  it("keeps a write the fence refuses, apart from the ones to retry", async () => {
    await s.config({ required_headers: { history_epoch: 1 } });
    s.publish({ patch: "old" }, { headers: { history_epoch: 0 } });
    s.publish({ patch: "new" }, { headers: { history_epoch: 1 } });
    await s.save();
    // the accepted one is saved; the refused one is kept, not retried
    expect(s.hasUnsavedChanges()).toBe(false);
    expect(s.hasRejectedChanges()).toBe(true);
    expect(
      s.pendingMessages().map(({ mesg, rejected }) => [mesg.patch, rejected]),
    ).toEqual([["old", true]]);
    expect(s.pendingStats()).toEqual({ count: 1, bytes: 3 });
    expect(s.getAll().map(({ patch }) => patch)).toContain("new");
  });

  it("rejected first, then unsaved; resizing keeps the totals exact", () => {
    s.publish({ patch: "abcd" }, { headers: { history_epoch: 1 } });
    expect(s.pendingMessages().map(({ mesg }) => mesg.patch)).toEqual([
      "old",
      "abcd",
    ]);
    s.setPendingSizeOf(() => 100);
    expect(s.pendingStats()).toEqual({ count: 2, bytes: 200 });
  });

  it("forgetting the refused ones", () => {
    const ids = s
      .pendingMessages()
      .filter(({ rejected }) => rejected)
      .map(({ id }) => id);
    s.forgetRejected(ids);
    expect(s.hasRejectedChanges()).toBe(false);
    expect(s.pendingStats()).toEqual({ count: 1, bytes: 100 });
    s.close();
  });

  it("other refusals are dropped as before", async () => {
    const t = await create();
    await t.config({ max_msgs: 1, discard_policy: "new" });
    t.publish({ patch: "a" });
    await t.save();
    t.publish({ patch: "b" });
    await t.save();
    expect(t.hasRejectedChanges()).toBe(false);
    expect(t.pendingStats().count).toBe(0);
    t.close();
  });
});
