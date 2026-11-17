/*
Finding 028, B-1: requests pipelined on one socket (DESIGN v1.16 §3, SA R2).
Two sets sent before the stream is even initialized (the server's
stream-initialized await) commit, and are acked, in the order they were sent;
a set is acked only once it is committed.
*/

import { before, after, connect } from "@cocalc/backend/conat/test/setup";
import { stream } from "@cocalc/conat/persist/client";
import { messageData } from "@cocalc/conat/core/client";

beforeAll(before);
afterAll(after);

jest.setTimeout(15000);

describe("028 B-1: pipelined requests", () => {
  it("two sets pipelined while the stream initializes commit in the order sent", async () => {
    const client = connect();
    const s = stream({
      client,
      user: { hub_id: "x" },
      storage: { path: "hub/028-pipelined" },
    });
    try {
      // no await between them: both reach the server before the stream is
      // initialized there
      const [a, b] = await Promise.all([
        s.set({ messageData: messageData("first") }),
        s.set({ messageData: messageData("second") }),
      ]);
      expect(a.seq).toBeLessThan(b.seq);
      const first = await s.get({ seq: a.seq });
      const second = await s.get({ seq: b.seq });
      expect(first.data).toBe("first");
      expect(second.data).toBe("second");
      // and a set pipelined with a read after its ack: visible
      const c = await s.set({ messageData: messageData("third") });
      expect((await s.get({ seq: c.seq })).data).toBe("third");
    } finally {
      s.close();
      client.close();
    }
  });
});
