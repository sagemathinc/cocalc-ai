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

  it("treats recoverable table close as a disconnect instead of closing SyncDoc", () => {
    const recoverNow = jest.fn(async () => {});
    const close = jest.fn();
    const emit = jest.fn();
    const target: any = Object.assign(new EventEmitter(), {
      state: "ready",
      liveConnected: true,
      syncstring_table: { get_state: () => "connected" },
      patches_table: {
        get_state: () => "closed",
        recoverNow,
        getRecoveryState: () => "closed",
      },
      close,
      emit,
      dbg: () => () => undefined,
      recoverNow,
      connectedTables: SyncDoc.prototype["connectedTables"],
      refreshLiveConnectionState:
        SyncDoc.prototype["refreshLiveConnectionState"],
      tableCanRecover: SyncDoc.prototype["tableCanRecover"],
    });

    SyncDoc.prototype["handleTableClose"].call(
      target,
      "patches",
      target.patches_table,
    );

    expect(close).not.toHaveBeenCalled();
    expect(recoverNow).toHaveBeenCalledWith({ reason: "patches_table_close" });
    expect(target.liveConnected).toBe(false);
    expect(emit).toHaveBeenCalledWith("disconnected");
  });

  it("closes SyncDoc when a table closes without recovery support", () => {
    const close = jest.fn();
    const target: any = Object.assign(new EventEmitter(), {
      close,
      dbg: () => () => undefined,
      tableCanRecover: SyncDoc.prototype["tableCanRecover"],
    });

    SyncDoc.prototype["handleTableClose"].call(target, "patches", {
      get_state: () => "closed",
    });

    expect(close).toHaveBeenCalled();
  });
});
