/*
A patch can build on a patch that is not in the stream: e.g., the parent
reached its child's author live but was never persisted (lost when the persist
server restarted). Older history cannot supply it, so a client that opens the
document must not load the whole history looking for it (minutes for a
long-lived document, on every cold open). If the stream holds an older patch
of the missing parent's author, the parent would be after it, in the loaded
history, because a client appends its own patches in order.

Appending an empty patch with the missing id, on the patches it can only have
been made on, makes every client's value exact again.
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

describe("a patch whose parent is not in the stream", () => {
  const docs: any[] = [];
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

  // Write a raw patch record to the stream, as SyncDoc's patch store does.
  const writeRecord = async (doc, obj) => {
    const table = (doc as any).patches_table;
    table.set({ string_id: doc.get_string_id(), is_snapshot: false, ...obj });
    await table.save();
  };

  // A document opened from a snapshot, with history before it, then patches
  // by s1 after the snapshot, and a patch by s2 whose parent is missing.
  const setup = async (missingClient: (s1, s2) => string) => {
    const project_id = uuid();
    const path = `missing-parent-${uuid()}.txt`;
    const s1 = await open(project_id, path);
    const s2 = await open(project_id, path);
    for (let i = 0; i < 5; i++) {
      s1.from_str(`${s1.to_str()}line ${i}\n`);
      s1.commit();
      await s1.save();
    }
    await waitUntilSynced([s1, s2]);
    await (s1 as any).snapshot(s1.versions().at(-1));
    s1.from_str(`${s1.to_str()}after the snapshot\n`);
    s1.commit();
    await s1.save();
    await waitUntilSynced([s1, s2]);

    const last = s1.versions().at(-1);
    const missing = encodePatchId(
      decodePatchId(last).timeMs + 1,
      missingClient(s1, s2),
    );
    const child = encodePatchId(
      decodePatchId(last).timeMs + 2,
      decodePatchId(s2.versions().at(-1) ?? last).clientId + "x",
    );
    await writeRecord(s2, {
      time: child,
      wall: decodePatchId(child).timeMs,
      user_id: 1,
      parents: [missing],
      version: s1.versions().length + 2,
      patch: "[]",
    });
    await waitUntilSynced([s1, s2]);
    return { project_id, path, s1, s2, last, missing };
  };

  it("does not load the whole history when the missing parent's author has an older patch loaded", async () => {
    const { project_id, path, s1, last, missing } = await setup(
      (s1) => decodePatchId(s1.versions().at(-1)).clientId,
    );
    const s3 = await open(project_id, path);
    const session = (s3 as any).patchflowSession;
    // still waiting on the missing patch (only a repair or the patch fixes that)
    expect(session.needsMoreHistory()).toBe(true);
    // but it did not load everything looking for it
    expect(s3.hasFullHistory()).toBe(false);
    expect(s3.to_str()).toBe(s1.to_str());

    // The repair: an empty patch with the missing id, on the patch before it.
    await writeRecord(s1, {
      time: missing,
      wall: decodePatchId(missing).timeMs,
      user_id: 1,
      parents: [last],
      version: s1.versions().length + 1,
      patch: "[]",
    });
    await wait({ until: () => session.getPatch(missing) != null });
    expect(session.needsMoreHistory()).toBe(false);
    await wait({
      until: () => (s1 as any).patchflowSession.getPatch(missing) != null,
    });
    expect((s1 as any).patchflowSession.needsMoreHistory()).toBe(false);
    const s4 = await open(project_id, path);
    expect((s4 as any).patchflowSession.needsMoreHistory()).toBe(false);
    expect(s4.hasFullHistory()).toBe(false);
    expect(s4.to_str()).toBe(s1.to_str());
    expect(s3.to_str()).toBe(s1.to_str());
  }, 60_000);

  it("still loads older history when the missing parent's author has no older patch loaded", async () => {
    const { project_id, path } = await setup(() => "someone-else");
    const s3 = await open(project_id, path);
    // it may be below the loaded history, so the whole history is loaded
    expect(s3.hasFullHistory()).toBe(true);
  }, 60_000);

  // Snapshots wait while more history is needed, and a parent that is not in
  // the stream never arrives. Once that has lasted the bound, a client loads
  // the whole history (once) and, if more is still needed, snapshots without
  // it: it writes nothing else, and every client shows the same value.
  describe("snapshots after a parent that never arrives", () => {
    afterEach(() =>
      setSnapshotsBlockedLimits({
        boundMs: 10 * 60_000,
        loadCap: 200_000,
        byteCap: 512 * 1024 * 1024,
      }),
    );

    const lostParent = (s1) => decodePatchId(s1.versions().at(-1)).clientId;

    // the patch records in the stream
    const streamTimes = (doc): string[] =>
      ((doc as any).dstream().getAll() ?? []).map((m) => `${m?.time}`);

    it("holds snapshots back, without loading more history, until the bound", async () => {
      const { project_id, path } = await setup(lostParent);
      const s3 = await open(project_id, path);
      expect((s3 as any).patchflowSession.needsMoreHistory()).toBe(true);
      expect(await (s3 as any).snapshotDespiteMissingHistory()).toBe(false);
      expect(s3.hasFullHistory()).toBe(false);
    }, 60_000);

    // commits a few edits with snapshot interval 1, then runs
    // snapshotIfNecessary now (it is throttled: the commits already called it)
    const editAndRunSnapshots = async (doc, n = 4) => {
      await doc.set_snapshot_interval(1);
      for (let i = 0; i < n; i++) {
        doc.from_str(`${doc.to_str()}x${i}\n`);
        doc.commit();
        await doc.save();
      }
      doc.snapshotIfNecessary();
      await doc.snapshotIfNecessary.flush();
    };
    // a patch id of client at most beforeMs that no patch of doc has
    const freeId = (doc, beforeMs: number, client: string) => {
      const taken = new Set(streamTimes(doc));
      for (let ms = beforeMs; ; ms--) {
        const t = encodePatchId(ms, client);
        if (!taken.has(t)) return t;
      }
    };
    const snapshotCount = (doc) =>
      ((doc as any).dstream().getAll() ?? []).filter((m) => m?.is_snapshot)
        .length;

    it("after the bound: loads the whole history once, snapshots, records the gap once, and writes nothing else", async () => {
      const { project_id, path, s1, missing } = await setup(lostParent);
      setSnapshotsBlockedLimits({ boundMs: 0 });
      const s3 = await open(project_id, path);
      const gaps: any[] = [];
      s3.on("history-gap", (info) => gaps.push(info));
      const value = s3.to_str();
      expect(value).toBe(s1.to_str());
      expect(await (s3 as any).snapshotDespiteMissingHistory()).toBe(true);
      expect(s3.hasFullHistory()).toBe(true);
      // the gate alone records nothing: no snapshot was made yet
      expect(gaps).toEqual([]);
      const before = snapshotCount(s3);
      await editAndRunSnapshots(s3);
      await wait({ until: () => snapshotCount(s3) > before, timeout: 10_000 });
      // one record per snapshot made without the waiting patches
      expect(gaps.length).toBeGreaterThanOrEqual(1);
      expect(gaps).toHaveLength(snapshotCount(s3) - before);
      expect(gaps[0].missing).toEqual([missing]);
      expect(gaps[0].affected).toBeGreaterThanOrEqual(1);
      expect(gaps[0].snapshot).toBeTruthy();
      // nothing with the missing id was written
      expect(streamTimes(s3)).not.toContain(missing);
      // a client that opens later (after a second snapshot) neither waits
      // nor loads the whole history, and shows the same value
      s3.from_str(`${s3.to_str()}more\n`);
      s3.commit();
      await s3.save();
      await (s3 as any).snapshot(s3.versions().at(-1));
      await waitUntilSynced([s1, s3]);
      const s4 = await open(project_id, path);
      expect((s4 as any).patchflowSession.needsMoreHistory()).toBe(false);
      expect(s4.hasFullHistory()).toBe(false);
      expect(s4.to_str()).toBe(s3.to_str());
      expect(streamTimes(s4)).not.toContain(missing);
    }, 60_000);

    it("snapshotIfNecessary makes no snapshot before the bound", async () => {
      const { project_id, path } = await setup(lostParent);
      const s3 = await open(project_id, path);
      const gaps: any[] = [];
      s3.on("history-gap", (info) => gaps.push(info));
      const before = snapshotCount(s3);
      await editAndRunSnapshots(s3);
      await new Promise((r) => setTimeout(r, 300));
      expect(snapshotCount(s3)).toBe(before);
      expect(gaps).toEqual([]);
      expect(s3.hasFullHistory()).toBe(false);
    }, 60_000);

    it("records nothing when no snapshot record is written", async () => {
      const { project_id, path } = await setup(lostParent);
      setSnapshotsBlockedLimits({ boundMs: 0 });
      const s3 = await open(project_id, path);
      const gaps: any[] = [];
      s3.on("history-gap", (info) => gaps.push(info));
      // (as when the patch is already a snapshot)
      (s3 as any).snapshot = async () => false;
      await editAndRunSnapshots(s3);
      await new Promise((r) => setTimeout(r, 200));
      expect(gaps).toEqual([]);
    }, 60_000);

    it("records nothing when there is no snapshot to make", async () => {
      const { project_id, path } = await setup(lostParent);
      setSnapshotsBlockedLimits({ boundMs: 0 });
      const s3 = await open(project_id, path);
      const gaps: any[] = [];
      s3.on("history-gap", (info) => gaps.push(info));
      // the default interval: no candidate in so short a history
      (s3 as any).snapshotIfNecessary();
      await (s3 as any).snapshotIfNecessary.flush();
      await new Promise((r) => setTimeout(r, 200));
      expect(gaps).toEqual([]);
    }, 60_000);

    it("records nothing when the snapshot is not saved", async () => {
      const { project_id, path } = await setup(lostParent);
      setSnapshotsBlockedLimits({ boundMs: 0 });
      const s3 = await open(project_id, path);
      const gaps: any[] = [];
      s3.on("history-gap", (info) => gaps.push(info));
      (s3 as any).snapshot = async () => {
        throw Error("save failed");
      };
      await editAndRunSnapshots(s3);
      await new Promise((r) => setTimeout(r, 200));
      expect(gaps).toEqual([]);
    }, 60_000);

    it("records exactly one gap per snapshot that is made", async () => {
      const { project_id, path } = await setup(lostParent);
      setSnapshotsBlockedLimits({ boundMs: 0 });
      const s3 = await open(project_id, path);
      const gaps: any[] = [];
      s3.on("history-gap", (info) => gaps.push(info));
      const before = snapshotCount(s3);
      await editAndRunSnapshots(s3);
      await wait({ until: () => snapshotCount(s3) > before, timeout: 10_000 });
      const made = snapshotCount(s3) - before;
      // running it again without new patches makes no new snapshot
      (s3 as any).snapshotIfNecessary();
      await (s3 as any).snapshotIfNecessary.flush();
      await new Promise((r) => setTimeout(r, 200));
      expect(gaps).toHaveLength(snapshotCount(s3) - before);
      expect(gaps.length).toBeGreaterThanOrEqual(made);
    }, 60_000);

    it("does not load when the stream size is not a finite count", async () => {
      const { project_id, path } = await setup(lostParent);
      setSnapshotsBlockedLimits({ boundMs: 0 });
      const s3 = await open(project_id, path);
      const stream = (s3 as any).dstream().stream;
      stream.inventory = async () => ({ count: NaN, bytes: NaN });
      expect(await (s3 as any).snapshotDespiteMissingHistory()).toBe(false);
      expect(s3.hasFullHistory()).toBe(false);
    }, 60_000);

    it("does not load when the stream size is negative or fractional", async () => {
      const { project_id, path } = await setup(lostParent);
      setSnapshotsBlockedLimits({ boundMs: 0 });
      const s3 = await open(project_id, path);
      const stream = (s3 as any).dstream().stream;
      stream.inventory = async () => ({ count: 1.5, bytes: 10 });
      expect(await (s3 as any).snapshotDespiteMissingHistory()).toBe(false);
      expect(s3.hasFullHistory()).toBe(false);
    }, 60_000);

    it("does not load a stream over the byte limit, and keeps snapshots held back", async () => {
      const { project_id, path } = await setup(lostParent);
      setSnapshotsBlockedLimits({ boundMs: 0, byteCap: 1 });
      const s3 = await open(project_id, path);
      expect(await (s3 as any).snapshotDespiteMissingHistory()).toBe(false);
      expect(s3.hasFullHistory()).toBe(false);
    }, 60_000);

    it("a parentless patch that makes the history look complete does not stop the whole stream from being read", async () => {
      const project_id = uuid();
      const path = `rootless-${uuid()}.txt`;
      const s1 = await open(project_id, path);
      for (let i = 0; i < 3; i++) {
        s1.from_str(`${s1.to_str()}line ${i}\n`);
        s1.commit();
        await s1.save();
      }
      s1.from_str(`${s1.to_str()}real\n`);
      s1.commit();
      await s1.save();
      const R = s1.versions().at(-1);
      for (let k = 0; k < 2; k++) {
        s1.from_str(`${s1.to_str()}more ${k}\n`);
        s1.commit();
        await s1.save();
        await (s1 as any).snapshot(s1.versions().at(-1));
      }
      const client = decodePatchId(R).clientId;
      // F: parentless, with an id of R's client from before R
      const F = freeId(s1, decodePatchId(R).timeMs - 1, client);
      const C = encodePatchId(
        decodePatchId(s1.versions().at(-1)).timeMs + 1,
        "other",
      );
      await writeRecord(s1, {
        time: F,
        wall: decodePatchId(F).timeMs,
        user_id: 1,
        parents: [],
        version: 1,
        patch: "[]",
      });
      await writeRecord(s1, {
        time: C,
        wall: decodePatchId(C).timeMs,
        user_id: 1,
        parents: [R, s1.versions().at(-1)],
        version: 1,
        patch: "[]",
      });
      setSnapshotsBlockedLimits({ boundMs: 0 });
      const s3 = await open(project_id, path);
      const gaps: any[] = [];
      s3.on("history-gap", (info) => gaps.push(info));
      // the loaded range looks complete (it holds a parentless patch)...
      expect(s3.hasFullHistory()).toBe(true);
      expect(streamTimes(s3)).not.toContain(R);
      // ...but the gate reads the whole stream, finds R, and so nothing waits
      // and no snapshot leaves anything out
      expect(await (s3 as any).snapshotDespiteMissingHistory()).toBe(false);
      expect(streamTimes(s3)).toContain(R);
      expect((s3 as any).patchflowSession.needsMoreHistory()).toBe(false);
      expect(gaps).toEqual([]);
    }, 60_000);

    it("snapshotIfNecessary makes the snapshot once the bound has passed", async () => {
      const { project_id, path } = await setup(lostParent);
      setSnapshotsBlockedLimits({ boundMs: 0 });
      const s3 = await open(project_id, path);
      const snapshots = () =>
        ((s3 as any).dstream().getAll() ?? []).filter((m) => m?.is_snapshot)
          .length;
      // (counted before the edits: each commit already runs the check, so the
      // snapshot can be made by one of them)
      const before = snapshots();
      await s3.set_snapshot_interval(1);
      for (let i = 0; i < 4; i++) {
        s3.from_str(`${s3.to_str()}x${i}\n`);
        s3.commit();
        await s3.save();
      }
      // (throttled: the commits above already called it)
      (s3 as any).snapshotIfNecessary();
      await (s3 as any).snapshotIfNecessary.flush();
      await wait({ until: () => snapshots() > before, timeout: 10_000 });
      expect(snapshots()).toBeGreaterThan(before);
    }, 60_000);

    it("does not load past the load cap, and keeps snapshots held back", async () => {
      const { project_id, path } = await setup(lostParent);
      setSnapshotsBlockedLimits({ boundMs: 0, loadCap: 0 });
      const s3 = await open(project_id, path);
      expect(await (s3 as any).snapshotDespiteMissingHistory()).toBe(false);
      expect(s3.hasFullHistory()).toBe(false);
    }, 60_000);

    it("a parent that arrives after the snapshot is shown the same way by every client, on either way of loading", async () => {
      const { project_id, path, s1, last, missing } = await setup(lostParent);
      setSnapshotsBlockedLimits({ boundMs: 0 });
      const s3 = await open(project_id, path);
      expect(await (s3 as any).snapshotDespiteMissingHistory()).toBe(true);
      const value = s3.to_str();
      s3.from_str(`${value}after the gap\n`);
      s3.commit();
      await s3.save();
      await (s3 as any).snapshot(s3.versions().at(-1));
      s3.from_str(`${s3.to_str()}more\n`);
      s3.commit();
      await s3.save();
      await (s3 as any).snapshot(s3.versions().at(-1));
      await waitUntilSynced([s1, s3]);
      const before = s3.to_str();
      // the missing parent arrives late, with real content
      const tmp = await open(uuid(), `tmp-${uuid()}.txt`);
      tmp.from_str(s1.to_str());
      tmp.commit();
      await tmp.save();
      tmp.from_str(`${tmp.to_str()}LATE\n`);
      tmp.commit();
      await tmp.save();
      const lateTime = `${tmp.versions().at(-1)}`;
      const latePatch = ((tmp as any).dstream().getAll() ?? []).find(
        (m) => `${m?.time}` === lateTime,
      );
      expect(latePatch?.patch).toBeTruthy();
      await writeRecord(s1, {
        time: missing,
        wall: decodePatchId(missing).timeMs,
        user_id: 1,
        parents: [last],
        version: 1,
        patch: (latePatch as any).patch,
      });
      await waitUntilSynced([s1, s3]);
      // a client that opens from the latest snapshot, and one that loads the
      // whole history, show the same value as the one that was open
      const s5 = await open(project_id, path);
      const s6 = await open(project_id, path);
      await s6.loadMoreHistory({ all: true });
      expect(s6.hasFullHistory()).toBe(true);
      expect(s5.to_str()).toBe(s3.to_str());
      expect(s6.to_str()).toBe(s3.to_str());
      // the late patch is not lost: every client now shows it
      expect(s3.to_str()).not.toBe(before);
      expect(s3.to_str()).toContain("LATE");
    }, 60_000);

    it("a parent that only looks missing (an older patch id of its author appears later) is found, and nothing is left out", async () => {
      const project_id = uuid();
      const path = `looks-missing-${uuid()}.txt`;
      const s1 = await open(project_id, path);
      for (let i = 0; i < 3; i++) {
        s1.from_str(`${s1.to_str()}line ${i}\n`);
        s1.commit();
        await s1.save();
      }
      // R: a real patch of s1, then history moves on past two snapshots
      s1.from_str(`${s1.to_str()}real\n`);
      s1.commit();
      await s1.save();
      const R = s1.versions().at(-1);
      for (let k = 0; k < 2; k++) {
        s1.from_str(`${s1.to_str()}more ${k}\n`);
        s1.commit();
        await s1.save();
        await (s1 as any).snapshot(s1.versions().at(-1));
      }
      const exact = s1.to_str();
      const client = decodePatchId(R).clientId;
      // F: a patch with an id "of s1's client" from before R; C: a patch on R
      const F = freeId(s1, decodePatchId(R).timeMs - 1, client);
      const C = encodePatchId(
        decodePatchId(s1.versions().at(-1)).timeMs + 1,
        "other",
      );
      await writeRecord(s1, {
        time: F,
        wall: decodePatchId(F).timeMs,
        user_id: 1,
        parents: [s1.versions()[0]],
        version: 1,
        patch: "[]",
      });
      await writeRecord(s1, {
        time: C,
        wall: decodePatchId(C).timeMs,
        user_id: 1,
        parents: [R, s1.versions().at(-1)],
        version: 1,
        patch: "[]",
      });
      setSnapshotsBlockedLimits({ boundMs: 0 });
      const s3 = await open(project_id, path);
      const gaps: any[] = [];
      s3.on("history-gap", (info) => gaps.push(info));
      await (s3 as any).snapshotDespiteMissingHistory();
      // the whole history has R: nothing waits, no gap is recorded
      expect((s3 as any).patchflowSession.needsMoreHistory()).toBe(false);
      expect(gaps).toEqual([]);
      expect(s3.to_str()).toBe(exact);
      expect(streamTimes(s3)).toContain(R);
    }, 60_000);
  });
});
