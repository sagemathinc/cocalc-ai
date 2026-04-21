let mockRecoveryState = "ready";

jest.mock("./core-stream", () => {
  const { EventEmitter } = require("events");

  class CoreStream extends EventEmitter {
    messages: any[] = [];
    raw: any[] = [];
    start_seq: number | undefined = undefined;

    init = jest.fn(async () => {});
    close = jest.fn();
    publishMany = jest.fn(async (messages: any[]) =>
      messages.map((_message, i) => ({ seq: i + 1, time: Date.now() + i })),
    );
    headers = jest.fn();
    time = jest.fn();
    times = jest.fn(() => []);
    getMetadata = jest.fn();
    setMetadata = jest.fn();
    patchMetadata = jest.fn();
    getCheckpoints = jest.fn(() => ({}));
    getCheckpoint = jest.fn();
    setCheckpoint = jest.fn();
    deleteCheckpoint = jest.fn();
    getRecoveryState = jest.fn(() => mockRecoveryState);
    pauseRecovery = jest.fn();
    resumeRecovery = jest.fn();
    recoverNow = jest.fn();
    load = jest.fn();
    delete = jest.fn();
    config = jest.fn(async (config) => config);
  }

  return { CoreStream };
});

import { DStream } from "./dstream";
import { SyncTableStream } from "./synctable-stream";

describe("DStream unsaved change events", () => {
  beforeEach(() => {
    mockRecoveryState = "ready";
  });

  it("emits when local messages become pending and then acknowledged", async () => {
    const stream = new DStream({
      name: "unsaved-events",
      client: {} as any,
      noAutosave: true,
      noInventory: true,
    });
    await stream.init();

    const events: boolean[] = [];
    stream.on("has-unsaved-changes", (value) => events.push(value));

    stream.publish({ text: "hello" });
    expect(stream.hasUnsavedChanges()).toBe(true);
    expect(events).toEqual([true]);

    await stream.save();
    expect(stream.hasUnsavedChanges()).toBe(false);
    expect(events).toEqual([true, false]);
  });

  it("propagates DStream pending writes as SyncTableStream uncommitted changes", async () => {
    const project_id = "00000000-0000-4000-8000-000000000000";
    const table = new SyncTableStream({
      client: {} as any,
      immutable: true,
      noAutosave: true,
      noInventory: true,
      query: {
        patches: [
          {
            project_id,
            path: "doc.txt",
            time: null,
            user_id: null,
            wall: null,
            patch: null,
            snapshot: null,
            is_snapshot: null,
            seq_info: null,
            parents: null,
            version: null,
          },
        ],
      },
    });
    await table.init();

    const events: boolean[] = [];
    table.on("has-uncommitted-changes", (value) => events.push(value));

    table.set({
      project_id,
      path: "doc.txt",
      time: "patch-1",
      user_id: 1,
      wall: new Date(),
      patch: "patch",
    });
    expect(table.has_uncommitted_changes()).toBe(true);
    expect(events).toEqual([true]);

    await table.save();
    expect(table.has_uncommitted_changes()).toBe(false);
    expect(events).toEqual([true, false]);
  });

  it("propagates DStream recovery state as SyncTableStream connection state", async () => {
    const project_id = "00000000-0000-4000-8000-000000000000";
    const table = new SyncTableStream({
      client: {} as any,
      immutable: true,
      noAutosave: true,
      noInventory: true,
      query: {
        patches: [
          {
            project_id,
            path: "doc.txt",
            time: null,
            user_id: null,
            wall: null,
            patch: null,
            snapshot: null,
            is_snapshot: null,
            seq_info: null,
            parents: null,
            version: null,
          },
        ],
      },
    });
    await table.init();

    const events: string[] = [];
    table.on("disconnected", () => events.push("disconnected"));
    table.on("connected", () => events.push("connected"));

    (table as any).dstream.emit("disconnected");
    expect(table.get_state()).toBe("disconnected");

    (table as any).dstream.emit("recovered");
    expect(table.get_state()).toBe("connected");
    expect(events).toEqual(["disconnected", "connected"]);
  });

  it("initializes SyncTableStream disconnected when the DStream is still recovering", async () => {
    mockRecoveryState = "recovering";
    const project_id = "00000000-0000-4000-8000-000000000000";
    const table = new SyncTableStream({
      client: {} as any,
      immutable: true,
      noAutosave: true,
      noInventory: true,
      query: {
        patches: [
          {
            project_id,
            path: "doc.txt",
            time: null,
            user_id: null,
            wall: null,
            patch: null,
            snapshot: null,
            is_snapshot: null,
            seq_info: null,
            parents: null,
            version: null,
          },
        ],
      },
    });

    await table.init();

    expect(table.get_state()).toBe("disconnected");
  });

  it("forwards explicit recovery requests from SyncTableStream to DStream", async () => {
    mockRecoveryState = "recovering";
    const project_id = "00000000-0000-4000-8000-000000000000";
    const table = new SyncTableStream({
      client: {} as any,
      immutable: true,
      noAutosave: true,
      noInventory: true,
      query: {
        patches: [
          {
            project_id,
            path: "doc.txt",
            time: null,
            user_id: null,
            wall: null,
            patch: null,
            snapshot: null,
            is_snapshot: null,
            seq_info: null,
            parents: null,
            version: null,
          },
        ],
      },
    });
    await table.init();

    await table.recoverNow({
      priority: "foreground",
      reason: "test",
    });

    expect((table as any).dstream.stream.recoverNow).toHaveBeenCalledWith({
      priority: "foreground",
      reason: "test",
    });
  });
});
