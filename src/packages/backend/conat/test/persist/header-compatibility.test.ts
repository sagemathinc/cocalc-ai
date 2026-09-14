import { before, after, connect } from "@cocalc/backend/conat/test/setup";
import { stream } from "@cocalc/conat/persist/client";
import { CoreStream } from "@cocalc/conat/sync/core-stream";
import { messageData } from "@cocalc/conat/core/client";
import { MAX_MESSAGE_HEADER_BYTES } from "@cocalc/conat/core/message-headers";

beforeAll(before);
afterAll(after);
jest.setTimeout(10_000);

function nested(depth: number): any {
  let value: any = "leaf";
  for (let i = 0; i < depth; i++) value = { child: value };
  return value;
}
const editors = {
  version: 1,
  users: Array.from({ length: 112 }, (_, i) => `user-${i}`),
  snapshot_interval: 50,
  settings: {},
};

describe("persistence header compatibility", () => {
  it.each([
    {
      label: "129 ordinary fields",
      metadata: Object.fromEntries(
        Array.from({ length: 129 }, (_, i) => [`field-${i}`, i]),
      ),
    },
    { label: "112 historical editors", metadata: editors },
    { label: "nested metadata", metadata: nested(32) },
  ])(
    "round-trips $label with checkpoints and messages",
    async ({ metadata }) => {
      const client = connect();
      const persisted = stream({
        client,
        user: { hub_id: "test" },
        storage: { path: `hub/header-compat-${Math.random()}` },
      });
      try {
        await persisted.setMetadata(metadata);
        // Also exercise the empty-stream completion carrying the bootstrap.
        expect((await persisted.getAllWithInfo()).metadata).toEqual(metadata);
        await persisted.set({ messageData: messageData("base") });
        await persisted.setCheckpoint({
          name: "latest_snapshot",
          seq: 1,
          data: { metadata, nested: nested(16) },
        });
        await persisted.setCheckpoint({ name: "no_data", seq: 1 });
        const checkpoints = await persisted.getCheckpoints();
        const result = await persisted.getAllWithInfo({
          start_checkpoint: "latest_snapshot",
          timeout: 1000,
        });
        expect(result.metadata).toEqual(metadata);
        expect(result.config).toBeDefined();
        expect(result.checkpoints).toEqual(checkpoints);
        expect(result.messages.map((message) => message.seq)).toEqual([1]);
      } finally {
        persisted.close();
        client.close();
      }
    },
  );

  it("preserves the editor map and snapshot checkpoint through CoreStream bootstrap", async () => {
    const client = connect();
    const name = `header-compat-core-${Math.random()}`;
    const persisted = stream({
      client,
      user: { hub_id: "test" },
      storage: { path: `hub/${name}` },
    });
    const core = new CoreStream({
      client,
      name,
      start_checkpoint: "latest_snapshot",
    });
    try {
      await persisted.setMetadata(editors);
      await persisted.set({
        messageData: messageData("base"),
        checkpoint: {
          name: "latest_snapshot",
          seq: 1,
          data: { patchId: "patch-1" },
        },
      });
      const checkpoints = await persisted.getCheckpoints();
      await core.init();
      expect(core.getMetadata()).toEqual(editors);
      expect(core.getCheckpoint("latest_snapshot")).toEqual(
        checkpoints.latest_snapshot,
      );
      expect(core.getAll()).toEqual(["base"]);
      expect(await persisted.getMetadata()).toEqual(editors);
      expect(await persisted.getCheckpoints()).toEqual(checkpoints);
    } finally {
      core.close();
      persisted.close();
      client.close();
    }
  });

  it("rejects oversized bootstrap headers without changing durable state or retrying forever", async () => {
    const client = connect();
    const name = `header-oversize-${Math.random()}`;
    const persisted = stream({
      client,
      user: { hub_id: "test" },
      storage: { path: `hub/${name}` },
    });
    const core = new CoreStream({ client, name });
    const metadata = { value: "x".repeat(MAX_MESSAGE_HEADER_BYTES) };
    try {
      await persisted.setMetadata(metadata);
      await persisted.set({
        messageData: messageData("base"),
        checkpoint: { name: "latest_snapshot", seq: 1 },
      });
      const checkpoints = await persisted.getCheckpoints();
      await expect(
        persisted.getAllWithInfo({ timeout: 1000, maxWait: 1000 }),
      ).rejects.toMatchObject({ code: 400 });
      await expect(core.init()).rejects.toMatchObject({ code: 400 });
      expect(await persisted.getMetadata()).toEqual(metadata);
      expect(await persisted.getCheckpoints()).toEqual(checkpoints);
      expect(await persisted.getAll()).toHaveLength(1);
    } finally {
      core.close();
      persisted.close();
      client.close();
    }
  });
});
