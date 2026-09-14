import { CoreStream } from "./core-stream";
import { ConatError } from "../core/client";

function createStream() {
  return new CoreStream({
    name: "metadata-test",
    client: {
      state: "ready",
      recoveryScheduler: {
        registerResource: jest.fn(() => ({
          requestRecovery: jest.fn(),
          close: jest.fn(),
        })),
      },
    } as any,
  });
}

describe("CoreStream metadata propagation", () => {
  it("applies metadata and checkpoint control updates from the changefeed", () => {
    const stream = createStream();
    const metadataEvents: any[] = [];
    const checkpointEvents: any[] = [];
    stream.on("metadata-change", (metadata) => {
      metadataEvents.push(metadata);
    });
    stream.on("checkpoints-change", (checkpoints) => {
      checkpointEvents.push(checkpoints);
    });

    (stream as any).processPersistentMessage(
      { op: "metadata", metadata: { users: ["client-a", "client-b"] } },
      { noEmit: false, noSeqCheck: false },
    );
    (stream as any).processPersistentMessage(
      {
        op: "checkpoints",
        checkpoints: {
          latest_snapshot: {
            seq: 7,
            time: 1234,
            data: { patchId: "patch-7" },
          },
        },
      },
      { noEmit: false, noSeqCheck: false },
    );

    expect(stream.getMetadata()).toEqual({
      users: ["client-a", "client-b"],
    });
    expect(stream.getCheckpoint("latest_snapshot")).toEqual({
      seq: 7,
      time: 1234,
      data: { patchId: "patch-7" },
    });
    expect(metadataEvents).toEqual([{ users: ["client-a", "client-b"] }]);
    expect(checkpointEvents).toEqual([
      {
        latest_snapshot: {
          seq: 7,
          time: 1234,
          data: { patchId: "patch-7" },
        },
      },
    ]);
  });

  it("refreshes metadata and checkpoints during reconnect recovery", async () => {
    const stream = createStream();
    const persistClient = {
      changefeed: jest.fn().mockResolvedValue({}),
      getAllWithInfo: jest.fn().mockResolvedValue({
        messages: [],
        metadata: { users: ["client-a", "client-c"] },
        checkpoints: {
          latest_snapshot: {
            seq: 11,
            time: 4321,
            data: { patchId: "patch-11" },
          },
        },
      }),
    };
    (stream as any).persistClient = persistClient;

    await (stream as any).getAllFromPersist({
      start_seq: 12,
      noEmit: false,
      includeConfig: false,
    });

    expect(persistClient.changefeed).toHaveBeenCalledWith({
      activateRemote: false,
    });
    expect(persistClient.getAllWithInfo).toHaveBeenCalledWith({
      start_seq: 12,
      start_checkpoint: undefined,
      timeout: 30000,
      changefeed: true,
      includeConfig: false,
    });
    expect(stream.getMetadata()).toEqual({
      users: ["client-a", "client-c"],
    });
    expect(stream.getCheckpoint("latest_snapshot")).toEqual({
      seq: 11,
      time: 4321,
      data: { patchId: "patch-11" },
    });
  });

  it("leaves existing metadata and checkpoints intact when recovery is incomplete", async () => {
    const stream = createStream();
    const metadata = {
      users: Array.from({ length: 112 }, (_, i) => `historical-editor-${i}`),
    };
    const checkpoints = {
      latest_snapshot: { seq: 11, time: 4321, data: { patchId: "patch-11" } },
    };
    (stream as any).processPersistentMessage({ op: "metadata", metadata }, {});
    (stream as any).processPersistentMessage(
      { op: "checkpoints", checkpoints },
      {},
    );
    const error = new ConatError("incomplete persistence bootstrap state", {
      code: 503,
    });
    const persistClient = {
      changefeed: jest.fn().mockResolvedValue({}),
      getAllWithInfo: jest.fn().mockRejectedValue(error),
      close: jest.fn(),
    };
    (stream as any).persistClient = persistClient;
    const metadataChange = jest.fn();
    const checkpointsChange = jest.fn();
    stream.on("metadata-change", metadataChange);
    stream.on("checkpoints-change", checkpointsChange);
    try {
      await expect(
        (stream as any).getAllFromPersist({ start_seq: 12, retry: false }),
      ).rejects.toBe(error);
      expect(stream.getMetadata()).toEqual(metadata);
      expect(stream.getCheckpoint("latest_snapshot")).toEqual(
        checkpoints.latest_snapshot,
      );
      expect(metadataChange).not.toHaveBeenCalled();
      expect(checkpointsChange).not.toHaveBeenCalled();
    } finally {
      stream.close();
    }
  });
});
