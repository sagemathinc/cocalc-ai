/*
(@review, #1278) A client that opened from a snapshot without seeing an older
concurrent head B writes a snapshot of its next patch C. C's
snapshot_ancestors must not list B: it has no path to it. So when B's
snapshot record is appended later (with the checkpoint still at C), B is
accepted live and on a later open, not ignored as an ancestor of C.
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

describe("snapshot ancestor provenance", () => {
  const project_id = uuid();
  const path = "snapshot-ancestor-provenance.txt";
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

  it("does not hide a concurrent head missing from the snapshot writer", async () => {
    const s1 = await open();
    const s2 = await open();
    s1.from_str("a\nb\nc\n");
    s1.commit();
    await s1.save();
    await waitUntilSynced([s1, s2]);

    // Concurrent heads, with s2's patch before s1's in the stream.
    s2.from_str("from s2\na\nb\nc\n");
    s2.commit();
    const olderConcurrent = s2.versions().at(-1);
    s1.from_str("a\nb\nc\nfrom s1\n");
    s1.commit();
    const snapshotA = s1.versions().at(-1);
    await s2.save();
    await delay(100);
    await s1.save();
    await waitUntilSynced([s1, s2]);
    expect(s1.getHeads()).toHaveLength(2);

    await (s1 as any).snapshot(snapshotA);

    // Starting at A omits the older concurrent head B. This client can prove
    // that A is an ancestor of its next patch C, but it has no path to B.
    const partial = await open();
    expect(partial.to_str()).not.toContain("from s2");
    expect(partial.hasFullHistory()).toBe(false);
    expect((partial as any).patchflowSession.needsMoreHistory()).toBe(false);

    partial.from_str(partial.to_str() + "from partial\n");
    partial.commit();
    const snapshotC = partial.versions().at(-1);
    await partial.save();
    await (partial as any).snapshot(snapshotC);
    const cRecord = (partial as any)
      .dstream()
      .getAll()
      .find((x: any) => x.is_snapshot === true && x.time === snapshotC);
    expect(cRecord.seq_info.snapshot_ancestors).toContain(snapshotA);
    expect(cRecord.seq_info.snapshot_ancestors).not.toContain(olderConcurrent);

    // Open at C before B's snapshot record exists. Keep this checkpoint at C;
    // calling snapshot(B) here would move it backward and miss the case.
    const live = await open();
    expect(live.to_str()).not.toContain("from s2");

    // Append B's snapshot record without changing the latest checkpoint.
    const session1 = (s1 as any).patchflowSession;
    const p = session1.getPatch(olderConcurrent);
    const snapshot = s1.version(olderConcurrent).to_str();
    const seq_info = (s1 as any).conatSnapshotSeqInfo(olderConcurrent);
    (s1 as any).patches_table.set({
      size: snapshot.length,
      string_id: (s1 as any).string_id,
      time: olderConcurrent,
      wall: p.wall,
      is_snapshot: true,
      snapshot,
      user_id: p.userId ?? 0,
      seq_info,
      ...(p.hash != null ? { hash: p.hash } : {}),
    });
    await (s1 as any).patches_table.save();
    await delay(500);

    // C did not list B, so B is accepted both live and on a later open.
    expect(live.to_str()).toContain("from s2");
    const fresh = await open();
    expect(fresh.to_str()).toContain("from s2");
    expect(fresh.to_str()).toBe(s1.to_str());
  }, 60_000);

  it("does not treat a legacy prev_seq as proof of ancestry", async () => {
    const legacyPath = "snapshot-ancestor-legacy-concurrent.txt";
    const openLegacy = async () => {
      const doc = connect().sync.string({
        project_id,
        path: legacyPath,
        service: server.service,
        noAutosave: true,
        noBackendFsWatch: true,
        firstReadLockTimeout: 1,
      });
      docs.push(doc);
      await once(doc, "ready");
      return doc;
    };
    const s1 = await openLegacy();
    const s2 = await openLegacy();
    s1.from_str("a\nb\nc\n");
    s1.commit();
    await s1.save();
    await waitUntilSynced([s1, s2]);

    s2.from_str("from s2\na\nb\nc\n");
    s2.commit();
    const b = s2.versions().at(-1);
    await delay(20);
    s1.from_str("a\nb\nc\nfrom s1\n");
    s1.commit();
    const a = s1.versions().at(-1);
    await s2.save();
    await delay(100);
    await s1.save();
    await waitUntilSynced([s1, s2]);
    expect(s1.getHeads()).toHaveLength(2);

    // Model records written before snapshot_ancestors existed. Both records
    // land after both patches, with A last so the checkpoint stays at A.
    (s1 as any).snapshotAncestors = () => undefined;
    await (s1 as any).snapshot(b);
    await (s1 as any).snapshot(a);
    const expected = s1.to_str();
    expect(expected).toContain("from s1");
    expect(expected).toContain("from s2");

    const fresh = await openLegacy();
    await delay(500);
    expect(fresh.to_str()).toBe(expected);
  }, 60_000);
});
