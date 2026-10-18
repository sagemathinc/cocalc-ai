/*
A snapshot is written about one interval after the patch it covers, so the
range a client loads from the latest snapshot onward also contains the
previous snapshot's record, without that snapshot's patch or its children.
That record used to look like a second head without an exact merged value, so
every open loaded more history: back to the previous snapshot's own start,
which after a long gap between snapshots is everything (a prod agent chat
loaded 29,496 versions instead of 557).
*/

import {
  before,
  after,
  uuid,
  connect,
  server,
  once,
  waitUntilSynced,
} from "./setup";

beforeAll(before);
afterAll(after);

describe("opening a document whose previous snapshot's record follows the latest snapshot", () => {
  const project_id = uuid();
  const path = "orphan-snapshot-record.txt";
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

  it("loads from the latest snapshot and nothing older", async () => {
    const s1 = await open();
    const lines: string[] = [];
    const edit = async (line: string) => {
      lines.push(line);
      s1.from_str(lines.join("\n") + "\n");
      s1.commit();
      await s1.save();
    };
    for (let i = 0; i < 10; i++) {
      await edit(`line ${i}`);
    }
    const versions = s1.versions();
    const older = versions[2];
    const newer = versions[9];
    // A catch-up snapshot of an older patch first (its record is appended
    // now, after the newer patch), then the latest snapshot at the newer
    // patch: loading from the latest snapshot's seq includes the older
    // snapshot's record.
    await (s1 as any).snapshot(older);
    await (s1 as any).snapshot(newer);
    await edit("after");
    const s2 = await open();
    await waitUntilSynced([s1, s2]);
    const expected = s1.to_str();

    const s3 = await open();
    expect(s3.to_str()).toBe(expected);
    const session3 = (s3 as any).patchflowSession;
    expect(session3.needsMoreHistory()).toBe(false);
    // Only the latest snapshot and what follows it: no older history.
    expect(s3.hasFullHistory()).toBe(false);
    const history = session3.history({ includeSnapshots: true });
    expect(history.filter((p) => p.isSnapshot).map((p) => p.time)).toEqual([
      newer,
    ]);
    expect(history.length).toBe(2);
  }, 60_000);
});
