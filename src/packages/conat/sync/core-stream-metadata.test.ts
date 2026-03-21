import { CoreStream } from "./core-stream";

function createStream() {
  return new CoreStream({
    name: "metadata-test",
    client: { state: "ready" } as any,
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
});
