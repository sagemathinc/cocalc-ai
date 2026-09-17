import { randomUUID } from "node:crypto";
import { Client, connect, encode } from "./client";
import { ConatServer, init } from "./server";
import { DataEncoding } from "./codec";

// Real loopback transport; authentication is deliberately not under test here.
describe("bounded receive over the Conat broker", () => {
  afterEach(async () => {
    Client.closeAllForTests();
    await ConatServer.closeAllForTests();
  });

  async function fixture() {
    const server = init({ port: 0 });
    const receiver = connect({ address: server.address(), noCache: true });
    await receiver.waitUntilSignedIn({ timeout: 5000 });
    const subject = `bounded.${randomUUID()}`;
    const subscription = await receiver.subscribe(subject, {
      receiveLimits: {
        maxMessageBytes: 16 * 1024,
        maxInflightBytes: 16 * 1024,
        maxInflightMessages: 2,
        maxFragmentsPerMessage: 4,
      },
      maxQueue: 2,
    });
    const barrierSubject = `barrier.${randomUUID()}`;
    const barrier = await receiver.subscribe(barrierSubject);
    const publishers: Client[] = [];
    for (let i = 0; i < 4; i++) {
      const publisher = connect({ address: server.address(), noCache: true });
      await publisher.waitUntilSignedIn({ timeout: 5000 });
      publishers.push(publisher);
    }
    const flush = async () => {
      await publishers[0].publish(barrierSubject, "processed");
      expect((await barrier.next()).value?.data).toBe("processed");
    };
    const chunk = async (
      sender: number,
      id: string,
      seq: number,
      done: number,
      data: Buffer,
    ) => {
      const response = await publishers[sender].conn
        .timeout(5000)
        .emitWithAck("publish", [
          subject,
          id,
          seq,
          done,
          DataEncoding.MsgPack,
          data,
        ]);
      expect(response?.error).toBeUndefined();
    };
    // White-box retained-fragment measurements, after a network delivery barrier.
    const retained = () => {
      const incoming = (receiver as any).subs[subject].incoming;
      return {
        messages: Object.keys(incoming).length,
        bytes: Object.values(incoming).reduce<number>(
          (total, chunks: any) =>
            total +
            chunks.reduce((sum, chunk) => sum + chunk.buffer.byteLength, 0),
          0,
        ),
      };
    };
    return { subscription, chunk, flush, retained, publishers, subject };
  }

  test("malformed non-binary fragments cannot reach the bounded consumer", async () => {
    const f = await fixture();
    for (const body of ["text", { length: 1 }, [1], null]) {
      await f.chunk(0, "bad", 0, 0, Buffer.alloc(1024));
      await f.chunk(0, "bad", 1, 1, body as any);
      await f.flush();
      expect(f.retained()).toEqual({ messages: 0, bytes: 0 });
      expect(f.subscription.queueSize()).toBe(0);
    }
    await f.publishers[0].publish(f.subject, "healthy");
    expect((await f.subscription.next()).value?.data).toBe("healthy");
  });

  test("separate publishers share the incomplete-message budget and recover after overflow", async () => {
    const f = await fixture();
    await f.chunk(0, "a", 0, 0, Buffer.alloc(8192));
    await f.chunk(1, "b", 0, 0, Buffer.alloc(8192));
    for (let i = 0; i < 20; i++)
      await f.chunk(2 + (i % 2), `overflow-${i}`, 0, 0, Buffer.alloc(8192));
    await f.flush();
    expect(f.retained()).toEqual({ messages: 2, bytes: 16384 });
    expect(f.subscription.queueSize()).toBe(0);
    // Continuations exceeding the byte cap discard the entire incomplete message.
    await f.chunk(0, "a", 1, 1, Buffer.alloc(16384));
    await f.chunk(1, "b", 1, 1, Buffer.alloc(16384));
    await f.flush();
    expect(f.retained()).toEqual({ messages: 0, bytes: 0 });
    await f.publishers[3].publish(f.subject, "healthy");
    expect((await f.subscription.next()).value?.data).toBe("healthy");
  });

  test("zero-byte fragment floods and stalled consumers remain bounded", async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++)
      await f.chunk(i % 4, "empty", i, 0, Buffer.alloc(0));
    await f.flush();
    expect(f.retained()).toEqual({ messages: 0, bytes: 0 });
    const bytes = Buffer.from(
      encode({ encoding: DataEncoding.MsgPack, mesg: "queued" }),
    );
    for (let i = 0; i < 20; i++)
      await f.chunk(i % 4, `complete-${i}`, 0, 1, bytes);
    await f.flush();
    expect(f.subscription.queueSize()).toBe(2);
    expect(f.retained()).toEqual({ messages: 0, bytes: 0 });
    for (let i = 0; i < 2; i++)
      expect((await f.subscription.next()).value?.data).toBe("queued");
    await f.publishers[0].publish(f.subject, "healthy");
    expect((await f.subscription.next()).value?.data).toBe("healthy");
  });

  test("malformed MsgPack does not leave fragments or prevent the next message", async () => {
    const f = await fixture();
    // Reserved MsgPack byte: transport can carry it, but decoding must reject it.
    await f.chunk(0, "malformed", 0, 1, Buffer.from([0xc1]));
    const malformed = (await f.subscription.next()).value;
    expect(() => malformed?.data).toThrow();
    expect(f.retained()).toEqual({ messages: 0, bytes: 0 });
    await f.publishers[1].publish(f.subject, "healthy");
    expect((await f.subscription.next()).value?.data).toBe("healthy");
  });
});
