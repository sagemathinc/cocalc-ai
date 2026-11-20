/*
A snapshot made without the patches that wait on a parent that is not in the
stream (sync-doc.ts snapshotDespiteMissingHistory) must be of a patch that has
every head as an ancestor. Clients that hold a waiting patch keep it as a head
and build their next patches on it; a snapshot of any other patch leaves such
a patch (or one concurrent with the snapshot's) outside what it covers, and a
client that opens the document from it loads older history for it, reaches
the missing parent, and so loads the whole history on every open.

Here the missing parent's author has no older patch in the stream, so a
client can't tell that loading older history won't supply it.
*/

import {
  before,
  after,
  uuid,
  connect,
  server,
  once,
  wait,
  waitUntilSynced,
} from "./setup";
import { decodePatchId, encodePatchId } from "patchflow";
import { setSnapshotsBlockedLimits } from "@cocalc/sync/editor/generic/sync-doc";

beforeAll(before);
afterAll(after);

describe("a snapshot without the patches that wait on a missing parent", () => {
  const docs: any[] = [];
  afterEach(() => setSnapshotsBlockedLimits({ boundMs: 10 * 60_000 }));
  afterAll(async () => {
    for (const doc of docs) {
      try {
        await doc.close();
      } catch {}
    }
  });

  const open = async (project_id: string, path: string) => {
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

  const writeRecord = async (doc, obj) => {
    const table = (doc as any).patches_table;
    table.set({ string_id: doc.get_string_id(), is_snapshot: false, ...obj });
    await table.save();
  };

  const edit = async (doc, text: string) => {
    doc.from_str(`${doc.to_str()}${text}\n`);
    doc.commit();
    await doc.save();
  };

  const snapshotTimes = (doc): string[] =>
    ((doc as any).dstream().getAll() ?? [])
      .filter((m) => m?.is_snapshot)
      .map((m) => `${m.time}`);

  // runs the throttled snapshot check now, past the bound
  const runSnapshots = async (doc) => {
    setSnapshotsBlockedLimits({ boundMs: 0 });
    await doc.set_snapshot_interval(1);
    doc.snapshotIfNecessary();
    await doc.snapshotIfNecessary.flush();
  };

  const coldOpen = async (project_id: string, path: string) => {
    setSnapshotsBlockedLimits({ boundMs: 10 * 60_000 });
    const doc = await open(project_id, path);
    return {
      doc,
      full: doc.hasFullHistory(),
      needs: (doc as any).patchflowSession.needsMoreHistory(),
      loaded: (doc as any).get_patches().length,
    };
  };

  // Older history with a snapshot, then a chain of 3 patches built on a
  // parent that is not in the stream; s1 and s2 are live and hold the chain.
  const setup = async () => {
    const project_id = uuid();
    const path = `repair-heads-${uuid()}.txt`;
    const s1 = await open(project_id, path);
    const s2 = await open(project_id, path);
    for (let i = 0; i < 20; i++) await edit(s1, `old ${i}`);
    await (s1 as any).snapshot(s1.versions().at(-1));
    for (let i = 0; i < 5; i++) await edit(s1, `line ${i}`);
    await waitUntilSynced([s1, s2]);
    const last = s1.versions().at(-1);
    const missing = encodePatchId(decodePatchId(last).timeMs + 1, "nobody");
    const author = decodePatchId(s2.versions().at(-1) ?? last).clientId + "x";
    let parent = missing;
    for (let k = 0; k < 3; k++) {
      const time = encodePatchId(decodePatchId(last).timeMs + 2 + k, author);
      await writeRecord(s2, {
        time,
        wall: decodePatchId(time).timeMs,
        user_id: 1,
        parents: [parent],
        version: s1.versions().length + 2 + k,
        patch: "[]",
      });
      parent = time;
    }
    await waitUntilSynced([s1, s2]);
    // a client that waited past the bound: it has the whole history
    setSnapshotsBlockedLimits({ boundMs: 0 });
    const s3 = await open(project_id, path);
    expect(await (s3 as any).snapshotDespiteMissingHistory()).toBe(true);
    return { project_id, path, s1, s2, s3, missing };
  };

  const valueHeads = (doc): string[] =>
    (doc as any).patchflowSession.graph.getValueHeads();

  // s1 and s2 edit at the same time: two value heads at s3
  const concurrentEdits = async ({ s1, s2, s3 }, label: string) => {
    await waitUntilSynced([s1, s2, s3]);
    s1.from_str(`${s1.to_str()}s1 ${label}\n`);
    s1.commit();
    s2.from_str(`${s2.to_str()}s2 ${label}\n`);
    s2.commit();
    await Promise.all([s1.save(), s2.save()]);
    await waitUntilSynced([s1, s2, s3]);
    expect(valueHeads(s3)).toHaveLength(2);
  };

  it("A: with two concurrent heads it holds back; once a live edit merges them, it snapshots that merge, and a cold open loads only from it", async () => {
    const ctx = await setup();
    const { project_id, path, s1, s2, s3 } = ctx;
    const held: any[] = [];
    s3.on("snapshot-held-back", (info) => held.push(info));
    await concurrentEdits(ctx, "concurrent");
    const before = snapshotTimes(s3);
    await runSnapshots(s3);
    expect(snapshotTimes(s3)).toEqual(before);
    expect(held.at(-1)).toMatchObject({
      reason: "no dominating head",
      heads: 2,
    });
    // the next edit merges both heads
    await edit(s1, "merge");
    await waitUntilSynced([s1, s2, s3]);
    const merge = s1.versions().at(-1);
    expect(valueHeads(s3)).toEqual([merge]);
    await runSnapshots(s3);
    expect(snapshotTimes(s3).at(-1)).toBe(merge);
    await waitUntilSynced([s1, s2, s3]);
    const a = await coldOpen(project_id, path);
    expect(a.full).toBe(false);
    expect(a.needs).toBe(false);
    expect(a.loaded).toBeLessThan(5);
    expect(a.doc.to_str()).toBe(s3.to_str());
  }, 60_000);

  const snapshotAtMerge = async (ctx) => {
    const { s1, s2, s3 } = ctx;
    await concurrentEdits(ctx, "concurrent");
    await edit(s1, "merge");
    await waitUntilSynced([s1, s2, s3]);
    await runSnapshots(s3);
    expect(snapshotTimes(s3).at(-1)).toBe(s1.versions().at(-1));
    await waitUntilSynced([s1, s2, s3]);
  };

  it("B: later edits by two live clients still load only from the snapshot", async () => {
    const ctx = await setup();
    const { project_id, path, s1, s2, s3 } = ctx;
    await snapshotAtMerge(ctx);
    await edit(s1, "s1 after");
    await waitUntilSynced([s1, s2, s3]);
    await edit(s2, "s2 after");
    await waitUntilSynced([s1, s2, s3]);
    await edit(s3, "s3 after");
    await waitUntilSynced([s1, s2, s3]);
    const b = await coldOpen(project_id, path);
    expect(b.full).toBe(false);
    expect(b.needs).toBe(false);
    expect(b.doc.to_str()).toBe(s3.to_str());
  }, 60_000);

  it("C: the next concurrent round holds the next snapshot back until it is merged", async () => {
    const ctx = await setup();
    const { project_id, path, s1, s2, s3 } = ctx;
    await snapshotAtMerge(ctx);
    await concurrentEdits(ctx, "round 2");
    const before = snapshotTimes(s3);
    await runSnapshots(s3);
    expect(snapshotTimes(s3)).toEqual(before);
    await edit(s2, "merge round 2");
    await waitUntilSynced([s1, s2, s3]);
    await runSnapshots(s3);
    expect(snapshotTimes(s3).at(-1)).toBe(s2.versions().at(-1));
    await waitUntilSynced([s1, s2, s3]);
    const c = await coldOpen(project_id, path);
    expect(c.full).toBe(false);
    expect(c.needs).toBe(false);
    expect(c.doc.to_str()).toBe(s3.to_str());
  }, 60_000);

  it("heads that never converge: no snapshot at a patch that doesn't cover them, and the hold-back is reported", async () => {
    const ctx = await setup();
    const { s1, s2, s3 } = ctx;
    await concurrentEdits(ctx, "then gone");
    // both live clients go away; the repair client never edits
    await s1.close();
    await s2.close();
    const held: any[] = [];
    s3.on("snapshot-held-back", (info) => held.push(info));
    const before = snapshotTimes(s3);
    for (let i = 0; i < 3; i++) await runSnapshots(s3);
    expect(snapshotTimes(s3)).toEqual(before);
    expect(held.length).toBeGreaterThanOrEqual(3);
    expect(held.at(-1)).toMatchObject({
      reason: "no dominating head",
      heads: 2,
      patchesSinceSnapshot: expect.any(Number),
    });
  }, 60_000);

  // The repair snapshot as it was made before (at one of two concurrent
  // heads, the one appended last): every cold open loads the whole history.
  const badRepairSnapshot = async (ctx) => {
    const { project_id, path, s1, s2, s3 } = ctx;
    // The live clients are browsers on an older release (as on the prod
    // stream): they hold snapshots back but never make one without the
    // waiting patches, so only the repair client (or its successor) can heal.
    for (const doc of [s1, s2]) {
      (doc as any).snapshotDespiteMissingHistory = async () => false;
    }
    await concurrentEdits(ctx, "concurrent");
    const order = ((s3 as any).dstream().getAll() ?? []).map(
      (m) => `${m?.time}`,
    );
    const last = [...valueHeads(s3)].sort(
      (x, y) => order.indexOf(y) - order.indexOf(x),
    )[0];
    await (s3 as any).snapshot(last);
    await waitUntilSynced([s1, s2, s3]);
    expect(snapshotTimes(s3).at(-1)).toBe(last);
    return { project_id, path, s1, s2, s3 };
  };

  // the default interval (300 patches), and no explicit checks: the healing
  // must come from the ordinary triggers
  it("E (default interval): another client's merge heals a bad repair snapshot without any edit by the repair client", async () => {
    const ctx = await setup();
    const { project_id, path, s1, s2, s3 } = await badRepairSnapshot(ctx);
    expect((s3 as any).snapshot_interval).toBeGreaterThan(100);
    // (the check is throttled to once a minute: start a fresh window, so the
    // remote patch's check runs at once instead of a minute later)
    s3.snapshotIfNecessary.cancel();
    // (another live client merges; s3 only receives it)
    await edit(s1, "merge");
    const merge = s1.versions().at(-1);
    await wait({ until: () => valueHeads(s3).join() === merge });
    // The remote patch's check is queued (at once, or at the end of the
    // throttle's one-minute window if another change took its start): run
    // what is queued now. Without the check on remote patches nothing is
    // queued and no snapshot is made.
    await s3.snapshotIfNecessary.flush();
    await wait({
      until: () => snapshotTimes(s3).at(-1) === merge,
      timeout: 15_000,
    });
    await waitUntilSynced([s1, s2, s3]);
    const healed = await coldOpen(project_id, path);
    expect(healed.full).toBe(false);
    expect(healed.needs).toBe(false);
    expect(healed.doc.to_str()).toBe(s3.to_str());
    // and nothing more: the next edit makes no further snapshot
    const count = snapshotTimes(s3).length;
    await edit(s2, "after healing");
    await waitUntilSynced([s1, s2, s3]);
    await new Promise((r) => setTimeout(r, 2_000));
    expect(snapshotTimes(s3)).toHaveLength(count);
  }, 60_000);

  it("F (default interval): the repair client's own merge, not stored when first checked, heals by the re-check", async () => {
    const ctx = await setup();
    const { project_id, path, s1, s2, s3 } = await badRepairSnapshot(ctx);
    const held: any[] = [];
    s3.on("snapshot-held-back", (info) => held.push(info));
    s3.snapshotIfNecessary.cancel();
    await edit(s3, "repair client merge");
    const merge = s3.versions().at(-1);
    // the commit's own check found the head not stored yet...
    expect(held.map((h) => h.reason)).toContain("head not stored yet");
    expect(snapshotTimes(s3)).not.toContain(merge);
    // ...and the re-check a moment later makes the snapshot
    await wait({
      until: () => snapshotTimes(s3).at(-1) === merge,
      timeout: 15_000,
    });
    await waitUntilSynced([s1, s2, s3]);
    const healed = await coldOpen(project_id, path);
    expect(healed.full).toBe(false);
    expect(healed.needs).toBe(false);
    expect(healed.doc.to_str()).toBe(s3.to_str());
  }, 60_000);

  it("a snapshot of the concurrent head appended first: the other head is after its patch, so a cold open loads it, and nothing is repaired", async () => {
    // (a cold open starts at the snapshotted patch's position, the
    // latest_snapshot checkpoint, not at the snapshot record's)
    const ctx = await setup();
    const { project_id, path, s1, s2, s3 } = ctx;
    await concurrentEdits(ctx, "concurrent");
    const order = ((s3 as any).dstream().getAll() ?? []).map(
      (m) => `${m?.time}`,
    );
    const first = [...valueHeads(s3)].sort(
      (x, y) => order.indexOf(x) - order.indexOf(y),
    )[0];
    await (s3 as any).snapshot(first);
    await waitUntilSynced([s1, s2, s3]);
    expect((s3 as any).newestSnapshotUncovered()).toBe(false);
    await edit(s1, "merge");
    await waitUntilSynced([s1, s2, s3]);
    expect((s3 as any).newestSnapshotUncovered()).toBe(false);
    const x = await coldOpen(project_id, path);
    expect(x.full).toBe(false);
    expect(x.needs).toBe(false);
    expect(x.doc.to_str()).toBe(s3.to_str());
  }, 60_000);

  it("R (default interval, after a restart): a fresh instance that loaded the whole history while opening heals at a remote merge, with no explicit check", async () => {
    const ctx = await setup();
    const { project_id, path, s1, s2, s3 } = await badRepairSnapshot(ctx);
    // as on the prod stream: a later patch already merges the uncovered head
    await edit(s1, "first merge");
    await waitUntilSynced([s1, s2, s3]);
    // the repair process restarts: a new instance opens the document normally
    await s3.close();
    setSnapshotsBlockedLimits({ boundMs: 0 });
    const s4 = await open(project_id, path);
    // opening from the bad snapshot loaded everything (the missing parent's
    // author has no older patch), not through the held-back-snapshot path
    expect(s4.hasFullHistory()).toBe(true);
    expect((s4 as any).wholeHistoryLoadedWithinLimits).toBe(false);
    expect((s4 as any).patchflowSession.needsMoreHistory()).toBe(true);
    // the next edit reaches s4 only as a remote patch
    await edit(s1, "merge");
    const merge = s1.versions().at(-1);
    await waitUntilSynced([s1, s2, s4]);
    // the throttled check runs at once or at the end of its one-minute window
    await wait({
      until: () => snapshotTimes(s4).at(-1) === merge,
      timeout: 75_000,
    });
    await waitUntilSynced([s1, s2, s4]);
    const healed = await coldOpen(project_id, path);
    expect(healed.full).toBe(false);
    expect(healed.needs).toBe(false);
    expect(healed.doc.to_str()).toBe(s4.to_str());
  }, 120_000);

  it("S (default interval): after healing, two live clients keep editing for 10 rounds (concurrent edits and merges): no further snapshots, and cold opens stay healthy", async () => {
    const ctx = await setup();
    const { project_id, path, s1, s2, s3 } = await badRepairSnapshot(ctx);
    s3.snapshotIfNecessary.cancel();
    await edit(s1, "merge");
    const merge = s1.versions().at(-1);
    await wait({ until: () => valueHeads(s3).join() === merge });
    await s3.snapshotIfNecessary.flush();
    await wait({
      until: () => snapshotTimes(s3).at(-1) === merge,
      timeout: 15_000,
    });
    const healedCount = snapshotTimes(s3).length;
    for (let round = 0; round < 10; round++) {
      // two concurrent edits, then a merge by one of them
      await concurrentEdits(ctx, `round ${round}`);
      await edit(round % 2 ? s1 : s2, `merge ${round}`);
      await waitUntilSynced([s1, s2, s3]);
      // whatever is queued runs now (at most one check a minute otherwise)
      await s3.snapshotIfNecessary.flush();
    }
    // nothing that comes after the healing snapshot needs a new one (the
    // ordinary interval is 300 patches)
    expect(snapshotTimes(s3)).toHaveLength(healedCount);
    const later = await coldOpen(project_id, path);
    expect(later.full).toBe(false);
    expect(later.needs).toBe(false);
    expect(later.doc.to_str()).toBe(s3.to_str());
  }, 120_000);

  it("G: a single value head whose value differs from its hash is not snapshotted, and that is reported", async () => {
    const ctx = await setup();
    const { s1, s2, s3 } = ctx;
    await concurrentEdits(ctx, "concurrent");
    await edit(s1, "merge");
    await waitUntilSynced([s1, s2, s3]);
    const merge = s1.versions().at(-1);
    expect(valueHeads(s3)).toEqual([merge]);
    // its value at s3 differs from the hash its author recorded (as
    // patchflow's own check would report for a corrupt or diverged patch)
    const session = (s3 as any).patchflowSession;
    const verifyValue = session.verifyValue.bind(session);
    session.verifyValue = (time) =>
      time === merge ? "mismatch" : verifyValue(time);
    const held: any[] = [];
    s3.on("snapshot-held-back", (info) => held.push(info));
    const before = snapshotTimes(s3);
    await runSnapshots(s3);
    expect(snapshotTimes(s3)).toEqual(before);
    expect(held.at(-1)).toMatchObject({
      reason: "head value differs from its hash",
    });
  }, 60_000);

  it("D2: an ordinary document with two concurrent heads still snapshots at the interval candidate", async () => {
    const project_id = uuid();
    const path = `repair-heads-plain2-${uuid()}.txt`;
    const s1 = await open(project_id, path);
    const s2 = await open(project_id, path);
    for (let i = 0; i < 4; i++) await edit(s1, `plain ${i}`);
    await waitUntilSynced([s1, s2]);
    s1.from_str(`${s1.to_str()}s1 concurrent\n`);
    s1.commit();
    s2.from_str(`${s2.to_str()}s2 concurrent\n`);
    s2.commit();
    await Promise.all([s1.save(), s2.save()]);
    await waitUntilSynced([s1, s2]);
    expect(valueHeads(s1)).toHaveLength(2);
    expect((s1 as any).patchflowSession.needsMoreHistory()).toBe(false);
    const before = snapshotTimes(s1).length;
    await s1.set_snapshot_interval(1);
    s1.snapshotIfNecessary();
    await s1.snapshotIfNecessary.flush();
    expect(snapshotTimes(s1).length).toBeGreaterThan(before);
  }, 60_000);

  it("D: an ordinary snapshot (nothing waits) is unchanged", async () => {
    const project_id = uuid();
    const path = `repair-heads-plain-${uuid()}.txt`;
    const s1 = await open(project_id, path);
    for (let i = 0; i < 6; i++) await edit(s1, `plain ${i}`);
    expect((s1 as any).patchflowSession.needsMoreHistory()).toBe(false);
    await s1.set_snapshot_interval(2);
    s1.snapshotIfNecessary();
    await s1.snapshotIfNecessary.flush();
    expect(snapshotTimes(s1).length).toBeGreaterThan(0);
    const d = await coldOpen(project_id, path);
    expect(d.needs).toBe(false);
    expect(d.doc.to_str()).toBe(s1.to_str());
  }, 60_000);

  it("control: a snapshot of one of two concurrent heads (what the interval candidate did) makes a cold open load the whole history", async () => {
    const ctx = await setup();
    const { project_id, path, s1, s2, s3 } = ctx;
    await concurrentEdits(ctx, "concurrent");
    // the head appended last, so the other one is in the stream before the
    // snapshot's patch and outside what it covers (as on the prod stream)
    const order = ((s3 as any).dstream().getAll() ?? []).map(
      (m) => `${m?.time}`,
    );
    const notCovering = [...valueHeads(s3)].sort(
      (x, y) => order.indexOf(y) - order.indexOf(x),
    )[0];
    await (s3 as any).snapshot(notCovering);
    await edit(s1, "merge");
    await waitUntilSynced([s1, s2, s3]);
    const x = await coldOpen(project_id, path);
    expect(x.full).toBe(true);
    expect(x.needs).toBe(true);
  }, 60_000);
});
