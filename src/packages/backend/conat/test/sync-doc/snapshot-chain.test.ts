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
    // The patch of the snapshot before the latest one, and its value.
    const previousSnapshotTime = s1.versions()[interval * snapshots - interval];
    const previousSnapshotValue = s1.version(previousSnapshotTime).to_str();
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

    // Loading more history still steps back one snapshot at a time, also
    // past a snapshot whose record was ignored until its patch loaded.
    const counts = [s3.versions().length];
    for (let step = 0; step < 3; step++) {
      expect(await s3.loadMoreHistory()).toBe(true);
      if (step == 0) {
        // the ignored snapshot record is used again once its patch loads
        expect(s3.version(previousSnapshotTime).to_str()).toBe(
          previousSnapshotValue,
        );
      }
      expect(s3.hasFullHistory()).toBe(false);
      expect(s3.to_str()).toBe(expected);
      counts.push(s3.versions().length);
    }
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i] - counts[i - 1]).toBeGreaterThan(0);
      expect(counts[i] - counts[i - 1]).toBeLessThanOrEqual(interval + 1);
    }
    await s3.loadMoreHistory({ all: true });
    expect(s3.hasFullHistory()).toBe(true);
    expect(s3.versions().length).toBe(total);
    expect(s3.to_str()).toBe(expected);
  });

  it("an existing chain without cut flags recovers after one new snapshot", async () => {
    const path2 = "snapshot-chain-legacy.txt";
    const open2 = async () => {
      const doc = connect().sync.string({
        project_id,
        path: path2,
        service: server.service,
        noAutosave: true,
        noBackendFsWatch: true,
        firstReadLockTimeout: 1,
      });
      docs.push(doc);
      await once(doc, "ready");
      return doc;
    };
    const s1 = await open2();
    // snapshots written before seq_info.cut existed
    const session1 = (s1 as any).patchflowSession;
    const isCut = session1.isCut;
    session1.isCut = () => false;
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
      if (i >= 2 * interval && i % interval === 0) {
        await (s1 as any).snapshot(s1.versions()[i - interval]);
      }
    }
    const total = s1.versions().length;
    const legacy = await open2();
    // the old behavior: everything
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(legacy.versions().length).toBe(total);
    expect(legacy.to_str()).toBe(s1.to_str());

    // a client with seq_info.cut writes the next snapshot
    session1.isCut = isCut;
    for (let i = 0; i < interval; i++) {
      await edit(`more ${i}`);
    }
    await (s1 as any).snapshot(s1.versions()[s1.versions().length - 2]);
    await edit("last");
    const expected = s1.to_str();
    const fresh = await open2();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(fresh.to_str()).toBe(expected);
    expect(fresh.hasFullHistory()).toBe(false);
    expect(fresh.versions().length).toBeLessThan(10);
  }, 60_000);
});
