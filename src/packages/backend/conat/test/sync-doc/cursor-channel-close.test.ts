/*
A document with cursors opens one cursor channel and closes it with the
document. The channel's subscription is shared by every document on that path
in the process, so a channel left open kept each closed document, with its
whole patch history, alive for the life of the process.
*/

import { before, after, uuid, connect, server, once } from "./setup";
import { SyncClient } from "@cocalc/conat/sync-doc/sync-client";

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

  it("stops listening to the connection when a SyncClient is closed directly", () => {
    const before = client.listenerCount("closed");
    for (let i = 0; i < 3; i++) {
      new SyncClient(client).close();
    }
    expect(client.listenerCount("closed")).toBe(before);
  });

  it("reports a denied cursor subscription as a failed open", async () => {
    const original = client.subscribe;
    const subscribe = jest
      .spyOn(client, "subscribe")
      .mockImplementation(async (subject: string, opts?: any) => {
        if (subject.includes("pubsub-cursors")) {
          throw new Error("permission denied");
        }
        return await original(subject, opts);
      });
    try {
      await expect(
        new SyncClient(client).pubsub_conat({
          project_id,
          path,
          name: "cursors",
        }),
      ).rejects.toThrow("permission denied");
      const doc = open();
      await once(doc, "ready");
      expect((doc as any).patchflowSession?.presenceAdapter).toBeUndefined();
      expect(cursorSubscriptions(client)).toEqual([]);
      await doc.close();
    } finally {
      subscribe.mockRestore();
    }
  });
});
