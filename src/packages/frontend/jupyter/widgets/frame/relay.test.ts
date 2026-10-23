/** @jest-environment node */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EventEmitter } from "events";
import { checkCommData, checkValueWrite, WidgetRelay } from "./relay";

// A fake IpywidgetsState over a plain table.
function makeState(table: { [key: string]: any } = {}) {
  const state: any = new EventEmitter();
  const key = (model_id, type) => JSON.stringify(["sid", model_id, type]);
  state.table = table;
  state.saved = 0;
  state.get_state = () => "ready";
  state.get = (model_id, type) => {
    const data = table[key(model_id, type)];
    return data == null ? undefined : { toJS: () => structuredClone(data) };
  };
  state.keys = () =>
    Object.keys(table).map((k) => {
      const [, model_id, type] = JSON.parse(k);
      return { model_id, type };
    });
  state.getSerializedModelState = (model_id) => {
    const s = table[key(model_id, "state")];
    if (s == null) return;
    return {
      ...structuredClone(s),
      ...structuredClone(table[key(model_id, "value")] ?? {}),
    };
  };
  state.set_model_value = jest.fn((model_id, changed) => {
    table[key(model_id, "value")] = {
      ...(table[key(model_id, "value")] ?? {}),
      ...changed,
    };
  });
  state.save = jest.fn(async () => {});
  state.getModelBuffers = jest.fn(async () => ({
    buffer_paths: [["value"]],
    buffers: [new Uint8Array([1, 2, 3]).buffer],
  }));
  state.getMessage = jest.fn(async () => ({
    message: { hello: 1 },
    buffers: [],
  }));
  state.getReferencedModelIds = (id) => {
    const ids = new Set<string>([id]);
    for (const child of table[key(id, "state")]?.children ?? []) {
      ids.add(`${child}`.replace("IPY_MODEL_", ""));
    }
    return ids;
  };
  state.key = key;
  return state;
}

function slider(extra = {}) {
  return {
    _model_name: "IntSliderModel",
    _model_module: "@jupyter-widgets/controls",
    _view_name: "IntSliderView",
    value: 1,
    max: 10,
    ...extra,
  };
}

// A port pair: what the relay sends arrives at frame.messages.
function connect(relay: WidgetRelay, model_id = "box") {
  const channel = new MessageChannel();
  const frame: any = { messages: [] as any[], heights: [] as number[] };
  channel.port2.onmessage = (e) => frame.messages.push(e.data);
  frame.port = channel.port2;
  frame.conn = relay.connect(channel.port1, model_id, (h) =>
    frame.heights.push(h),
  );
  frame.send = (msg) => channel.port2.postMessage(msg);
  return frame;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function setup(writes = true) {
  const state = makeState();
  state.table[state.key("box", "state")] = {
    _model_name: "VBoxModel",
    children: ["IPY_MODEL_s1"],
  };
  state.table[state.key("s1", "state")] = slider();
  state.table[state.key("other", "state")] = slider();
  state.table[state.key("out", "state")] = {
    _model_name: "OutputModel",
    outputs: [],
  };
  const sendComm = jest.fn(async () => {});
  let writable = writes;
  const relay = new WidgetRelay(state, sendComm, () => writable);
  return {
    state,
    sendComm,
    relay,
    setWritable: (w: boolean) => {
      writable = w;
    },
  };
}

describe("WidgetRelay", () => {
  it("sends a snapshot of the notebook's widget state, without messages", async () => {
    const { state, relay } = setup();
    state.table[state.key("s1", "message")] = { message: 1 };
    const frame = connect(relay);
    await settle();
    const snapshot = frame.messages.find((m) => m.type === "snapshot");
    const ids = snapshot.entries.map((e) => `${e.model_id}/${e.type}`);
    expect(ids).toContain("s1/state");
    expect(ids).not.toContain("s1/message");
  });

  it("forwards state changes and resolved custom messages", async () => {
    const { state, relay } = setup();
    const frame = connect(relay);
    await settle();
    state.emit("change", [
      state.key("s1", "state"),
      state.key("s1", "message"),
    ]);
    await settle();
    expect(frame.messages).toContainEqual({
      type: "change",
      entries: [{ model_id: "s1", type: "state", data: slider() }],
    });
    expect(frame.messages).toContainEqual({
      type: "message",
      model_id: "s1",
      message: { hello: 1 },
      buffers: [],
    });
  });

  it("writes a value change and forwards it to the notebook's other frames", async () => {
    const { state, relay } = setup();
    const a = connect(relay);
    const b = connect(relay);
    await settle();
    a.send({
      type: "setModelValue",
      model_id: "s1",
      changed: { value: 5, last_changed: 1 },
    });
    await settle();
    expect(state.set_model_value).toHaveBeenCalledWith(
      "s1",
      { value: 5, last_changed: 1 },
      false,
    );
    // Saves are coalesced.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(state.save).toHaveBeenCalledTimes(1);
    const change = (f) => f.messages.filter((m) => m.type === "change");
    expect(change(b)).toHaveLength(1);
    expect(change(a)).toHaveLength(0);
  });

  it("drops a write that changes nothing (another frame's copy of a derived update)", async () => {
    const { state, relay } = setup();
    const frame = connect(relay);
    await settle();
    frame.send({
      type: "setModelValue",
      model_id: "s1",
      changed: { value: 1, last_changed: 3 },
    });
    await settle();
    expect(state.set_model_value).not.toHaveBeenCalled();
  });

  it.each([
    ["an identity key", { _model_module: "evil-module" }],
    ["a view key", { _view_name: "EvilView" }],
    ["a key the model doesn't have", { onload: "x" }],
  ])("refuses a write of %s", async (_name, changed) => {
    const { state, relay } = setup();
    const frame = connect(relay);
    await settle();
    frame.send({ type: "setModelValue", model_id: "s1", changed });
    await settle();
    expect(state.set_model_value).not.toHaveBeenCalled();
  });

  it("refuses writes of an Output widget's outputs, unknown models and non-JSON values", async () => {
    const { state, relay } = setup();
    const frame = connect(relay);
    await settle();
    frame.send({
      type: "setModelValue",
      model_id: "out",
      changed: { outputs: [{ output_type: "stream", text: "x" }] },
    });
    frame.send({ type: "setModelValue", model_id: "nope", changed: {} });
    frame.send({
      type: "setModelValue",
      model_id: "s1",
      changed: { value: new Uint8Array([1]) },
    });
    frame.send({
      type: "setModelValue",
      model_id: "s1",
      changed: { value: "x".repeat(1_100_000) },
    });
    await settle();
    expect(state.set_model_value).not.toHaveBeenCalled();
  });

  it("lets nothing be written or sent when the notebook isn't writable", async () => {
    const { state, relay, sendComm } = setup(false);
    const frame = connect(relay);
    await settle();
    frame.send({
      type: "setModelValue",
      model_id: "s1",
      changed: { value: 2 },
    });
    frame.send({
      type: "sendComm",
      comm_id: "s1",
      data: { method: "custom", content: {} },
    });
    await settle();
    expect(state.set_model_value).not.toHaveBeenCalled();
    expect(sendComm).not.toHaveBeenCalled();
  });

  it("sends comm messages only for models the frame's widget references", async () => {
    const { relay, sendComm } = setup();
    const frame = connect(relay, "box");
    await settle();
    frame.send({
      type: "sendComm",
      comm_id: "s1",
      data: { method: "custom", content: { a: 1 } },
    });
    frame.send({
      type: "sendComm",
      comm_id: "other",
      data: { method: "custom", content: { a: 1 } },
    });
    await settle();
    expect(sendComm).toHaveBeenCalledTimes(1);
    expect(sendComm).toHaveBeenCalledWith({
      comm_id: "s1",
      target_name: "jupyter.widget",
      data: { method: "custom", content: { a: 1 } },
      buffers: undefined,
    });
  });

  it("sends an identical message from several frames once", async () => {
    const { relay, sendComm } = setup();
    const a = connect(relay, "box");
    const b = connect(relay, "s1");
    await settle();
    const msg = {
      type: "sendComm",
      comm_id: "s1",
      data: { method: "request_state" },
    };
    a.send(msg);
    b.send(msg);
    await settle();
    expect(sendComm).toHaveBeenCalledTimes(1);
    // The same frame may repeat itself (e.g. two clicks).
    a.send(msg);
    await settle();
    expect(sendComm).toHaveBeenCalledTimes(2);
  });

  it("answers buffer requests for models of the notebook only", async () => {
    const { relay } = setup();
    const frame = connect(relay);
    await settle();
    frame.send({ type: "getBuffers", id: 1, model_id: "s1" });
    frame.send({ type: "getBuffers", id: 2, model_id: "nope" });
    await settle();
    const replies = frame.messages.filter((m) => m.type === "reply");
    expect(replies.find((r) => r.id === 1).result.buffer_paths).toEqual([
      ["value"],
    ]);
    expect(replies.find((r) => r.id === 2).error).toBe("unknown model");
  });

  it("reports heights, and stops serving a closed connection", async () => {
    const { relay, state } = setup();
    const frame = connect(relay);
    await settle();
    frame.send({ type: "height", height: 123 });
    await settle();
    expect(frame.heights).toEqual([123]);
    frame.conn.close();
    frame.send({
      type: "setModelValue",
      model_id: "s1",
      changed: { value: 7 },
    });
    state.emit("change", [state.key("s1", "state")]);
    await settle();
    expect(state.set_model_value).not.toHaveBeenCalled();
    expect(frame.messages.filter((m) => m.type === "change")).toHaveLength(0);
  });
});

describe("WidgetRelay limits", () => {
  it("sets the sequence number itself, whatever the frame says", async () => {
    const { state, relay } = setup();
    state.table[state.key("s1", "value")] = { last_changed: 7 };
    const frame = connect(relay);
    await settle();
    frame.send({
      type: "setModelValue",
      model_id: "s1",
      changed: { value: 9, last_changed: 1e300 },
    });
    await settle();
    expect(state.set_model_value).toHaveBeenCalledWith(
      "s1",
      { value: 9, last_changed: 8 },
      false,
    );
  });

  it("refuses a write that adds a model reference the key didn't have", async () => {
    const { state, relay } = setup();
    const frame = connect(relay);
    await settle();
    frame.send({
      type: "setModelValue",
      model_id: "box",
      changed: { children: ["IPY_MODEL_s1", "IPY_MODEL_other"] },
    });
    await settle();
    expect(state.set_model_value).not.toHaveBeenCalled();
    // Reordering or dropping existing references is fine.
    frame.send({
      type: "setModelValue",
      model_id: "box",
      changed: { children: [] },
    });
    await settle();
    expect(state.set_model_value).toHaveBeenCalledTimes(1);
  });

  it("sends no plain value update to the kernel (values go through the shared state)", async () => {
    const { relay, sendComm } = setup();
    const frame = connect(relay, "box");
    await settle();
    frame.send({
      type: "sendComm",
      comm_id: "s1",
      data: { method: "update", state: { value: 4 }, buffer_paths: [] },
    });
    await settle();
    expect(sendComm).not.toHaveBeenCalled();
  });

  it("checks a binary update like a value write", async () => {
    const { relay, sendComm } = setup();
    const frame = connect(relay, "box");
    await settle();
    const buffers = [new Uint8Array([1]).buffer];
    // An identity key: refused, even with a buffer.
    frame.send({
      type: "sendComm",
      comm_id: "s1",
      data: {
        method: "update",
        state: { _model_module: "evil-module", value: null },
        buffer_paths: [["value"]],
      },
      buffers,
    });
    // A buffer for a key the update doesn't write: refused.
    frame.send({
      type: "sendComm",
      comm_id: "s1",
      data: { method: "update", state: { max: 3 }, buffer_paths: [["value"]] },
      buffers,
    });
    await settle();
    expect(sendComm).not.toHaveBeenCalled();
    frame.send({
      type: "sendComm",
      comm_id: "s1",
      data: {
        method: "update",
        state: { value: null },
        buffer_paths: [["value"]],
      },
      buffers,
    });
    await settle();
    expect(sendComm).toHaveBeenCalledTimes(1);
  });

  it("limits writes per frame and for the whole notebook", async () => {
    const { state, relay } = setup();
    const frames = [0, 1, 2, 3, 4].map(() => connect(relay));
    await settle();
    let v = 100;
    for (const f of frames) {
      for (let i = 0; i < 80; i++) {
        f.send({
          type: "setModelValue",
          model_id: "s1",
          changed: { value: v++ },
        });
      }
    }
    await settle();
    // 60 per frame, 200 in all.
    expect(state.set_model_value).toHaveBeenCalledTimes(200);
  });

  it("limits buffer requests per frame", async () => {
    const { relay } = setup();
    const frame = connect(relay);
    await settle();
    for (let id = 0; id < 30; id++) {
      frame.send({ type: "getBuffers", id, model_id: "s1" });
    }
    await settle();
    const replies = frame.messages.filter((m) => m.type === "reply");
    expect(replies.filter((r) => r.result != null)).toHaveLength(20);
    expect(replies.filter((r) => r.error === "too many requests")).toHaveLength(
      10,
    );
  });
});

describe("checkCommData", () => {
  it("accepts the shapes views send", () => {
    expect(checkCommData({ method: "custom", content: { x: 1 } })).toBeTruthy();
    expect(checkCommData({ method: "request_state" })).toBeTruthy();
    expect(
      checkCommData({
        method: "update",
        state: { value: 1 },
        buffer_paths: [],
      }),
    ).toBeTruthy();
  });

  it("refuses anything else", () => {
    expect(checkCommData({ method: "exec", code: "x" })).toBeUndefined();
    expect(
      checkCommData({ method: "custom", content: 1, extra: 2 }),
    ).toBeUndefined();
    expect(checkCommData({ method: "update", state: "x" })).toBeUndefined();
    expect(checkCommData("custom")).toBeUndefined();
  });
});

describe("checkValueWrite", () => {
  it("allows existing keys and drops the frame's sequence number", () => {
    expect(checkValueWrite(slider(), { value: 2, last_changed: 4 })).toEqual({
      value: 2,
    });
  });
});
