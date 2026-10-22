/*
A snapshot record is written about one interval after its patch, so in the
steady state each one lands just after the next snapshot's patch. The range a
client loads from the latest snapshot then holds the previous snapshot's
record without its patch, and stepping back one snapshot holds the next older
one, and so on: a prod agent chat replayed its whole history (43,623
versions) on every open. Opening must load from the latest snapshot only.
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

describe("opening a document whose snapshot records each follow the next snapshot's patch", () => {
  const project_id = uuid();
  const path = "snapshot-chain.txt";
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

  it("loads from the latest snapshot, not the whole history", async () => {
    const s1 = await open();
    const lines: string[] = [];
    const edit = async (line: string) => {
      lines.push(line);
      s1.from_str(lines.join("\n") + "\n");
      s1.commit();
      await s1.save();
    };
    const interval = 5;
    const snapshots = 8;
    for (let i = 0; i <= interval * (snapshots + 1); i++) {
      await edit(`line ${i}`);
      // the snapshot of the patch one interval back, recorded after this one
      if (i >= 2 * interval && i % interval === 0) {
        await (s1 as any).snapshot(s1.versions()[i - interval]);
      }
    }
    for (let i = 0; i < 3; i++) {
      await edit(`tail ${i}`);
    }
    const total = s1.versions().length;
    const s2 = await open();
    await waitUntilSynced([s1, s2]);
    const expected = s1.to_str();

    const s3 = await open();
    expect(s3.to_str()).toBe(expected);
    const session3 = (s3 as any).patchflowSession;
    expect(session3.needsMoreHistory()).toBe(false);
    // give a background load of more history the chance to run
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(s3.hasFullHistory()).toBe(false);
    // the latest snapshot's patch (one interval before the last snapshot
    // call) and the patches after it
    expect(s3.versions().length).toBeLessThanOrEqual(2 * interval + 3 + 1);
    expect(s3.versions().length).toBeLessThan(total);
    expect(s3.to_str()).toBe(expected);

    // Loading more history still steps back one snapshot at a time, and the
    // older snapshot records are used again once their patches load.
    expect(await s3.loadMoreHistory()).toBe(true);
    expect(s3.hasFullHistory()).toBe(false);
    expect(s3.to_str()).toBe(expected);
    await s3.loadMoreHistory({ all: true });
    expect(s3.hasFullHistory()).toBe(true);
    expect(s3.versions().length).toBe(total);
    expect(s3.to_str()).toBe(expected);
  });
});
