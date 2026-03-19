import { before, after, connect } from "@cocalc/backend/conat/test/setup";
import { stream } from "@cocalc/conat/persist/client";
import {
  getPersistServerId,
  PERSIST_SERVER_ID_CACHE_TTL_MS,
} from "@cocalc/conat/persist/load-balancer";
import { messageData } from "@cocalc/conat/core/client";
import { CoreStream } from "@cocalc/conat/sync/core-stream";

beforeAll(before);

describe("persist bootstrap", () => {
  let client;
  let s1;

  it("arms changefeed during getAll and still receives live updates", async () => {
    client = connect();
    s1 = stream({
      client,
      user: { hub_id: "x" },
      storage: { path: `hub/bootstrap-${Math.random()}` },
    });
    const cf = await s1.changefeed({ activateRemote: false });
    expect(await s1.getAll({ changefeed: true })).toEqual([]);

    const next = cf.next();
    await s1.set({
      key: "test",
      messageData: messageData("data", { headers: { foo: "bar" } }),
    });

    const { value, done } = await next;
    expect(done).toBe(false);
    expect(value[0]).toEqual(
      expect.objectContaining({
        seq: 1,
        key: "test",
        headers: { foo: "bar" },
      }),
    );
  });

  it("returns config from the same bootstrap request", async () => {
    s1.close();
    client.close();
    client = connect();
    s1 = stream({
      client,
      user: { hub_id: "x" },
      storage: { path: `hub/bootstrap-config-${Math.random()}` },
    });
    const cf = await s1.changefeed({ activateRemote: false });
    const { messages, config } = await s1.getAllWithInfo({
      changefeed: true,
    });
    expect(messages).toEqual([]);
    expect(config).toEqual(
      expect.objectContaining({
        allow_msg_ttl: false,
        discard_policy: "old",
      }),
    );
    cf.close();
  });

  it("returns metadata and checkpoints from the same bootstrap request", async () => {
    s1.close();
    client.close();
    client = connect();
    s1 = stream({
      client,
      user: { hub_id: "x" },
      storage: { path: `hub/bootstrap-meta-${Math.random()}` },
    });
    await s1.setMetadata({
      version: 1,
      users: ["filesystem", "client-x"],
    });
    await s1.set({
      messageData: messageData("old"),
    });
    await s1.set({
      messageData: messageData("base"),
    });
    await s1.set({
      messageData: messageData("snapshot"),
      checkpoint: {
        name: "latest_snapshot",
        seq: 2,
        data: { patchId: "patch-2" },
      },
    });
    expect(await s1.getMetadata()).toEqual({
      version: 1,
      users: ["filesystem", "client-x"],
    });
    expect(await s1.getCheckpoints()).toEqual({
      latest_snapshot: {
        seq: 2,
        time: expect.any(Number),
        data: { patchId: "patch-2" },
      },
    });

    const { messages, metadata, checkpoints } = await s1.getAllWithInfo({
      start_checkpoint: "latest_snapshot",
    });
    expect(messages.map((x) => x.seq)).toEqual([2, 3]);
    expect(metadata).toEqual({
      version: 1,
      users: ["filesystem", "client-x"],
    });
    expect(checkpoints).toEqual({
      latest_snapshot: {
        seq: 2,
        time: expect.any(Number),
        data: { patchId: "patch-2" },
      },
    });
  });

  it("does not issue a redundant config request after bootstrap returns config", async () => {
    s1.close();
    client.close();
    client = connect();
    const phases: string[] = [];
    const core = new CoreStream({
      client,
      name: `hub/bootstrap-core-${Math.random()}`,
      initPhaseReporter: (phase) => {
        phases.push(phase);
      },
    });
    await core.init();
    expect(phases).toContain("persist_get_all_done");
    expect(phases).not.toContain("persist_config_start");
    core.close();
  });

  it("bootstraps core stream metadata and checkpoints with a checkpoint start", async () => {
    s1.close();
    client.close();
    client = connect();
    const name = `bootstrap-core-meta-${Math.random()}`;
    s1 = stream({
      client,
      user: { hub_id: "x" },
      storage: { path: `hub/${name}` },
    });
    await s1.setMetadata({ users: ["filesystem", "client-x"] });
    await s1.set({
      messageData: messageData("old"),
    });
    await s1.set({
      messageData: messageData("base"),
    });
    await s1.set({
      messageData: messageData("snapshot"),
      checkpoint: {
        name: "latest_snapshot",
        seq: 2,
        data: { patchId: "patch-2" },
      },
    });
    await s1.set({
      messageData: messageData("new"),
    });

    const core = new CoreStream<string>({
      client,
      name,
      start_checkpoint: "latest_snapshot",
    });
    await core.init();
    expect(core.getMetadata()).toEqual({ users: ["filesystem", "client-x"] });
    expect(core.getCheckpoint("latest_snapshot")).toEqual({
      seq: 2,
      time: expect.any(Number),
      data: { patchId: "patch-2" },
    });
    expect(core.getAll()).toEqual(["base", "snapshot", "new"]);
    core.close();
  });

  it("caches persist server id lookups per client and scope", async () => {
    s1.close();
    client.close();
    client = connect();
    let requests = 0;
    const request = client.request.bind(client);
    client.request = (async (...args) => {
      if (args[0] === "persist.project-foo.id") {
        requests += 1;
      }
      return await request(...args);
    }) as typeof client.request;

    expect(
      await getPersistServerId({
        client,
        subject: "persist.project-foo.server.status",
      }),
    ).toBe("0");
    expect(
      await getPersistServerId({
        client,
        subject: "persist.project-foo.server.0.abcd",
      }),
    ).toBe("0");
    expect(requests).toBe(1);
  });

  it("expires the persist server id cache after a short ttl", async () => {
    s1.close();
    client.close();
    client = connect();
    let requests = 0;
    const request = client.request.bind(client);
    client.request = (async (...args) => {
      if (args[0] === "persist.project-bar.id") {
        requests += 1;
      }
      return await request(...args);
    }) as typeof client.request;

    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      expect(
        await getPersistServerId({
          client,
          subject: "persist.project-bar.server.status",
        }),
      ).toBe("0");
      expect(requests).toBe(1);

      expect(
        await getPersistServerId({
          client,
          subject: "persist.project-bar.server.0.abcd",
        }),
      ).toBe("0");
      expect(requests).toBe(1);

      now += PERSIST_SERVER_ID_CACHE_TTL_MS + 1;
      expect(
        await getPersistServerId({
          client,
          subject: "persist.project-bar.server.0.xyz",
        }),
      ).toBe("0");
      expect(requests).toBe(2);
    } finally {
      Date.now = realNow;
    }
  });

  it("cleans up", () => {
    s1.close();
    client.close();
  });
});

afterAll(after);
