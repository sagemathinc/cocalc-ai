/*
Two concurrent patches, both snapshotted, with both snapshot records appended
after the later patch, and no patch merging them. A client opening from the
latest snapshot's patch must not ignore the other head's snapshot record (see
isSnapshotRecordBeforeLoadedRange): its patch is not an ancestor of the
loaded snapshot's patch, and nothing else brings its edits in.
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
afterAll(after);

describe("opening a document whose latest snapshot is at one of two concurrent heads", () => {
  const project_id = uuid();
  const path = "snapshot-concurrent-heads.txt";
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

  it("shows the other head's edits too", async () => {
    const s1 = await open();
    const s2 = await open();
    s1.from_str("a\nb\nc\n");
    s1.commit();
    await s1.save();
    await waitUntilSynced([s1, s2]);

    // concurrent: s2's patch is appended before s1's
    s2.from_str("from s2\na\nb\nc\n");
    s2.commit();
    const b = s2.versions().at(-1);
    s1.from_str("a\nb\nc\nfrom s1\n");
    s1.commit();
    const a = s1.versions().at(-1);
    await s2.save();
    await delay(200);
    await s1.save();
    await waitUntilSynced([s1, s2]);
    expect(s1.getHeads().length).toBe(2);

    // both snapshot records after both patches, the latest at s1's head
    await (s1 as any).snapshot(b);
    await (s1 as any).snapshot(a);
    const expected = s1.to_str();
    expect(expected).toContain("from s1");
    expect(expected).toContain("from s2");

    const s3 = await open();
    await delay(500);
    expect(s3.to_str()).toBe(expected);
  }, 60_000);
});
