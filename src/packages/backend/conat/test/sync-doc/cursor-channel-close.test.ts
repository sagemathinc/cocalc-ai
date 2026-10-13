/*
A document with cursors opens one cursor channel and closes it with the
document. The channel's subscription is shared by every document on that path
in the process, so a channel left open kept each closed document, with its
whole patch history, alive for the life of the process.
*/

import { before, after, uuid, connect, server, once } from "./setup";

beforeAll(before);
afterAll(after);

function cursorSubscriptions(client) {
  return Object.entries((client as any).subs ?? {}).filter(([subject]) =>
    subject.includes("pubsub-cursors"),
  ) as [string, any][];
}

describe("cursor channel lifetime", () => {
  const project_id = uuid();
  const path = "cursors.syncdb";
  let client;

  function open() {
    return client.sync.db({
      project_id,
      path,
      service: server.service,
      primary_keys: ["id"],
      cursors: true,
      firstReadLockTimeout: 1,
    });
  }

  it("opens one cursor channel per document", async () => {
    client = connect();
    const doc = open();
    await once(doc, "ready");
    const subs = cursorSubscriptions(client);
    expect(subs.length).toBe(1);
    expect(subs[0][1].refCount).toBe(1);
    await doc.close();
    expect(cursorSubscriptions(client)).toEqual([]);
  });

  it("releases the channel of every closed document", async () => {
    const kept = open();
    await once(kept, "ready");
    for (let i = 0; i < 4; i++) {
      const doc = open();
      await once(doc, "ready");
      doc.set({ id: i, value: `v${i}` });
      doc.commit();
      await doc.save();
      await doc.close();
    }
    const subs = cursorSubscriptions(client);
    expect(subs.length).toBe(1);
    expect(subs[0][1].refCount).toBe(1);
    await kept.close();
    expect(cursorSubscriptions(client)).toEqual([]);
  });

  it("stops listening to the connection when a document closes", async () => {
    const before = client.listenerCount("closed");
    for (let i = 0; i < 3; i++) {
      const doc = open();
      await once(doc, "ready");
      await doc.close();
    }
    expect(client.listenerCount("closed")).toBe(before);
  });
});
