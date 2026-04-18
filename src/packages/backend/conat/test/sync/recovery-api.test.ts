import { cstream } from "@cocalc/conat/sync/core-stream";
import { dkv, dstream } from "@cocalc/backend/conat/sync";
import {
  before,
  after,
  connect,
  restartServer,
  restartPersistServer,
  setDefaultTimeouts,
  wait,
} from "@cocalc/backend/conat/test/setup";

beforeAll(async () => {
  await before();
  setDefaultTimeouts({ request: 1000, publish: 1000 });
});
jest.setTimeout(30_000);

describe("coordinated recovery api", () => {
  it("core-stream can pause and later resume recovery without replacing the object", async () => {
    const client = connect();
    const stream = await cstream({
      client,
      name: `recovery-api-core-${Math.random()}`,
      noCache: true,
    });
    const events: string[] = [];
    stream.on("disconnected", () => events.push("disconnected"));
    stream.on("recovering", () => events.push("recovering"));
    stream.on("paused", () => events.push("paused"));
    stream.on("recovered", () => events.push("recovered"));

    expect(stream.getRecoveryState()).toBe("ready");

    stream.pauseRecovery("test");
    expect(stream.getRecoveryState()).toBe("paused");

    await restartServer();

    await wait({
      timeout: 15_000,
      until: () =>
        events.includes("disconnected") &&
        stream.getRecoveryState() === "paused",
    });

    await stream.resumeRecovery();

    await wait({
      timeout: 15_000,
      until: async () => {
        if (stream.getRecoveryState() !== "ready") {
          return false;
        }
        try {
          await stream.publish("after-resume", { timeout: 500 });
          return true;
        } catch {
          return false;
        }
      },
    });

    await wait({
      timeout: 5_000,
      until: () => stream.getAll().includes("after-resume"),
    });

    expect(events).toContain("paused");
    expect(events).toContain("recovered");

    stream.close();
    client.close();
  });

  it("dstream forwards recovery lifecycle without replacing the object", async () => {
    const stream = await dstream({
      name: `recovery-api-dstream-${Math.random()}`,
    });
    const events: string[] = [];
    stream.on("disconnected", () => events.push("disconnected"));
    stream.on("recovering", () => events.push("recovering"));
    stream.on("recovered", () => events.push("recovered"));

    expect(stream.getRecoveryState()).toBe("ready");

    stream.publish("before-restart");
    await stream.save();
    await wait({
      timeout: 5_000,
      until: () => stream.getAll().includes("before-restart"),
    });

    await restartServer();

    await wait({
      timeout: 15_000,
      until: async () => {
        try {
          stream.publish("after-restart");
          await stream.save();
          return stream.getRecoveryState() === "ready";
        } catch {
          return false;
        }
      },
    });

    await wait({
      timeout: 5_000,
      until: () => stream.getAll().includes("after-restart"),
    });

    expect(events).toContain("disconnected");
    expect(events).toContain("recovered");

    stream.close();
  });

  it("dkv forwards recovery lifecycle without replacing the object", async () => {
    const kv = await dkv({
      name: `recovery-api-dkv-${Math.random()}`,
    });
    const events: string[] = [];
    kv.on("disconnected", () => events.push("disconnected"));
    kv.on("recovering", () => events.push("recovering"));
    kv.on("recovered", () => events.push("recovered"));

    expect(kv.getRecoveryState()).toBe("ready");

    kv.a = 1;
    await kv.save();

    await restartPersistServer();

    await wait({
      timeout: 15_000,
      until: async () => {
        try {
          kv.b = 2;
          await kv.save();
          return kv.getRecoveryState() === "ready";
        } catch {
          return false;
        }
      },
    });

    expect(kv.a).toBe(1);
    expect(kv.b).toBe(2);
    expect(events).toContain("disconnected");
    expect(events).toContain("recovered");

    kv.close();
  });
});

afterAll(after);
