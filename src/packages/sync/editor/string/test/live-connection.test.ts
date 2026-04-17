import { EventEmitter } from "events";
import { SyncDoc } from "../../generic/sync-doc";

describe("SyncDoc live connection state", () => {
  it("emits connected when ready tables are connected", () => {
    const emit = jest.fn();
    const target: any = Object.assign(new EventEmitter(), {
      state: "ready",
      liveConnected: false,
      syncstring_table: { get_state: () => "connected" },
      patches_table: { get_state: () => "connected" },
      emit,
      connectedTables: SyncDoc.prototype["connectedTables"],
    });

    SyncDoc.prototype["refreshLiveConnectionState"].call(target);

    expect(target.liveConnected).toBe(true);
    expect(emit).toHaveBeenCalledWith("connected");
  });

  it("emits disconnected when a ready table drops offline", () => {
    const emit = jest.fn();
    const target: any = Object.assign(new EventEmitter(), {
      state: "ready",
      liveConnected: true,
      syncstring_table: { get_state: () => "disconnected" },
      patches_table: { get_state: () => "connected" },
      emit,
      connectedTables: SyncDoc.prototype["connectedTables"],
    });

    SyncDoc.prototype["refreshLiveConnectionState"].call(target);

    expect(target.liveConnected).toBe(false);
    expect(emit).toHaveBeenCalledWith("disconnected");
  });
});
