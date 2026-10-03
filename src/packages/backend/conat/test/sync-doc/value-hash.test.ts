/*
Every patch records the hash of the document value right after it, and every
client checks its own values against those hashes (patchflow's value hashes).
Here, on the real stack: the hashes reach other clients and snapshots, clients
that agree report nothing, and a snapshot that differs from its patch's value
is reported to whoever opens the document.
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

describe("value hashes", () => {
  const project_id = uuid();
  const docs: any[] = [];
  const reports: any[] = [];
  const track = (doc) => {
    docs.push(doc);
    doc.on("inconsistency", (e) => reports.push(e));
    return doc;
  };
  const openString = async (path: string) => {
    const doc = track(
      connect().sync.string({
        project_id,
        path,
        service: server.service,
        noAutosave: true,
        noBackendFsWatch: true,
        firstReadLockTimeout: 1,
      }),
    );
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

  it("clients agree, and hashes reach other clients and snapshots", async () => {
    const path = "hashes.txt";
    const s1 = await openString(path);
    const s2 = await openString(path);
    s1.from_str("one\ntwo\n");
    s1.commit();
    await s1.save();
    await waitUntilSynced([s1, s2]);
    s2.from_str("one\ntwo\nthree\n");
    s2.commit();
    s1.from_str("zero\none\ntwo\n");
    s1.commit();
    await s2.save();
    await s1.save();
    await waitUntilSynced([s1, s2]);
    s1.commit(); // merge
    await s1.save();
    await waitUntilSynced([s1, s2]);
    expect(s2.to_str()).toBe(s1.to_str());

    const session2 = (s2 as any).patchflowSession;
    const times = session2.versions();
    for (const time of times) {
      const patch = session2.getPatch(time);
      if (patch.file) continue; // the initial load from disk
      expect(patch.hash).toMatch(/^s1:/);
      expect(session2.verifyValue(time)).toBe("ok");
    }

    // A snapshot carries the hash of its patch; a client opening from it checks it.
    const t = times.at(-1);
    await (s1 as any).snapshot(t);
    s1.from_str(s1.to_str() + "after\n");
    s1.commit();
    await s1.save();
    await waitUntilSynced([s1, s2]);
    const s3 = await openString(path);
    expect(s3.to_str()).toBe(s1.to_str());
    const snap = (s3 as any).patchflowSession.getPatch(t);
    expect(snap.isSnapshot).toBe(true);
    expect(snap.hash).toBe(session2.getPatch(t).hash);
    expect(reports).toEqual([]);
  }, 60_000);

  it("reports a snapshot that differs from the value of its patch", async () => {
    const path = "bad-snapshot.txt";
    const s1 = await openString(path);
    s1.from_str("a\nb\n");
    s1.commit();
    await s1.save();
    s1.from_str("a\nb\nc\n");
    s1.commit();
    await s1.save();
    const t = s1.versions().at(-1);
    const hash = (s1 as any).patchflowSession.getPatch(t).hash;
    // A client with a wrong value writes a snapshot of it (as one did before
    // patchflow#10): the duplicated text, with the patch's hash.
    const table = (s1 as any).patches_table;
    const seq_info = (s1 as any).conatSnapshotSeqInfo(t);
    table.set({
      string_id: (s1 as any).string_id,
      time: t,
      wall: Date.now(),
      is_snapshot: true,
      snapshot: "a\nb\nc\na\nb\nc\n",
      user_id: 0,
      seq_info,
      hash,
      size: 12,
      __checkpoint: {
        name: "latest-snapshot",
        seq: seq_info.seq,
        data: { patchId: t },
      },
    });
    await table.save();
    s1.from_str("a\nb\nc\nd\n");
    s1.commit();
    await s1.save();
    const before = reports.length;
    const s2 = await openString(path);
    const found = reports.slice(before).filter((e) => e.path === path);
    // s2 started from the bad snapshot: it says so, and computes the value
    // from the snapshotted patch instead.
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]).toMatchObject({
      kind: "snapshot",
      time: t,
      expected: hash,
    });
    expect(s2.getInconsistencyCount()).toBe(found.length);
    expect(s2.to_str()).toBe("a\nb\nc\nd\n");
  }, 60_000);

  it("database documents: same hash whatever the key order", async () => {
    const path = "hashes.syncdb";
    const open = async () => {
      const doc = track(
        connect().sync.db({
          project_id,
          path,
          service: server.service,
          primary_keys: ["name"],
          firstReadLockTimeout: 1,
        }),
      );
      await once(doc, "ready");
      return doc;
    };
    const d1 = await open();
    const d2 = await open();
    d1.set({ name: "x", a: 1, b: 2 });
    d1.commit();
    await d1.save();
    await waitUntilSynced([d1, d2]);
    d2.set({ name: "y", b: 2, a: 1, when: new Date() });
    d2.commit();
    d1.set({ name: "x", c: 3 });
    d1.commit();
    await d2.save();
    await d1.save();
    await waitUntilSynced([d1, d2]);
    d2.commit();
    await d2.save();
    await waitUntilSynced([d1, d2]);
    const session1 = (d1 as any).patchflowSession;
    const hashed = session1
      .versions()
      .map((t) => session1.getPatch(t))
      .filter((p) => p.hash != null);
    expect(hashed.length).toBeGreaterThan(0);
    for (const p of hashed) {
      expect(p.hash).toMatch(/^d1:/);
      expect(session1.verifyValue(p.time)).toBe("ok");
    }
    expect(reports.filter((e) => e.path === path)).toEqual([]);
  }, 60_000);
});
