/*
Testing retained-history gap detection for reconnecting stream clients.

DEVELOPMENT:

pnpm test ./history-gap.test.ts
*/

import { before, after, connect, wait } from "@cocalc/backend/conat/test/setup";
import { dstream as createDstream } from "@cocalc/backend/conat/sync";
import { DStream } from "@cocalc/conat/sync/dstream";

beforeAll(before);

jest.setTimeout(15000);

describe("retained-history info for dstream replay", () => {
  const name = `history-gap-${Math.random()}`;
  let s, t, client2;

  it("creates a stream with a small retention window and writes three messages", async () => {
    s = await createDstream({
      name,
      noAutosave: true,
      config: { max_msgs: 2 },
    });
    s.push("one", "two", "three");
    await s.save();
    await wait({ until: () => s.length == 2 });
    expect(s.getAll()).toEqual(["two", "three"]);
  });

  it("low-level getAllWithInfo reports the retained-history bounds", async () => {
    const info = await (s as any).stream.persistClient.getAllWithInfo({
      start_seq: 1,
    });
    expect(info.messages.map(({ seq }) => seq)).toEqual([2, 3]);
    expect(info.oldest_retained_seq).toBe(2);
    expect(info.newest_retained_seq).toBe(3);
    expect(info.effective_start_seq).toBe(2);
  });

  it("a new dstream starting too far back emits history-gap and still loads retained messages", async () => {
    client2 = connect();
    const historyGaps: any[] = [];
    t = new DStream({
      client: client2,
      name,
      noAutosave: true,
      noCache: true,
      start_seq: 1,
    });
    t.on("history-gap", (info) => {
      historyGaps.push(info);
    });
    await t.init();

    await wait({ until: () => historyGaps.length == 1 });
    expect(historyGaps).toEqual([
      {
        requested_start_seq: 1,
        effective_start_seq: 2,
        oldest_retained_seq: 2,
        newest_retained_seq: 3,
      },
    ]);
    expect(t.getAll()).toEqual(["two", "three"]);
  });

  it("starting within retained history does not emit history-gap", async () => {
    const client3 = connect();
    const u = new DStream({
      client: client3,
      name,
      noAutosave: true,
      noCache: true,
      start_seq: 2,
    });
    const historyGaps: any[] = [];
    u.on("history-gap", (info) => {
      historyGaps.push(info);
    });
    await u.init();
    await wait({ until: () => u.length == 2 });
    expect(historyGaps).toEqual([]);
    expect(u.getAll()).toEqual(["two", "three"]);
    u.close();
    client3.close();
  });

  it("cleans up", async () => {
    await s?.close?.();
    await t?.close?.();
    client2?.close?.();
  });
});

afterAll(after);
