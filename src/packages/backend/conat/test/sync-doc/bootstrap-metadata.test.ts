import { before, after, connect, uuid, server, once } from "./setup";

beforeAll(before);
afterAll(after);
jest.setTimeout(15_000);

it("reopens a document without reducing its historical editor map or dropping its snapshot", async () => {
  const project_id = uuid();
  const client = connect();
  const reopenedClient = connect();
  const path = "historical-editors.txt";
  const content = "document with many historical editors\n".repeat(20);
  let doc: any;
  let reopened: any;
  try {
    doc = client.sync.string({ project_id, path, service: server.service });
    await once(doc, "ready");
    doc.from_str(content + "draft");
    doc.commit();
    await doc.save();
    doc.from_str(content);
    doc.commit();
    await doc.save();
    await doc.snapshot(doc.versions().at(-1));
    const patches = doc.patches_table.dstream;
    const original = patches.getMetadata();
    const users = [
      ...original.users,
      ...Array.from({ length: 112 }, (_, i) => `historical-editor-${i}`),
    ];
    await patches.setMetadata({ ...original, users });
    const { latest_snapshot: checkpoint } =
      await patches.stream.persistClient.getCheckpoints();
    expect(checkpoint).toBeDefined();
    // SyncDoc may refresh the checkpoint timestamp while persisting metadata;
    // its sequence and patch identity must survive unchanged.
    const snapshot = { seq: checkpoint.seq, data: checkpoint.data };
    await doc.close();

    reopened = reopenedClient.sync.string({
      project_id,
      path,
      service: server.service,
    });
    await once(reopened, "ready");
    expect(reopened.to_str()).toBe(content);
    const restored = reopened.patches_table.dstream;
    // A new client may append its identity, but existing patch user indices
    // and the checkpoint must remain intact, both in memory and on disk.
    expect(restored.getMetadata().users.slice(0, users.length)).toEqual(users);
    expect(restored.getCheckpoint("latest_snapshot")).toMatchObject(snapshot);
    const persisted = restored.stream.persistClient;
    expect(
      (await persisted.getMetadata()).users.slice(0, users.length),
    ).toEqual(users);
    expect((await persisted.getCheckpoints()).latest_snapshot).toMatchObject(
      snapshot,
    );
  } finally {
    await reopened?.close();
    await doc?.close();
    client.close();
    reopenedClient.close();
  }
});
