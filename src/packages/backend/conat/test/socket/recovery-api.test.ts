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
  setDefaultTimeouts({ request: 500, publish: 500 });
});

jest.setTimeout(30_000);

describe("socket coordinated recovery api", () => {
  it("socket emits recovery lifecycle and remains usable after restart", async () => {
    const subject = `socket-recovery-${Math.random()}`;
    const cn1 = connect();
    const server = cn1.socket.listen(subject);
    server.on("connection", (socket) => {
      socket.on("data", (data) => {
        socket.write(`echo:${data}`);
      });
    });

    const cn2 = connect();
    const client = cn2.socket.connect(subject);
    const events: string[] = [];
    client.on("recovering", () => events.push("recovering"));
    client.on("recovered", () => events.push("recovered"));

    await client.waitUntilReady(5_000);
    expect(client.getRecoveryState()).toBe("ready");

    const iter = client.iter();
    client.write("before");
    expect((await iter.next()).value[0]).toBe("echo:before");

    await restartServer();

    await wait({
      timeout: 15_000,
      until: async () => {
        try {
          await client.waitUntilReady(500);
          return client.getRecoveryState() === "ready";
        } catch {
          return false;
        }
      },
    });

    const iter2 = client.iter();
    client.write("after");
    expect((await iter2.next()).value[0]).toBe("echo:after");
    expect(events).toContain("recovering");
    expect(events).toContain("recovered");

    cn1.close();
    cn2.close();
  });

  it("socket can pause recovery and later resume it", async () => {
    const subject = `socket-recovery-pause-${Math.random()}`;
    const cn1 = connect();
    const server = cn1.socket.listen(subject);
    server.on("connection", (socket) => {
      socket.on("data", (data) => {
        socket.write(`echo:${data}`);
      });
    });

    const cn2 = connect();
    const client = cn2.socket.connect(subject);
    await client.waitUntilReady(5_000);

    client.pauseRecovery("test");
    expect(client.getRecoveryState()).toBe("paused");

    await restartServer();

    await wait({
      timeout: 15_000,
      until: () =>
        client.state === "disconnected" &&
        client.getRecoveryState() === "paused",
    });

    await client.resumeRecovery();
    await client.waitUntilReady(15_000);
    expect(client.getRecoveryState()).toBe("ready");

    const iter = client.iter();
    client.write("resumed");
    expect((await iter.next()).value[0]).toBe("echo:resumed");

    cn1.close();
    cn2.close();
  });
});

afterAll(after);
