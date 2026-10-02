/*
A patch that merges concurrent patches (a merge commit) records the merged
value of its parents (patchflow's Patch.mergeParent and Patch.mergePatch), so
its value never depends on how a later version merges. Here, on the real
stack: the merged value is stored, reaches other clients and clients that
open the document later, and gives the value its author computed.
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

describe("merge commits", () => {
  const project_id = uuid();
  const docs: any[] = [];
  const reports: any[] = [];
  const track = (doc) => {
    docs.push(doc);
    doc.on("inconsistency", (e) => reports.push(e));
    return doc;
  };
  afterAll(async () => {
    for (const doc of docs) {
      try {
        await doc.close();
      } catch {}
    }
  });

  const merges = (doc) => {
    const session = (doc as any).patchflowSession;
    return session
      .versions()
      .map((t) => session.getPatch(t))
      .filter((p) => (p.parents?.length ?? 0) > 1);
  };

  const expectRecorded = (doc) => {
    const found = merges(doc);
    expect(found.length).toBeGreaterThan(0);
    const session = (doc as any).patchflowSession;
    for (const p of found) {
      expect(p.parents).toContain(p.mergeParent);
      expect(p.mergePatch).toBeDefined();
      expect(session.verifyValue(p.time)).toBe("ok");
    }
    return found;
  };

  it("text: the merged value reaches other clients and later ones", async () => {
    const path = "merge.txt";
    const open = async () => {
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
    const s1 = await open();
    const s2 = await open();
    s1.from_str("one two three\n");
    s1.commit();
    await s1.save();
    await waitUntilSynced([s1, s2]);
    s1.from_str("one TWO three\n");
    s1.commit();
    s2.from_str("one two three four\n");
    s2.commit();
    await s1.save();
    await s2.save();
    await waitUntilSynced([s1, s2]);
    s1.from_str(s1.to_str() + "five\n");
    s1.commit();
    await s1.save();
    await waitUntilSynced([s1, s2]);
    expect(s1.to_str()).toBe("one TWO three four\nfive\n");
    expect(s2.to_str()).toBe(s1.to_str());
    const sent = expectRecorded(s1);
    const received = expectRecorded(s2);
    expect(received.map((p) => [p.time, p.mergeParent, p.mergePatch])).toEqual(
      sent.map((p) => [p.time, p.mergeParent, p.mergePatch]),
    );
    // A client that opens the document now loads them from the store.
    const s3 = await open();
    expect(s3.to_str()).toBe(s1.to_str());
    expect(
      expectRecorded(s3).map((p) => [p.time, p.mergeParent, p.mergePatch]),
    ).toEqual(sent.map((p) => [p.time, p.mergeParent, p.mergePatch]));
    expect(reports.filter((e) => e.path === path)).toEqual([]);
  }, 60_000);

  it("database documents", async () => {
    const path = "merge.syncdb";
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
    d1.set({ name: "x", a: 1 });
    d1.commit();
    await d1.save();
    await waitUntilSynced([d1, d2]);
    d1.set({ name: "x", b: 2 });
    d1.commit();
    d2.set({ name: "y", c: 3 });
    d2.commit();
    await d1.save();
    await d2.save();
    await waitUntilSynced([d1, d2]);
    d2.set({ name: "z", d: 4 });
    d2.commit();
    await d2.save();
    await waitUntilSynced([d1, d2]);
    expect(d1.get().toJS()).toEqual(d2.get().toJS());
    expect(d1.get().size).toBe(3);
    expectRecorded(d1);
    expectRecorded(d2);
    const d3 = await open();
    expect(d3.get().toJS()).toEqual(d1.get().toJS());
    expectRecorded(d3);
    expect(reports.filter((e) => e.path === path)).toEqual([]);
  }, 60_000);
});
