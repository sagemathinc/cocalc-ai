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
    const { project_id, path, s1, last, missing } = await setup((s1) =>
      decodePatchId(s1.versions().at(-1)).clientId,
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
});
