import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter, once } from "events";
import { SyncFsService } from "./sync-fs-service";
import { tmpNameSync } from "tmp-promise";
import { SyncFsWatchStore } from "./sync-fs-watch";
import { DiffMatchPatch, decompressPatch } from "@cocalc/util/dmp";
import { decodePatchId, legacyPatchId } from "patchflow";
import { getBackendWatcherDebugStats } from "../watcher-debug";
import { client_db } from "@cocalc/util/db-schema/client-db";

class FakeAStream {
  public messages: { mesg: any; seq: number }[] = [];
  public lastStartSeq?: number;
  public closeCalls = 0;
  private seq: number;

  constructor(messages: { mesg: any; seq: number }[] = []) {
    this.messages = [...messages];
    this.seq = messages.reduce((max, m) => Math.max(max, m.seq), 0);
  }

  async publish(mesg: any): Promise<{ seq: number }> {
    const seq = ++this.seq;
    this.messages.push({ mesg, seq });
    return { seq };
  }

  async *getAll(opts: { start_seq?: number; timeout?: number }) {
    this.lastStartSeq = opts.start_seq;
    for (const m of this.messages) {
      if (opts.start_seq != null && m.seq < opts.start_seq) continue;
      yield m;
    }
  }

  async get(seq: number): Promise<any | undefined> {
    return this.messages.find((m) => m.seq === seq)?.mesg;
  }

  close(): void {
    this.closeCalls += 1;
  }
}

function installWriterCache(
  svc: SyncFsService,
  writers: Map<string, FakeAStream>,
): void {
  (svc as any).getPatchWriter = async ({ string_id }) => {
    let writer = writers.get(string_id);
    if (writer == null) {
      writer = new FakeAStream();
      writers.set(string_id, writer);
    }
    ((svc as any).patchWriters as Map<string, FakeAStream>).set(
      string_id,
      writer,
    );
    return writer;
  };
}

function syncStringId(projectId: string, syncPath: string): string {
  return client_db.sha1(projectId, syncPath);
}

describe("SyncFsService", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sync-fs-service-"));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("emits a change event with a patch on external edit", async () => {
    const path = join(dir, "a.txt");
    writeFileSync(path, "hello");

    const svc = new SyncFsService();
    await svc.heartbeat(path);
    await new Promise((r) => setTimeout(r, 50));

    // external edit
    writeFileSync(path, "hello world");

    const [evt] = (await once(svc, "event")) as any[];
    expect(evt.path).toBe(path);
    expect(evt.type).toBe("change");
    expect(evt.change?.patch).toBeDefined();
    svc.close();
  }, 10_000);

  it("stops watching when active=false", async () => {
    const path = join(dir, "c.txt");
    writeFileSync(path, "keep");

    const svc = new SyncFsService();
    await svc.heartbeat(path);
    await new Promise((r) => setTimeout(r, 50));

    // drop interest
    await svc.heartbeat(path, false);

    writeFileSync(path, "keep2");

    let eventReceived = false;
    svc.once("event", () => {
      eventReceived = true;
    });

    await new Promise((r) => setTimeout(r, 500));
    expect(eventReceived).toBe(false);
    svc.close();
  }, 10_000);

  it("absorbs watcher errors queued after close", async () => {
    const svc = new SyncFsService();
    const errors: Error[] = [];
    svc.on("error", (err) => errors.push(err));
    const watcher = Object.assign(new EventEmitter(), {
      close: jest.fn(function (this: EventEmitter) {
        // This is what Chokidar does synchronously before its pending
        // filesystem work has necessarily stopped emitting events.
        this.removeAllListeners();
        return Promise.resolve();
      }),
    });
    (svc as any).watchers.set(dir, {
      watcher,
      paths: new Set([join(dir, "file.txt")]),
    });

    (svc as any).closeWatcher(dir, "test");

    expect(() =>
      watcher.emit("error", new Error("late watcher error")),
    ).not.toThrow();
    expect(errors).toEqual([]);
    expect(watcher.close).toHaveBeenCalledTimes(1);
    svc.close();
  });

  it("releases cached patch writers when active=false", async () => {
    const path = join(dir, "release.txt");
    writeFileSync(path, "keep");

    const svc = new SyncFsService();
    const projectId = "p-release";
    const syncPath = "release.txt";
    const stringId = syncStringId(projectId, syncPath);
    const fake = new FakeAStream();
    installWriterCache(svc, new Map([[stringId, fake]]));

    await svc.heartbeat(path, true, {
      project_id: projectId,
      syncPath,
    });
    await new Promise((r) => setTimeout(r, 50));

    expect((svc as any).getDebugStats().patchWriters).toBe(1);
    await svc.heartbeat(path, false);

    expect(fake.closeCalls).toBe(1);
    expect((svc as any).getDebugStats()).toMatchObject({
      activePaths: 0,
      patchWriters: 0,
    });
    svc.close();
  }, 10_000);

  it("emits delete when file removed", async () => {
    const path = join(dir, "b.txt");
    writeFileSync(path, "bye");

    const svc = new SyncFsService();
    await svc.heartbeat(path);
    await new Promise((r) => setTimeout(r, 50));

    rmSync(path);

    const [evt] = (await once(svc, "event")) as any[];
    expect(evt.type).toBe("delete");
    svc.close();
  }, 10_000);

  it("dedupes concurrent directory watcher creation", async () => {
    const a = join(dir, "race-a.txt");
    const b = join(dir, "race-b.txt");
    writeFileSync(a, "a");
    writeFileSync(b, "b");

    const svc = new SyncFsService();
    await Promise.all([svc.heartbeat(a), svc.heartbeat(b)]);
    await new Promise((r) => setTimeout(r, 50));

    const watchers = (svc as any).watchers as Map<string, any>;
    expect(watchers.size).toBe(1);
    const entry = Array.from(watchers.values())[0];
    expect(entry.paths.has(a)).toBe(true);
    expect(entry.paths.has(b)).toBe(true);

    const stats = getBackendWatcherDebugStats({ topN: 200 });
    const countForDir =
      stats.activeByPathTop.find((x: any) => x.path === dir)?.count ?? 0;
    expect(countForDir).toBe(1);

    svc.close();
  }, 10_000);

  it("prunes stale paths individually even within the same directory", async () => {
    const a = join(dir, "ttl-a.txt");
    const b = join(dir, "ttl-b.txt");
    writeFileSync(a, "a");
    writeFileSync(b, "b");

    const svc = new SyncFsService();
    const fakeA = new FakeAStream();
    const fakeB = new FakeAStream();
    const projectId = "p-ttl";
    const syncPathA = "ttl-a.txt";
    const syncPathB = "ttl-b.txt";
    const writers = new Map<string, FakeAStream>([
      [syncStringId(projectId, syncPathA), fakeA],
      [syncStringId(projectId, syncPathB), fakeB],
    ]);
    installWriterCache(svc, writers);

    await svc.heartbeat(b, true, {
      project_id: projectId,
      syncPath: syncPathB,
    });
    await svc.heartbeat(a, true, {
      project_id: projectId,
      syncPath: syncPathA,
    });
    const pathStates = (svc as any).pathStates as Map<
      string,
      { lastHeartbeat: number }
    >;
    const now = Date.now();
    pathStates.get(a)!.lastHeartbeat = now;
    pathStates.get(b)!.lastHeartbeat = now - 61_000;
    (svc as any).pruneStale();

    const stats = (svc as any).getDebugStats();
    expect(stats).toMatchObject({
      activePaths: 1,
      activePathsTop: [{ path: a }],
      releasesByReasonTop: [{ reason: "stale", count: 1 }],
    });
    expect(stats.recentReleases[0]).toMatchObject({
      path: b,
      reason: "stale",
    });
    svc.close();
  }, 10_000);

  it("evicts the oldest active path when the cap is exceeded", async () => {
    const a = join(dir, "cap-a.txt");
    const b = join(dir, "cap-b.txt");
    writeFileSync(a, "a");
    writeFileSync(b, "b");

    const svc = new SyncFsService(undefined, {
      maxActivePaths: 1,
      heartbeatTtlMs: 60_000,
      pruneIntervalMs: 60_000,
    });
    const fakeA = new FakeAStream();
    const fakeB = new FakeAStream();
    const projectId = "p-cap";
    const syncPathA = "cap-a.txt";
    const syncPathB = "cap-b.txt";
    const writers = new Map<string, FakeAStream>([
      [syncStringId(projectId, syncPathA), fakeA],
      [syncStringId(projectId, syncPathB), fakeB],
    ]);
    installWriterCache(svc, writers);

    await svc.heartbeat(a, true, {
      project_id: projectId,
      syncPath: syncPathA,
    });
    await new Promise((r) => setTimeout(r, 10));
    await svc.heartbeat(b, true, {
      project_id: projectId,
      syncPath: syncPathB,
    });

    expect(fakeA.closeCalls).toBeGreaterThanOrEqual(1);
    expect((svc as any).getDebugStats()).toMatchObject({
      activePaths: 1,
      patchWriters: 1,
    });
    svc.close();
  }, 10_000);

  it("emits delete then rebuilds patches from empty base on recreate", async () => {
    const path = join(dir, "recreate.txt");
    writeFileSync(path, "first");

    const svc = new SyncFsService();
    const fake = new FakeAStream();
    (svc as any).getPatchWriter = async () => fake;
    const projectId = "p1";
    const syncPath = "recreate.txt";
    await svc.heartbeat(path, true, {
      project_id: projectId,
      syncPath,
    });
    await new Promise((r) => setTimeout(r, 50));

    rmSync(path);
    const [delEvt] = (await once(svc, "event")) as any[];
    expect(delEvt.type).toBe("delete");
    // store should mark the path deleted (not just empty content)
    const deletedState = (svc as any).store.get(path);
    expect(deletedState?.deleted).toBe(true);

    // recreate with different content; change patch should be from empty -> "second"
    writeFileSync(path, "second");
    const [chgEvt] = (await once(svc, "event")) as any[];
    expect(chgEvt.type).toBe("change");

    const dmp = new DiffMatchPatch({ diffTimeout: 0.5 });
    const patches = decompressPatch(chgEvt.change.patch);
    const [result, applied] = dmp.patch_apply(patches, "");
    expect(applied.every(Boolean)).toBe(true);
    expect(result).toBe("second");

    const finalState = (svc as any).store.get(path);
    expect(finalState?.deleted).toBe(false);
    expect(finalState?.content).toBe("second");

    await new Promise((r) => setTimeout(r, 100));
    svc.close();
  }, 10_000);

  it("does not drop external edits during local-write suppression window", async () => {
    const path = join(dir, "suppression.txt");
    writeFileSync(path, "base");

    const svc = new SyncFsService();
    await svc.heartbeat(path);
    await new Promise((r) => setTimeout(r, 50));

    // Simulate a local write that would normally set temporary suppression.
    svc.recordLocalWrite(path, "local-value", true);
    // An external actor immediately writes different content.
    writeFileSync(path, "external-value");

    const [evt] = (await once(svc, "event")) as any[];
    expect(evt.path).toBe(path);
    expect(evt.type).toBe("change");
    expect(evt.change?.patch).toBeDefined();
    svc.close();
  }, 10_000);

  it("reuses persisted heads/lastSeq and resumes with start_seq", async () => {
    const dbPath = tmpNameSync({ prefix: "sync-fs-heads-", postfix: ".db" });
    const store1 = new SyncFsWatchStore(dbPath);
    const svc1 = new SyncFsService(store1);
    const fake = new FakeAStream();

    // Monkeypatch writer factory for testing.
    (svc1 as any).getPatchWriter = async () => fake;

    const projectId = "p1";
    const syncPath = "a.txt";
    const stringId = syncStringId(projectId, syncPath);
    const meta = { project_id: projectId, syncPath };
    const change = { patch: [], content: "v1", hash: "h1", deleted: false };
    await (svc1 as any).appendPatch(meta, "change", change);
    const head1 = store1.getFsHead(stringId);
    expect(head1?.lastSeq).toBe(1);
    svc1.close();

    // Simulate an external patch arriving while service is down.
    await fake.publish({ time: 200, parents: [], version: 2 });

    const store2 = new SyncFsWatchStore(dbPath);
    const svc2 = new SyncFsService(store2);
    (svc2 as any).getPatchWriter = async () => fake;

    const change2 = { patch: [], content: "v2", hash: "h2", deleted: false };
    await (svc2 as any).appendPatch(meta, "change", change2);

    expect(fake.lastStartSeq).toBe(2); // resume after persisted lastSeq
    const head2 = store2.getFsHead(stringId);
    expect(head2?.lastSeq).toBe(3);
    expect(head2?.version).toBe(3);
    expect(head2?.heads?.length).toBe(1);
    const headId = (head2?.heads ?? [])[0];
    expect(decodePatchId(headId!).timeMs).toBeGreaterThan(200);

    svc2.close();
  }, 10_000);

  it("falls back to full replay when heads are missing but lastSeq exists", async () => {
    const dbPath = tmpNameSync({ prefix: "sync-fs-heads-", postfix: ".db" });
    const store = new SyncFsWatchStore(dbPath);
    store.setFsHead({
      string_id: syncStringId("p2", "c.txt"),
      time: legacyPatchId(50),
      version: 1,
      heads: [],
      lastSeq: 5,
      formatVersion: 2,
    });

    const fake = new FakeAStream([
      { mesg: { time: 50, parents: [], version: 1 }, seq: 1 },
    ]);
    const svc = new SyncFsService(store);
    (svc as any).getPatchWriter = async () => fake;

    const meta = { project_id: "p2", syncPath: "c.txt" };
    const change = { patch: [], content: "v3", hash: "h3", deleted: false };
    await (svc as any).appendPatch(meta, "change", change);

    expect(fake.lastStartSeq).toBeUndefined();
    const published = fake.messages[fake.messages.length - 1].mesg;
    expect(Array.isArray(published.parents)).toBe(true);
    expect(published.parents.length).toBe(1);
    expect(decodePatchId(published.parents[0]).timeMs).toBe(50);

    const head = store.getFsHead(syncStringId("p2", "c.txt"));
    expect(head?.heads).toEqual([published.time]);
    expect(head?.lastSeq).toBe(fake.messages.length);
    svc.close();
  }, 10_000);

  it("retains trusted heads when an incremental stream refresh fails", async () => {
    const projectId = "p-head-refresh";
    const syncPath = "head-refresh.txt";
    const stringId = syncStringId(projectId, syncPath);
    const head = legacyPatchId(100);
    const store = new SyncFsWatchStore();
    store.setFsHead({
      string_id: stringId,
      time: head,
      version: 1,
      heads: [head],
      lastSeq: 1,
      formatVersion: 2,
    });
    const fake = new FakeAStream();
    (fake as any).getAll = async function* (opts: { start_seq?: number }) {
      fake.lastStartSeq = opts.start_seq;
      throw new Error("incremental refresh unavailable");
    };
    const svc = new SyncFsService(store);
    (svc as any).getPatchWriter = async () => fake;

    const result = await (svc as any).getStreamHeads({
      project_id: projectId,
      string_id: stringId,
      path: syncPath,
    });

    expect(result).toMatchObject({
      heads: [head],
      maxVersion: 1,
    });
    expect(fake.lastStartSeq).toBe(2);
    svc.close();
  }, 10_000);

  it("does not resurrect an old patch as a head when its snapshot is appended later", async () => {
    const first = legacyPatchId(100);
    const latest = legacyPatchId(200);
    const fake = new FakeAStream([
      { mesg: { time: first, parents: [], version: 1 }, seq: 1 },
      {
        mesg: { time: latest, parents: [first], version: 2 },
        seq: 2,
      },
      {
        mesg: {
          time: first,
          is_snapshot: true,
          snapshot: "first",
          seq_info: { seq: 1 },
        },
        seq: 3,
      },
    ]);
    const store = new SyncFsWatchStore();
    // This is the poisoned shape persisted by the previous head algorithm.
    // Missing formatVersion forces one full, non-destructive stream rebuild.
    store.setFsHead({
      string_id: syncStringId("p-snapshot", "snapshot.txt"),
      time: latest,
      version: 2,
      heads: [latest, first],
      lastSeq: 3,
    });
    const svc = new SyncFsService(store);
    (svc as any).getPatchWriter = async () => fake;

    const result = await (svc as any).getStreamHeads({
      project_id: "p-snapshot",
      string_id: syncStringId("p-snapshot", "snapshot.txt"),
      path: "snapshot.txt",
    });

    expect(result.heads).toEqual([latest]);
    expect(fake.lastStartSeq).toBeUndefined();
    expect(
      store.getFsHead(syncStringId("p-snapshot", "snapshot.txt")),
    ).toMatchObject({
      heads: [latest],
      lastSeq: 3,
      version: 2,
    });
    svc.close();
  });

  it("accepts a checkpoint snapshot as the only available stream head", async () => {
    const checkpoint = legacyPatchId(100);
    const fake = new FakeAStream([
      {
        mesg: {
          time: checkpoint,
          is_snapshot: true,
          snapshot: "checkpoint",
          seq_info: { seq: 1 },
        },
        seq: 2,
      },
    ]);
    const svc = new SyncFsService();
    (svc as any).getPatchWriter = async () => fake;

    const result = await (svc as any).getStreamHeads({
      project_id: "p-checkpoint",
      string_id: syncStringId("p-checkpoint", "checkpoint.txt"),
      path: "checkpoint.txt",
    });

    expect(result.heads).toEqual([checkpoint]);
    svc.close();
  });

  it("closes and abandons a stream baseline SyncDoc that never becomes ready", async () => {
    const doc = Object.assign(new EventEmitter(), {
      close: jest.fn(),
      to_str: jest.fn(() => "never"),
    });
    const svc = new SyncFsService(undefined, { docReadyTimeoutMs: 10 });
    svc.on("error", () => undefined);
    (svc as any).getConatClient = () => ({
      sync: { string: jest.fn(() => doc) },
    });

    await expect(
      (svc as any).loadDocViaSyncDoc({
        project_id: "p-timeout",
        string_id: syncStringId("p-timeout", "timeout.txt"),
        syncPath: "timeout.txt",
      }),
    ).resolves.toBeUndefined();
    expect(doc.close).toHaveBeenCalledTimes(1);
    expect(doc.listenerCount("ready")).toBe(0);
    expect(doc.listenerCount("error")).toBe(0);
    svc.close();
  });

  it("resets stale persisted heads if stream was deleted", async () => {
    const dbPath = tmpNameSync({ prefix: "sync-fs-heads-", postfix: ".db" });
    const store = new SyncFsWatchStore(dbPath);
    store.setFsHead({
      string_id: syncStringId("p3", "d.txt"),
      time: legacyPatchId(123),
      version: 7,
      heads: [legacyPatchId(123)],
      lastSeq: 42,
      formatVersion: 2,
    });

    // Simulate persist reset: stream has no historical messages.
    const fake = new FakeAStream([]);
    const svc = new SyncFsService(store);
    (svc as any).getPatchWriter = async () => fake;

    const meta = { project_id: "p3", syncPath: "d.txt" };
    const change = { patch: [], content: "fresh", hash: "h4", deleted: false };
    await (svc as any).appendPatch(meta, "change", change);

    const published = fake.messages[fake.messages.length - 1].mesg;
    expect(Array.isArray(published.parents)).toBe(true);
    expect(published.parents.length).toBe(0);
    expect(published.version).toBe(1);

    const head = store.getFsHead(syncStringId("p3", "d.txt"));
    expect(head?.version).toBe(1);
    expect(head?.lastSeq).toBe(1);
    expect(head?.heads?.length).toBe(1);
    svc.close();
  }, 10_000);

  it("publishes an initial patch when history is empty even if local snapshot exists", async () => {
    const path = join(dir, "cached.txt");
    writeFileSync(path, "fresh");

    const dbPath = tmpNameSync({ prefix: "sync-fs-init-", postfix: ".db" });
    const store = new SyncFsWatchStore(dbPath);
    // Simulate backend fs writes that populated the local snapshot cache before
    // any watcher/stream history existed.
    store.setContent(path, "fresh");

    const svc = new SyncFsService(store);
    const fake = new FakeAStream([]);
    (svc as any).getPatchWriter = async () => fake;

    await (svc as any).initPath(path, {
      project_id: "p4",
      syncPath: "cached.txt",
    });

    expect(fake.messages.length).toBe(1);
    const published = fake.messages[0].mesg;
    expect(Array.isArray(published.parents)).toBe(true);
    expect(published.parents).toEqual([]);
    expect(published.version).toBe(1);

    const dmp = new DiffMatchPatch({ diffTimeout: 0.5 });
    const patch = JSON.parse(published.patch);
    const [result, applied] = dmp.patch_apply(decompressPatch(patch), "");
    expect(applied.every(Boolean)).toBe(true);
    expect(result).toBe("fresh");
    svc.close();
  }, 10_000);

  it("does not publish an empty structured init patch", async () => {
    const path = join(dir, "empty-init.chat");
    writeFileSync(path, '{"a":1}\n');

    const svc = new SyncFsService();
    const fake = new FakeAStream([]);
    (svc as any).getPatchWriter = async () => fake;
    (svc as any).store.handleExternalChange = async () => ({
      patch: [1, []],
      content: '{"a":1}\n',
      hash: "same",
      deleted: false,
    });

    await (svc as any).initPath(path, {
      project_id: "p-empty",
      syncPath: "empty-init.chat",
      doctype: {
        type: "chat-immer",
        patch_format: 1,
        opts: {
          primary_keys: ["event", "sender_id", "date"],
        },
      },
    });

    expect(fake.messages.length).toBe(0);
    svc.close();
  }, 10_000);

  it("rebuilds local baseline from stream history before diffing", async () => {
    const path = join(dir, "history.txt");
    writeFileSync(path, "stream-value");

    const dbPath = tmpNameSync({
      prefix: "sync-fs-stream-baseline-",
      postfix: ".db",
    });
    const store = new SyncFsWatchStore(dbPath);
    // Stale local cache should not be used when stream history exists.
    store.setContent(path, "stale-cache");

    const fake = new FakeAStream([
      { mesg: { time: legacyPatchId(100), parents: [], version: 1 }, seq: 1 },
    ]);
    const svc = new SyncFsService(store);
    (svc as any).getPatchWriter = async () => fake;
    (svc as any).loadDocViaSyncDoc = async () => "stream-value";

    await (svc as any).initPath(path, {
      project_id: "p5",
      syncPath: "history.txt",
    });

    // No extra publish is needed because disk content already matches stream.
    expect(fake.messages.length).toBe(1);
    expect((svc as any).store.get(path)?.content).toBe("stream-value");
    svc.close();
  }, 10_000);

  it("does not reconcile disk when stream baseline load fails", async () => {
    const path = join(dir, "history-fallback.txt");
    writeFileSync(path, "disk-new");

    const dbPath = tmpNameSync({
      prefix: "sync-fs-stream-fallback-",
      postfix: ".db",
    });
    const store = new SyncFsWatchStore(dbPath);

    const fake = new FakeAStream([
      { mesg: { time: legacyPatchId(100), parents: [], version: 1 }, seq: 1 },
    ]);
    const svc = new SyncFsService(store);
    (svc as any).getPatchWriter = async () => fake;
    (svc as any).loadDocViaSyncDoc = async () => undefined;

    await (svc as any).initPath(path, {
      project_id: "p6",
      syncPath: "history-fallback.txt",
    });

    // Without the authoritative stream value, diffing from an empty local
    // cache would publish an insertion of the entire file and duplicate it.
    expect(fake.messages.length).toBe(1);
    expect((svc as any).store.get(path)).toBeUndefined();
    svc.close();
  }, 10_000);

  it("does not publish empty content when the disk read fails", async () => {
    const path = join(dir, "read-error.slides");
    mkdirSync(path);

    const fake = new FakeAStream([
      { mesg: { time: legacyPatchId(100), parents: [], version: 1 }, seq: 1 },
    ]);
    const svc = new SyncFsService();
    svc.on("error", () => undefined);
    (svc as any).getPatchWriter = async () => fake;
    (svc as any).loadDocViaSyncDoc = async () => "complete document";

    const initialized = await (svc as any).initPath(path, {
      project_id: "p-read-error",
      syncPath: "read-error.slides",
    });

    expect(initialized).toBe(false);
    expect(fake.messages).toHaveLength(1);
    expect((svc as any).store.get(path)).toMatchObject({
      content: "complete document",
      deleted: false,
    });
    svc.close();
  }, 10_000);

  it("does not infer a delete when the file is missing on init", async () => {
    const path = join(dir, "missing.slides");
    const fake = new FakeAStream([
      { mesg: { time: legacyPatchId(100), parents: [], version: 1 }, seq: 1 },
    ]);
    const svc = new SyncFsService();
    (svc as any).getPatchWriter = async () => fake;
    (svc as any).loadDocViaSyncDoc = async () => "complete document";

    const initialized = await (svc as any).initPath(path, {
      project_id: "p-missing",
      syncPath: "missing.slides",
    });

    expect(initialized).toBe(true);
    expect(fake.messages).toHaveLength(1);
    expect((svc as any).store.get(path)).toMatchObject({
      content: "complete document",
      deleted: false,
    });
    svc.close();
  }, 10_000);

  it("seeds an empty structured revision for a new missing file", async () => {
    const path = join(dir, "new-missing.syncdb");
    const fake = new FakeAStream([]);
    const svc = new SyncFsService();
    (svc as any).getPatchWriter = async () => fake;

    const initialized = await (svc as any).initPath(path, {
      project_id: "p-new-missing",
      syncPath: "new-missing.syncdb",
      doctype: {
        type: "db",
        patch_format: 1,
        opts: { primary_keys: ["id"] },
      },
    });

    expect(initialized).toBe(true);
    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0].mesg.meta).toBeUndefined();
    expect((svc as any).store.get(path)).toMatchObject({
      content: "",
      deleted: false,
    });
    svc.close();
  }, 10_000);

  it("does not arm a watcher until stream baseline loading succeeds", async () => {
    const path = join(dir, "history-retry.txt");
    writeFileSync(path, "disk-value");

    const fake = new FakeAStream([
      { mesg: { time: legacyPatchId(100), parents: [], version: 1 }, seq: 1 },
    ]);
    const svc = new SyncFsService();
    (svc as any).getPatchWriter = async () => fake;
    const loadBaseline = jest
      .spyOn(svc as any, "loadDocViaSyncDoc")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue("disk-value");
    const meta = {
      project_id: "p-history-retry",
      syncPath: "history-retry.txt",
    };

    await svc.heartbeat(path, true, meta);

    expect(fake.messages).toHaveLength(1);
    expect((svc as any).store.get(path)).toBeUndefined();
    expect(svc.getDebugStats()).toMatchObject({
      activePaths: 0,
      activeDirs: 0,
    });

    await svc.heartbeat(path, true, meta);

    expect(loadBaseline).toHaveBeenCalledTimes(2);
    expect(fake.messages).toHaveLength(1);
    expect((svc as any).store.get(path)?.content).toBe("disk-value");
    expect(svc.getDebugStats()).toMatchObject({
      activePaths: 1,
      activeDirs: 1,
    });
    svc.close();
  }, 10_000);

  it("does not treat a failed stream read as empty history", async () => {
    const path = join(dir, "history-read-error.txt");
    writeFileSync(path, "existing document");

    const fake = new FakeAStream();
    (fake as any).getAll = async function* () {
      throw new Error("stream unavailable");
    };
    const svc = new SyncFsService();
    svc.on("error", () => undefined);
    (svc as any).getPatchWriter = async () => fake;

    await (svc as any).initPath(path, {
      project_id: "p-history-read-error",
      syncPath: "history-read-error.txt",
    });

    expect(fake.messages).toHaveLength(0);
    expect((svc as any).store.get(path)).toBeUndefined();
    svc.close();
  }, 10_000);

  it("does not publish a disk patch if history appears after baseline initialization", async () => {
    const path = join(dir, "late-history.txt");
    writeFileSync(path, "existing document");

    const head = legacyPatchId(100);
    const fake = new FakeAStream([
      { mesg: { time: head, parents: [], version: 1 }, seq: 1 },
    ]);
    let reads = 0;
    (fake as any).getAll = async function* (opts: { start_seq?: number }) {
      fake.lastStartSeq = opts.start_seq;
      reads += 1;
      if (reads === 1) return;
      for (const message of fake.messages) {
        yield message;
      }
    };
    const svc = new SyncFsService();
    (svc as any).getPatchWriter = async () => fake;

    const initialized = await (svc as any).initPath(path, {
      project_id: "p-late-history",
      syncPath: "late-history.txt",
    });

    expect(initialized).toBe(false);
    expect(fake.messages).toHaveLength(1);
    svc.close();
  }, 10_000);

  it("does not reconcile an older on-disk file over newer patchflow history on init", async () => {
    const path = join(dir, "older-disk.txt");
    writeFileSync(path, "disk-old");
    utimesSync(path, 10, 10);

    const dbPath = tmpNameSync({
      prefix: "sync-fs-older-disk-",
      postfix: ".db",
    });
    const store = new SyncFsWatchStore(dbPath);
    store.setContent(path, "stale-cache");

    const fake = new FakeAStream([
      {
        mesg: { time: legacyPatchId(50_000), parents: [], version: 1 },
        seq: 1,
      },
    ]);
    const svc = new SyncFsService(store);
    (svc as any).getPatchWriter = async () => fake;
    (svc as any).loadDocViaSyncDoc = async () => "stream-new";

    await (svc as any).initPath(path, {
      project_id: "p7a",
      syncPath: "older-disk.txt",
    });

    // Existing stream message only; no rollback patch published from stale disk.
    expect(fake.messages.length).toBe(1);
    expect((svc as any).store.get(path)?.content).toBe("stream-new");
    svc.close();
  }, 10_000);

  it("still reconciles a newer on-disk file over older patchflow history on init", async () => {
    const path = join(dir, "newer-disk.txt");
    writeFileSync(path, "disk-new");
    utimesSync(path, 200, 200);

    const dbPath = tmpNameSync({
      prefix: "sync-fs-newer-disk-",
      postfix: ".db",
    });
    const store = new SyncFsWatchStore(dbPath);
    store.setContent(path, "stale-cache");

    const fake = new FakeAStream([
      {
        mesg: { time: legacyPatchId(50_000), parents: [], version: 1 },
        seq: 1,
      },
    ]);
    const svc = new SyncFsService(store);
    (svc as any).getPatchWriter = async () => fake;
    (svc as any).loadDocViaSyncDoc = async () => "stream-old";

    await (svc as any).initPath(path, {
      project_id: "p7b",
      syncPath: "newer-disk.txt",
    });

    // Existing stream message + one published reconciliation patch from disk.
    expect(fake.messages.length).toBe(2);
    expect((svc as any).store.get(path)?.content).toBe("disk-new");
    svc.close();
  }, 10_000);

  it("serializes concurrent one-shot reconciles for the same path", async () => {
    const path = join(dir, "reconcile-once.txt");
    writeFileSync(path, "fresh");

    const svc = new SyncFsService();
    const initPath = jest.spyOn(svc as any, "initPath").mockImplementation(
      async () =>
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        }),
    );

    await Promise.all([
      svc.reconcile(path, {
        project_id: "p7c",
        syncPath: "reconcile-once.txt",
      }),
      svc.reconcile(path, {
        project_id: "p7c",
        syncPath: "reconcile-once.txt",
      }),
    ]);

    expect(initPath).toHaveBeenCalledTimes(1);
    svc.close();
  }, 10_000);

  it("reinitializes a watched path when syncPath switches to a new canonical identity", async () => {
    const path = join(dir, "identity-switch.txt");
    writeFileSync(path, "tracked");

    const svc = new SyncFsService();
    const projectId = "p7";
    const relativeSyncPath = "build/cocalc-lite4/identity-switch.txt";
    const absoluteSyncPath =
      "/home/wstein/build/cocalc-lite4/identity-switch.txt";
    const oldWriter = new FakeAStream();
    const newWriter = new FakeAStream();
    installWriterCache(
      svc,
      new Map([
        [syncStringId(projectId, relativeSyncPath), oldWriter],
        [syncStringId(projectId, absoluteSyncPath), newWriter],
      ]),
    );

    await svc.heartbeat(path, true, {
      project_id: projectId,
      syncPath: relativeSyncPath,
    });
    expect(oldWriter.messages).toHaveLength(1);

    await svc.heartbeat(path, true, {
      project_id: projectId,
      syncPath: absoluteSyncPath,
    });

    // The new identity must get its own initial patch even though the same
    // on-disk file path was already being watched.
    expect(newWriter.messages).toHaveLength(1);
    expect(oldWriter.closeCalls).toBe(1);
    expect((svc as any).getDebugStats().patchWriters).toBe(1);
    svc.close();
  }, 10_000);
});

describe("SyncFsService snapshot retention", () => {
  it("deletes snapshots of paths nobody watches after the ttl", async () => {
    const store = new SyncFsWatchStore();
    const svc = new SyncFsService(store, {
      snapshotTtlMs: 60_000,
      snapshotPruneIntervalMs: 3_600_000,
    });
    try {
      store.setContent("/p/watched.txt", "w");
      store.setContent("/p/closed.txt", "c");
      (svc as any).pathStates.set("/p/watched.txt", {
        dir: "/p",
        lastHeartbeat: Date.now(),
        createdAt: Date.now(),
      });
      await expect(svc.pruneSnapshots()).resolves.toBe(0);
      const now = Date.now();
      jest.spyOn(Date, "now").mockReturnValue(now + 61_000);
      await expect(svc.pruneSnapshots()).resolves.toBe(1);
      expect(store.get("/p/watched.txt")?.content).toBe("w");
      expect(store.get("/p/closed.txt")).toBeUndefined();
    } finally {
      jest.restoreAllMocks();
      svc.close();
    }
  });
});

describe("SyncFsService snapshot retention across processes", () => {
  it("keeps the snapshot of a path another service is watching", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-fs-svc-shared-"));
    const file = join(dir, "sync-fs-snapshots.sqlite");
    const watched = join(dir, "watched.txt");
    writeFileSync(watched, "w");
    const opts = { snapshotTtlMs: 60_000, snapshotPruneIntervalMs: 3_600_000 };
    const main = new SyncFsService(new SyncFsWatchStore(file), opts);
    const worker = new SyncFsService(new SyncFsWatchStore(file), opts);
    const store = new SyncFsWatchStore(file);
    try {
      await main.heartbeat(watched, true);
      store.setContent(watched, "w");
      store.setContent(join(dir, "closed.txt"), "c");
      const now = Date.now();
      jest.spyOn(Date, "now").mockReturnValue(now + 61_000);
      // The worker watches nothing itself, but must leave main's path alone.
      await expect(worker.pruneSnapshots()).resolves.toBe(1);
      expect(store.get(watched)?.content).toBe("w");
      await main.heartbeat(watched, false);
      await expect(worker.pruneSnapshots()).resolves.toBe(1);
      expect(store.get(watched)).toBeUndefined();
    } finally {
      jest.restoreAllMocks();
      main.close();
      worker.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SyncFsService snapshot retention during a diff", () => {
  it("keeps the snapshot of a path released while its diff runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-fs-svc-busy-"));
    const file = join(dir, "sync-fs-snapshots.sqlite");
    const watched = join(dir, "watched.txt");
    writeFileSync(watched, "v1");
    const opts = { snapshotTtlMs: 60_000, snapshotPruneIntervalMs: 3_600_000 };
    const main = new SyncFsService(new SyncFsWatchStore(file), opts);
    const worker = new SyncFsService(new SyncFsWatchStore(file), opts);
    const store = new SyncFsWatchStore(file);
    try {
      await main.heartbeat(watched, true);
      store.setContent(watched, "v1");
      let finishRead!: (content: string) => void;
      const diff = (main as any).externalChange(
        watched,
        () => new Promise<string>((resolve) => (finishRead = resolve)),
      );
      await main.heartbeat(watched, false);
      const now = Date.now();
      jest.spyOn(Date, "now").mockReturnValue(now + 61_000);
      await expect(main.pruneSnapshots()).resolves.toBe(0);
      await expect(worker.pruneSnapshots()).resolves.toBe(0);
      finishRead("v2");
      const change = await diff;
      // diffed against the kept baseline, not an empty one
      expect(change.patch).toBeDefined();
      expect(store.get(watched)?.content).toBe("v2");
      jest.spyOn(Date, "now").mockReturnValue(now + 122_000);
      await expect(worker.pruneSnapshots()).resolves.toBe(1);
    } finally {
      jest.restoreAllMocks();
      main.close();
      worker.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SyncFsService snapshot retention during initialization", () => {
  it("keeps the rebuilt baseline while init reads the disk, even after release", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-fs-svc-init-"));
    const file = join(dir, "sync-fs-snapshots.sqlite");
    const watched = join(dir, "watched.txt");
    writeFileSync(watched, "on disk");
    const opts = { snapshotTtlMs: 60_000, snapshotPruneIntervalMs: 3_600_000 };
    const main = new SyncFsService(new SyncFsWatchStore(file), opts);
    const worker = new SyncFsService(new SyncFsWatchStore(file), opts);
    const store = new SyncFsWatchStore(file);
    try {
      // initPath: the stream has history, rebuilt as "stream-value"
      (main as any).getStreamHeads = async () => ({
        heads: ["h"],
        maxVersion: 1,
        maxTimeMs: 1,
      });
      (main as any).loadDocViaSyncDoc = async () => "stream-value";
      (main as any).shouldReconcileDiskOnInit = async () => true;
      let finishRead!: () => void;
      const readPaused = new Promise<void>((resolve) => (finishRead = resolve));
      let readStarted!: () => void;
      const started = new Promise<void>((resolve) => (readStarted = resolve));
      const appended: any[] = [];
      (main as any).appendPatch = async (
        _meta: any,
        _type: any,
        change: any,
      ) => {
        appended.push(change);
        return true;
      };
      const safeRead = require("./safe-read");
      const realRead = safeRead.readWatchedFileUtf8;
      jest
        .spyOn(safeRead, "readWatchedFileUtf8")
        .mockImplementation(async (...args: any[]) => {
          readStarted();
          await readPaused;
          return await realRead(...args);
        });
      const init = (main as any).initPathOnce(watched, {
        project_id: "00000000-0000-4000-8000-000000000000",
        syncPath: "watched.txt",
      });
      await started;
      expect(store.get(watched)?.content).toBe("stream-value");
      // released while the read is paused; much later, another process prunes
      (main as any).releasePath(watched, "inactive");
      const now = Date.now();
      jest.spyOn(Date, "now").mockReturnValue(now + 61_000);
      await expect(worker.pruneSnapshots()).resolves.toBe(0);
      finishRead();
      await expect(init).resolves.toBe(true);
      // the diff was against the rebuilt baseline, not an empty one
      expect(appended).toHaveLength(1);
      expect(appended[0].content).toBe("on disk");
      expect(store.get(watched)?.content).toBe("on disk");
      jest.spyOn(Date, "now").mockReturnValue(now + 122_000);
      await expect(worker.pruneSnapshots()).resolves.toBe(1);
    } finally {
      jest.restoreAllMocks();
      main.close();
      worker.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
