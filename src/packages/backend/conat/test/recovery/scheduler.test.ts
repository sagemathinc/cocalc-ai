import { delay } from "awaiting";
import { RecoveryScheduler } from "@cocalc/conat/recovery/scheduler";
import {
  before,
  after,
  connect,
  restartServer,
  setDefaultTimeouts,
  wait,
} from "@cocalc/backend/conat/test/setup";

beforeAll(async () => {
  await before();
  setDefaultTimeouts({ request: 1000, publish: 1000 });
});

jest.setTimeout(30_000);

describe("process-level recovery scheduler", () => {
  it("uses adaptive parallel recovery by default", async () => {
    const scheduler = new RecoveryScheduler({
      canRun: () => true,
      isTransportReady: () => true,
    });
    let inFlight = 0;
    let maxInFlight = 0;
    let completed = 0;
    const resources = Array.from({ length: 12 }, () =>
      scheduler.registerResource({
        recover: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await delay(25);
          completed += 1;
          inFlight -= 1;
        },
      }),
    );
    try {
      for (const resource of resources) {
        resource.requestRecovery({ resetBackoff: true });
      }
      await wait({
        timeout: 5_000,
        until: () => completed === resources.length,
      });
      expect(maxInFlight).toBeGreaterThan(1);
    } finally {
      for (const resource of resources) {
        resource.close();
      }
      scheduler.close();
    }
  });

  it("serializes socket recovery across many sockets on one client", async () => {
    const subject = `recovery-scheduler-socket-${Math.random()}`;
    const cn1 = connect();
    const server = cn1.socket.listen(subject);
    server.on("connection", (socket) => {
      socket.on("data", (data) => {
        socket.write(data);
      });
    });
    const cn2 = connect({ recoveryConcurrency: 1 });
    const sockets = Array.from({ length: 5 }, () =>
      cn2.socket.connect(subject),
    );
    await wait({
      timeout: 10_000,
      until: () => sockets.every((socket) => socket.state === "ready"),
    });

    let inFlight = 0;
    let maxInFlight = 0;
    for (const socket of sockets) {
      const recoverNow0 = socket.recoverNow.bind(socket);
      socket.recoverNow = async (opts) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(40);
        try {
          await recoverNow0(opts);
        } finally {
          inFlight -= 1;
        }
      };
    }

    await restartServer();

    await wait({
      timeout: 20_000,
      until: () => sockets.every((socket) => socket.state === "ready"),
    });

    const iter = sockets[0].iter();
    sockets[0].write("after-recovery");
    const { value } = await iter.next();
    expect(value[0]).toBe("after-recovery");
    expect(maxInFlight).toBe(1);

    for (const socket of sockets) {
      socket.close();
    }
    cn2.close();
    cn1.close();
  });

  it("serializes core-stream recovery across many streams on one client", async () => {
    const client = connect({ recoveryConcurrency: 1 });
    const streams = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        client.sync.dstream({
          name: `recovery-scheduler-dstream-${Math.random()}-${i}`,
        }),
      ),
    );
    for (const [i, stream] of streams.entries()) {
      stream.publish(`before-${i}`);
      await stream.save();
    }
    await wait({
      timeout: 10_000,
      until: () =>
        streams.every((stream, i) => stream.getAll().includes(`before-${i}`)),
    });

    let inFlight = 0;
    let maxInFlight = 0;
    for (const stream of streams) {
      const coreStream = (stream as any).stream;
      const recoverNow0 = coreStream.recoverNow.bind(coreStream);
      coreStream.recoverNow = async (opts) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(40);
        try {
          await recoverNow0(opts);
        } finally {
          inFlight -= 1;
        }
      };
    }

    await restartServer();

    await wait({
      timeout: 20_000,
      until: () =>
        streams.every((stream) => stream.getRecoveryState() === "ready"),
    });

    for (const [i, stream] of streams.entries()) {
      stream.publish(`after-${i}`);
      await stream.save();
    }
    await wait({
      timeout: 10_000,
      until: () =>
        streams.every((stream, i) => stream.getAll().includes(`after-${i}`)),
    });

    expect(maxInFlight).toBe(1);

    for (const stream of streams) {
      stream.close();
    }
    client.close();
  });
});

afterAll(after);
