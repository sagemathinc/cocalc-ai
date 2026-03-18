import { before, after, connect } from "@cocalc/backend/conat/test/setup";
import { stream } from "@cocalc/conat/persist/client";
import { messageData } from "@cocalc/conat/core/client";

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

  it("cleans up", () => {
    s1.close();
    client.close();
  });
});

afterAll(after);
