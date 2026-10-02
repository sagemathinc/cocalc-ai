/*
A client that opens a document loads its latest snapshot and the patches
appended to the stream after the snapshotted patch. Patches made concurrently
with the snapshotted patch but appended before it are in neither, and later
patches build on them. The client must still show what everyone else sees.
*/

import {
  before,
  after,
  uuid,
  connect,
  server,
  once,
  delay,
  waitUntilSynced,
} from "./setup";

beforeAll(before);
// eslint-disable-next-line no-console
const log = (...args: any[]) =>
  process.env.SNAP_TEST_DEBUG && console.log(...args);
afterAll(after);

describe("opening a document after a snapshot at a concurrent patch", () => {
  const project_id = uuid();
  const path = "snapshot-concurrent.txt";
  const docs: any[] = [];
  const open = async () => {
    const doc = connect().sync.string({
      project_id,
      path,
      service: server.service,
      noAutosave: true,
      noBackendFsWatch: true,
      firstReadLockTimeout: 1,
    });
    docs.push(doc);
    await once(doc, "ready");
    return doc;
  };
  afterAll(async () => {
    for (const doc of docs) {
      try {
        await doc.close();
      } catch {}
    }
  });

  it("shows the same text as the clients that were there", async () => {
    const s1 = await open();
    const s2 = await open();
    log("opened");
    s1.from_str("a\nb\nc\n");
    s1.commit();
    await s1.save();
    await waitUntilSynced([s1, s2]);
    log("base synced");

    // s1 and s2 edit concurrently; s2 also builds on its own edit, and both of
    // s2's patches are appended to the stream before s1's.
    s1.from_str("a\nb\nc\nfrom s1\n");
    s1.commit();
    const t = s1.versions().at(-1);
    await delay(20);
    s2.from_str("from s2\na\nb\nc\n");
    s2.commit();
    await delay(20);
    s2.from_str("from s2\na\nb\nc\nmore from s2\n");
    s2.commit();
    await s2.save();
    await delay(200);
    await s1.save();
    await waitUntilSynced([s1, s2]);

    log("concurrent synced", s1.getHeads().length);
    // A merge of everything, then a snapshot at s1's concurrent patch.
    s1.commit();
    await s1.save();
    await waitUntilSynced([s1, s2]);
    log("merged");
    await (s1 as any).snapshot(t);
    log("snapshot");
    s1.from_str(s1.to_str() + "after\n");
    s1.commit();
    await s1.save();
    await waitUntilSynced([s1, s2]);
    const expected = s1.to_str();
    expect(expected).toContain("from s2");
    expect(expected).toContain("more from s2");
    expect(s2.to_str()).toBe(expected);

    const s3 = await open();
    log("s3", JSON.stringify(s3.to_str()), JSON.stringify(expected));
    // Right away: the document loads the history it needs before it is ready.
    expect(s3.to_str()).toBe(expected);
    // With exact values, not an approximation: its own patches have hashes.
    // (This is the document's first snapshot, which has no prev_seq; that
    // does not mean that the history before it is loaded.)
    const session3 = (s3 as any).patchflowSession;
    expect(session3.needsMoreHistory()).toBe(false);
    s3.from_str(s3.to_str() + "from s3\n");
    s3.commit();
    const mine = session3.getPatch(session3.versions().at(-1));
    expect(mine.hash).toMatch(/^s1:/);
    expect(mine.inexact).toBeUndefined();
  }, 60_000);
});
