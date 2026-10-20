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
import { dstream } from "@cocalc/conat/sync/dstream";
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
  let dsReader;
  const dsEvents: string[] = [];
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
    dsReader = await dstream({
      client: connect(),
      name,
      ephemeral: true,
      noCache: true,
    });
    await wait({ until: () => dsReader.length == 3 });
    dsReader.on("instance-reset", () => dsEvents.push("instance-reset"));
    dsReader.on("change", (mesg) => dsEvents.push(mesg));

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
    // The first attempt to apply the configuration to the new instance fails
    // on every kv client, as on a connection that is still settling.
    for (const kv of [kvWriter, kvReader]) {
      const persistClient = (kv as any).kv.persistClient;
      const config = persistClient.config;
      let failed = false;
      persistClient.config = async (opts) => {
        if (!failed) {
          failed = true;
          throw new Error("transient failure");
        }
        return await config(opts);
      };
    }
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
    // a DStream tells its users to forget seqs before any new message
    await wait({ until: () => dsEvents.includes("after") });
    expect(dsEvents.indexOf("instance-reset")).toBeGreaterThan(-1);
    expect(dsEvents.indexOf("instance-reset")).toBeLessThan(
      dsEvents.indexOf("after"),
    );
    expect(new Set(dsReader.getAll())).toEqual(new Set(["after"]));
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

  it("reapplies the stream's configuration to the new instance, despite a failed first attempt", async () => {
    // dkv asks for allow_msg_ttl (for tombstones); a new ephemeral instance
    // starts with defaults.  Read the server's config without asking for any
    // (config() with no options would not prove it was reapplied).
    for (const kv of [kvWriter, kvReader]) {
      const stream = (kv as any).kv;
      await wait({
        timeout: 20_000,
        until: async () =>
          (await stream.persistClient.config({ config: {} })).allow_msg_ttl ===
          true,
      });
    }
  }, 30_000);

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
    dsReader?.close();
    kvWriter?.close();
    kvReader?.close();
    await persistServer?.close();
  });
});

afterAll(after);
