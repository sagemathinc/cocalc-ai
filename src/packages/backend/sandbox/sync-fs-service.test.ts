import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "events";
import { SyncFsService } from "./sync-fs-service";
import { tmpNameSync } from "tmp-promise";
import { SyncFsWatchStore } from "./sync-fs-watch";
import { DiffMatchPatch, decompressPatch } from "@cocalc/util/dmp";
import { decodePatchId, legacyPatchId } from "patchflow";

class FakeAStream {
  public messages: { mesg: any; seq: number }[] = [];
  public lastStartSeq?: number;
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
    // no-op
  }
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

  it("emits delete then rebuilds patches from empty base on recreate", async () => {
    const path = join(dir, "recreate.txt");
    writeFileSync(path, "first");

    const svc = new SyncFsService();
    const fake = new FakeAStream();
    (svc as any).getPatchWriter = async () => fake;
    await svc.heartbeat(path, true, {
      project_id: "p1",
      relativePath: "recreate.txt",
      string_id: "sid-recreate",
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

  it("reuses persisted heads/lastSeq and resumes with start_seq", async () => {
    const dbPath = tmpNameSync({ prefix: "sync-fs-heads-", postfix: ".db" });
    const store1 = new SyncFsWatchStore(dbPath);
    const svc1 = new SyncFsService(store1);
    const fake = new FakeAStream();

    // Monkeypatch writer factory for testing.
    (svc1 as any).getPatchWriter = async () => fake;

    const meta = { project_id: "p1", relativePath: "a.txt", string_id: "sid" };
    const change = { patch: [], content: "v1", hash: "h1", deleted: false };
    await (svc1 as any).appendPatch(meta, "change", change);
    const head1 = store1.getFsHead("sid");
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
    const head2 = store2.getFsHead("sid");
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
      string_id: "sid2",
      time: legacyPatchId(50),
      version: 1,
      heads: [],
      lastSeq: 5,
    });

    const fake = new FakeAStream([
      { mesg: { time: 50, parents: [], version: 1 }, seq: 1 },
    ]);
    const svc = new SyncFsService(store);
    (svc as any).getPatchWriter = async () => fake;

    const meta = { project_id: "p2", relativePath: "c.txt", string_id: "sid2" };
    const change = { patch: [], content: "v3", hash: "h3", deleted: false };
    await (svc as any).appendPatch(meta, "change", change);

    expect(fake.lastStartSeq).toBeUndefined();
    const published = fake.messages[fake.messages.length - 1].mesg;
    expect(Array.isArray(published.parents)).toBe(true);
    expect(published.parents.length).toBe(1);
    expect(decodePatchId(published.parents[0]).timeMs).toBe(50);

    const head = store.getFsHead("sid2");
    expect(head?.heads).toEqual([published.time]);
    expect(head?.lastSeq).toBe(fake.messages.length);
    svc.close();
  }, 10_000);

  it("resets stale persisted heads if stream was deleted", async () => {
    const dbPath = tmpNameSync({ prefix: "sync-fs-heads-", postfix: ".db" });
    const store = new SyncFsWatchStore(dbPath);
    store.setFsHead({
      string_id: "sid3",
      time: legacyPatchId(123),
      version: 7,
      heads: [legacyPatchId(123)],
      lastSeq: 42,
    });

    // Simulate persist reset: stream has no historical messages.
    const fake = new FakeAStream([]);
    const svc = new SyncFsService(store);
    (svc as any).getPatchWriter = async () => fake;

    const meta = { project_id: "p3", relativePath: "d.txt", string_id: "sid3" };
    const change = { patch: [], content: "fresh", hash: "h4", deleted: false };
    await (svc as any).appendPatch(meta, "change", change);

    const published = fake.messages[fake.messages.length - 1].mesg;
    expect(Array.isArray(published.parents)).toBe(true);
    expect(published.parents.length).toBe(0);
    expect(published.version).toBe(1);

    const head = store.getFsHead("sid3");
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
      relativePath: "cached.txt",
      string_id: "sid-cached",
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
      relativePath: "history.txt",
      string_id: "sid-history",
    });

    // No extra publish is needed because disk content already matches stream.
    expect(fake.messages.length).toBe(1);
    expect((svc as any).store.get(path)?.content).toBe("stream-value");
    svc.close();
  }, 10_000);
});
