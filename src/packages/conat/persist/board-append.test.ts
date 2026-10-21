/*
 * The append cache advances only with records the store actually wrote
 * (astra CORR-ABB-1): if a record the check took as new comes back with a
 * seq that isn't new (deduplicated into another record's, say), the graph
 * is read from the stream again before the next append.
 */

import { encode, DataEncoding } from "@cocalc/conat/core/codec";
import { appendCheck, appendHead, commitAppend } from "./board-append";

const patch = (time: string, parents: string[] = []) => ({
  time,
  parents,
  patch: "[]",
  is_snapshot: false,
});

// A stored stream of these records, at seqs 1, 2, ...
function fakeStream(records: object[]) {
  const stored = records.map((mesg) => ({
    encoding: DataEncoding.MsgPack,
    raw: Buffer.from(encode({ encoding: DataEncoding.MsgPack, mesg })),
  }));
  return {
    stored,
    seqBounds: () => ({ newest_retained_seq: stored.length || undefined }),
    getAll: () => stored,
  };
}

const record = (mesg: object) => ({
  value: mesg,
  digest: JSON.stringify(mesg),
  bytes: encode({ encoding: DataEncoding.MsgPack, mesg }).length,
});

test("a record taken as new but not written: the cache is dropped, and read again from the stream", () => {
  const stream = fakeStream([patch("A")]);
  const append = appendCheck(stream, [record(patch("B", ["A"]))]);
  expect(append.next.fresh).toEqual([true]);
  // The store returns A's seq (1) for B: B wasn't written.
  commitAppend(stream, append, [{ seq: 1 }]);
  // The graph is read again: the head is A, as the stream has it.
  expect(appendHead(stream)).toBe("A");
});

test("every new record written: the cache advances", () => {
  const stream = fakeStream([patch("A")]);
  const append = appendCheck(stream, [record(patch("B", ["A"]))]);
  stream.stored.push({
    encoding: DataEncoding.MsgPack,
    raw: Buffer.from(
      encode({ encoding: DataEncoding.MsgPack, mesg: patch("B", ["A"]) }),
    ),
  });
  commitAppend(stream, append, [{ seq: 2 }]);
  expect(appendHead(stream)).toBe("B");
});
