/*
A dstream catch-up fetches missed updates over the existing connection: it
must not re-subscribe or report recovery, since callers run it every few
seconds while a stream is quiet.
*/

import {
  before,
  after,
  connect,
  delay,
  wait,
} from "@cocalc/backend/conat/test/setup";

beforeAll(before);

describe("dstream catchUp", () => {
  let writer, reader, a, b;
  const name = "catch-up-stream";

  it("opens a writer and a reader", async () => {
    writer = connect();
    reader = connect();
    a = await writer.sync.dstream({ name, noCache: true });
    b = await reader.sync.dstream({ name, noCache: true });
    a.publish("one");
    await a.save();
    await wait({ until: () => b.length == 1 });
  });

  it("is quiet: no recovery events and the stream stays ready", async () => {
    const events: string[] = [];
    for (const event of ["recovering", "disconnected", "paused", "recovered"])
      b.on(event, () => events.push(event));
    for (let i = 0; i < 5; i++) await b.catchUp();
    expect(events).toEqual([]);
    expect(b.getRecoveryState()).toBe("ready");
    expect(b.getAll()).toEqual(["one"]);
  });

  it("keeps live delivery working, without duplicates", async () => {
    const catching = b.catchUp();
    a.publish("two");
    await a.save();
    await catching;
    await wait({ until: () => b.length == 2 });
    await b.catchUp();
    await delay(50);
    expect(b.getAll()).toEqual(["one", "two"]);
  });

  it("does nothing on a closed stream", async () => {
    b.close();
    await expect(b.catchUp()).resolves.toBeUndefined();
    a.close();
  });
});

afterAll(async () => {
  await delay(100);
  await after();
});
