/** @jest-environment node */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { RemoteWidgetState } from "./remote-state";

function setup() {
  const posted: any[] = [];
  const port: any = { postMessage: (msg) => posted.push(msg) };
  const state = new RemoteWidgetState(port);
  return { state, posted };
}

const key = (model_id, type) => JSON.stringify(["", model_id, type]);

describe("RemoteWidgetState", () => {
  it("is ready after the snapshot and merges state with value", () => {
    const { state } = setup();
    const ready = jest.fn();
    state.on("ready", ready);
    expect(state.get_state()).toBe("init");
    state.handle({
      type: "snapshot",
      entries: [
        { model_id: "m", type: "state", data: { _model_name: "X", value: 1 } },
        { model_id: "m", type: "value", data: { value: 2 } },
      ],
    });
    expect(ready).toHaveBeenCalled();
    expect(state.getSerializedModelState("m")).toEqual({
      _model_name: "X",
      value: 2,
    });
    expect(state.keys()).toEqual([
      { model_id: "m", type: "state" },
      { model_id: "m", type: "value" },
    ]);
  });

  it("returns copies, so the manager can't change the table by mutating them", () => {
    const { state } = setup();
    state.handle({
      type: "snapshot",
      entries: [{ model_id: "m", type: "state", data: { a: { b: 1 } } }],
    });
    state.getSerializedModelState("m")!.a.b = 5;
    expect(state.getSerializedModelState("m")!.a.b).toBe(1);
  });

  it("emits change keys in IpywidgetsState's shape", () => {
    const { state } = setup();
    state.handle({ type: "snapshot", entries: [] });
    const change = jest.fn();
    state.on("change", change);
    state.handle({
      type: "change",
      entries: [{ model_id: "m", type: "value", data: { v: 1 } }],
    });
    expect(change).toHaveBeenCalledWith([key("m", "value")]);
    state.handle({
      type: "message",
      model_id: "m",
      message: { x: 1 },
      buffers: [],
    });
    expect(change).toHaveBeenLastCalledWith([key("m", "message")]);
  });

  it("delivers a custom message once", async () => {
    const { state } = setup();
    state.handle({ type: "snapshot", entries: [] });
    state.handle({ type: "message", model_id: "m", message: 1, buffers: [] });
    expect(await state.getMessage("m")).toEqual({ message: 1, buffers: [] });
    expect(await state.getMessage("m")).toBeUndefined();
  });

  it("merges a value write locally and sends the change itself to the relay", () => {
    const { state, posted } = setup();
    state.handle({
      type: "snapshot",
      entries: [{ model_id: "m", type: "value", data: { a: { x: 1 }, b: 1 } }],
    });
    state.set_model_value("m", { a: { y: 2 } }, false);
    expect(state.get_model_value("m")).toEqual({ a: { x: 1, y: 2 }, b: 1 });
    expect(posted).toEqual([
      { type: "setModelValue", model_id: "m", changed: { a: { y: 2 } } },
    ]);
  });

  it("asks the relay for buffers, and only for models that have them", async () => {
    const { state, posted } = setup();
    state.handle({
      type: "snapshot",
      entries: [{ model_id: "m", type: "buffers", data: { '["v"]': "h" } }],
    });
    expect(await state.getModelBuffers("other")).toEqual({
      buffer_paths: [],
      buffers: [],
    });
    const pending = state.getModelBuffers("m");
    expect(posted[0]).toEqual({ type: "getBuffers", model_id: "m", id: 0 });
    state.handle({
      type: "reply",
      id: 0,
      result: { buffer_paths: [["v"]], buffers: [] },
    });
    expect(await pending).toEqual({ buffer_paths: [["v"]], buffers: [] });
  });

  it("ignores everything once closed", () => {
    const { state } = setup();
    state.handle({ type: "snapshot", entries: [] });
    state.close();
    state.handle({
      type: "change",
      entries: [{ model_id: "m", type: "state", data: {} }],
    });
    expect(state.get_state()).toBe("closed");
    expect(state.getSerializedModelState("m")).toBeUndefined();
  });
});
