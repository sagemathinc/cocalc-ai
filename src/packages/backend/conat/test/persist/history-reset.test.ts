/*
The seeded reset and the inclusion query through a persist server: the seed's
bytes survive the request, and a client learns which of its patches the reset
included.
*/

import { before, after, connect } from "@cocalc/backend/conat/test/setup";
import { stream } from "@cocalc/conat/persist/client";
import { messageData } from "@cocalc/conat/core/client";
import { DataEncoding, encode, decode } from "@cocalc/conat/core/codec";

beforeAll(before);
afterAll(after);
jest.setTimeout(10_000);

describe("resetHistory with a seed, through the persist server", () => {
  it("inserts the seed, sets its checkpoint, and reports what it included", async () => {
    const client = connect();
    const persisted = stream({
      client,
      user: { hub_id: "test" },
      storage: { path: `hub/history-reset-${Math.random()}` },
    });
    try {
      await persisted.set({ messageData: messageData("a"), msgID: "a" });
      await persisted.set({ messageData: messageData("b"), msgID: "b" });
      const { seq, count } = await persisted.inventory();
      const value = "x".repeat(100_000);
      const raw = encode({
        encoding: DataEncoding.MsgPack,
        mesg: { is_snapshot: true, snapshot: value, time: "t" },
      });
      const opts = {
        ifRevision: { seq, count },
        ifInitEpoch: 0,
        coveredSeq: seq,
        archive: true,
        opId: "op-1",
        seed: {
          encoding: DataEncoding.MsgPack,
          raw,
          msgID: "seed",
          checkpoint: { name: "latest_snapshot", data: { patchId: "t" } },
        },
      };
      const result = await persisted.resetHistory(opts);
      expect(result).toMatchObject({
        reset: true,
        history_epoch: 1,
        seedSeq: 3,
        coveredSeq: 2,
      });
      // a lost reply: the retry gets the same result
      expect(await persisted.resetHistory(opts)).toEqual({
        ...result,
        repeated: true,
      });

      const { messages, checkpoints } = await persisted.getAllWithInfo({
        start_checkpoint: "latest_snapshot",
      });
      expect(messages.map(({ seq }) => seq)).toEqual([3]);
      expect(
        decode({ encoding: messages[0].encoding, data: messages[0].raw })
          .snapshot,
      ).toBe(value);
      expect(checkpoints?.latest_snapshot?.seq).toBe(3);

      expect(
        await persisted.historyInclusion({ epoch: 0, ids: ["a", "b", "c"] }),
      ).toEqual({
        history_epoch: 1,
        ids: {
          a: { status: "included", seq: 1 },
          b: { status: "included", seq: 2 },
          c: { status: "absent" },
        },
      });
    } finally {
      persisted.close();
      client.close();
    }
  });
});
