/*
An ephemeral stream lives only in the persist server's memory, so after the
server restarts it is empty and numbers messages from 1 again.  Clients used
to resume from their old last seq and silently dropped every new message
whose seq was not above it (e.g., Jupyter runtime state froze after a project
host restart).  Now the server sends an instance id with each read; a client
that sees a new one drops its old state and starts over.

pnpm test ./ephemeral-stream-persist-restart.test.ts
*/

import {
  before,
  after,
  connect,
  persistServer as initialPersistServer,
  restartServer,
  wait,
} from "@cocalc/backend/conat/test/setup";
import { server as createPersistServer } from "@cocalc/backend/conat/persist";
import { CoreStream, cstream } from "@cocalc/conat/sync/core-stream";
import { dkv } from "@cocalc/conat/sync/dkv";
import { once } from "@cocalc/util/async-utils";

beforeAll(before);

describe("an ephemeral stream across a persist server restart", () => {
  const name = `ephemeral-restart-${Math.random()}`;
  let writer;
  let reader;
  let kvWriter;
  let kvReader;
  let persistServer;
  let oldInstance;
  const readerChanges: any[] = [];
  const kvReaderChanges: any[] = [];

  it("opens an ephemeral stream and kv on two connections", async () => {
    writer = await cstream({
      client: connect(),
      name,
      ephemeral: true,
      noCache: true,
    });
    reader = await cstream({
      client: connect(),
      name,
      ephemeral: true,
      noCache: true,
    });
    for (const mesg of ["a", "b", "c"]) {
      await writer.publish(mesg);
    }
    await wait({ until: () => reader.getAll().length == 3 });
    oldInstance = reader.getPersistInstance();
    expect(typeof oldInstance).toBe("string");
    reader.on("change", ({ mesg, prev }) => readerChanges.push({ mesg, prev }));

    kvWriter = await dkv({
      client: connect(),
      name: `${name}-kv`,
      ephemeral: true,
      noCache: true,
    });
    kvReader = await dkv({
      client: connect(),
      name: `${name}-kv`,
      ephemeral: true,
      noCache: true,
    });
    kvWriter.set("old", 1);
    await kvWriter.save();
    await wait({ until: () => kvReader.get("old") == 1 });
    kvReader.on("change", (x) => kvReaderChanges.push(x));
  }, 30_000);

  it("restarts the router and the persist server", async () => {
    const disconnected = once(writer.persistClient, "disconnected", 15_000);
    await restartServer();
    await disconnected;
    await initialPersistServer.close();
    persistServer = createPersistServer({ client: connect() });
  }, 30_000);

  it("delivers new messages and drops the ones the server lost", async () => {
    await wait({
      timeout: 20_000,
      until: async () => {
        try {
          await writer.publish("after", { timeout: 1000 });
          return true;
        } catch {
          return false;
        }
      },
    });
    await wait({
      timeout: 20_000,
      until: () => reader.getAll().includes("after"),
    });
    // "after" may have been published more than once while reconnecting
    expect(new Set(reader.getAll())).toEqual(new Set(["after"]));
    expect(new Set(writer.getAll())).toEqual(new Set(["after"]));
    // the reader saw the old messages go away
    expect(
      readerChanges
        .filter(({ mesg }) => mesg === undefined)
        .map(({ prev }) => prev)
        .sort(),
    ).toEqual(["a", "b", "c"]);
  }, 45_000);

  it("a kv drops lost keys and sees new ones", async () => {
    await wait({
      timeout: 20_000,
      until: async () => {
        try {
          kvWriter.set("new", 2);
          await kvWriter.save();
          return true;
        } catch {
          return false;
        }
      },
    });
    await wait({ timeout: 20_000, until: () => kvReader.get("new") == 2 });
    expect(kvReader.get("old")).toBeUndefined();
    expect(kvReaderChanges.some((x) => x.key == "old")).toBe(true);
  }, 45_000);

  it("reapplies the stream's configuration to the new instance", async () => {
    // dkv asks for allow_msg_ttl (for tombstones); a new ephemeral instance
    // starts with defaults
    expect((await kvWriter.config()).allow_msg_ttl).toBe(true);
    expect((await kvReader.config()).allow_msg_ttl).toBe(true);
  });

  it("a stream that opens later on the shared client, from a cached cursor of the old instance, reads the new one from the start", async () => {
    expect(writer.getPersistInstance()).not.toBe(oldInstance);
    const late = new CoreStream({
      client: writer.client,
      name,
      ephemeral: true,
      start_seq: 2,
      start_instance: oldInstance,
    });
    await late.init();
    expect(late.persistClient).toBe(writer.persistClient);
    expect(new Set(late.getAll())).toEqual(new Set(["after"]));
    late.close();
  });

  it("so does one whose cursor is past the new instance's newest message", async () => {
    const late = new CoreStream({
      client: writer.client,
      name,
      ephemeral: true,
      start_seq: 1000,
    });
    await late.init();
    expect(new Set(late.getAll())).toEqual(new Set(["after"]));
    late.close();
  });

  it("cleans up", async () => {
    writer?.close();
    reader?.close();
    kvWriter?.close();
    kvReader?.close();
    await persistServer?.close();
  });
});

afterAll(after);
