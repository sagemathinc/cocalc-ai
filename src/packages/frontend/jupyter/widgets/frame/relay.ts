/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The app page's side of the widget frames of one notebook.

Each widget frame (see protocol.ts) is connected to the relay over its own
MessagePort.  The relay gives every frame the notebook's widget state and
forwards changes to it, and it answers the frame's requests after checking
them: buffers of a model of this notebook, a value update of a model of this
notebook, a widget comm message to this notebook's kernel.  Nothing a frame
sends is ever evaluated, rendered or used as a path or URL here.

Several frames of one notebook are several clients of the widget state, like
several browsers: each frame runs its own widget manager over all models, and
per-model sequence numbers (last_changed) make updates converge.  A frame's
own writes don't fire local change events, so the relay forwards them to the
notebook's other frames itself.  Because every frame runs every model, derived
updates (jslink, models that recompute) and creation-time messages repeat in
each frame: writes that change nothing are dropped, and a comm message that
another frame sent identically a moment ago is not sent again.

What a frame may write is narrow (see setModelValue and sendComm): values of
keys a model already has, never its identity (the "_" keys, which choose the
code every viewer's frames run) or an Output widget's outputs; comm messages
only for models its own widget references, in the shapes views send.  Only a
user who can write the notebook may write or message at all.
*/

import type { IpywidgetsState } from "@cocalc/sync/editor/generic/ipywidgets-state";
import { isEqual } from "lodash";
import {
  bufferBytes,
  isBufferList,
  isModelId,
  isPlainObject,
  jsonSize,
  MAX_REQUEST_BUFFER_BYTES,
  MAX_REQUEST_JSON_BYTES,
  MAX_BUFFER_REQUESTS_PER_SECOND,
  MAX_NOTEBOOK_WRITES_PER_SECOND,
  MAX_WRITES_PER_SECOND,
  SAVE_INTERVAL_MS,
  type ParentMessage,
  type WidgetStateEntry,
  type WidgetTheme,
} from "./protocol";

const ENTRY_TYPES = new Set(["state", "value", "buffers", "message"]);

// How long an identical comm message from another frame counts as a repeat.
const DUPLICATE_MESSAGE_MS = 2000;
// Comm methods every frame sends for a model it runs (deduplicated across
// frames); anything else is a separate action.
const INIT_COMM_METHODS = new Set<unknown>(["request_state"]);

// The comm messages widget views send, by method, with the keys allowed.
const COMM_SHAPES: { [method: string]: Set<string> } = {
  update: new Set(["method", "state", "buffer_paths"]),
  custom: new Set(["method", "content"]),
  request_state: new Set(["method"]),
};

// The comm message data a view may send, else undefined.
export function checkCommData(
  data: unknown,
): { method: string; [key: string]: any } | undefined {
  if (!isPlainObject(data)) return;
  const allowed = COMM_SHAPES[`${data.method}`];
  if (allowed == null || typeof data.method !== "string") return;
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) return;
  }
  if (data.method === "update" && !isPlainObject(data.state)) return;
  if (
    data.buffer_paths != null &&
    !(
      Array.isArray(data.buffer_paths) &&
      data.buffer_paths.every(
        (p) =>
          Array.isArray(p) &&
          p.every((k) => typeof k === "string" || typeof k === "number"),
      )
    )
  ) {
    return;
  }
  return data as { method: string; [key: string]: any };
}

// The model ids a value references (IPY_MODEL_<id> strings anywhere in it).
export function modelReferences(value: unknown, refs = new Set<string>()) {
  if (typeof value === "string") {
    if (value.startsWith("IPY_MODEL_")) refs.add(value.slice(10));
  } else if (Array.isArray(value)) {
    for (const x of value) modelReferences(x, refs);
  } else if (value != null && typeof value === "object") {
    for (const x of Object.values(value)) modelReferences(x, refs);
  }
  return refs;
}

// The values a frame may write to a model whose current serialized state is
// current, else undefined (the whole write is refused): only keys the model
// already has, never an identity or protocol key ("_..."), never an Output
// widget's outputs, and no reference to a model the key doesn't already
// reference (which would widen what the frame may message).  The sequence
// number is the relay's, never the frame's.
export function checkValueWrite(
  current: { [key: string]: any },
  changed: { [key: string]: any },
): { [key: string]: any } | undefined {
  const isOutput = current._model_name === "OutputModel";
  const values: { [key: string]: any } = {};
  for (const key of Object.keys(changed)) {
    if (key === "last_changed") continue;
    if (key.startsWith("_")) return;
    if (!Object.prototype.hasOwnProperty.call(current, key)) return;
    if (isOutput && key === "outputs") return;
    const allowed = modelReferences(current[key]);
    for (const id of modelReferences(changed[key])) {
      if (!allowed.has(id)) return;
    }
    values[key] = changed[key];
  }
  return values;
}

// An "update" comm message a frame may send: only one that carries binary
// values (e.g. FileUpload), which the shared widget state can't; plain value
// updates reach the kernel from the shared state (the project sends them),
// so they go through setModelValue and its checks instead.  Its state gets
// the same checks as a value write, and every buffer must belong to a key it
// writes.
export function checkUpdateComm(
  current: { [key: string]: any },
  data: { [key: string]: any },
  buffers: ArrayBuffer[] | undefined,
): boolean {
  if (!isPlainObject(data.state)) return false;
  const paths: any[] = data.buffer_paths ?? [];
  if (paths.length === 0 || (buffers?.length ?? 0) !== paths.length) {
    return false;
  }
  const state = checkValueWrite(current, data.state);
  if (
    state == null ||
    Object.keys(state).length !== Object.keys(data.state).length
  ) {
    return false;
  }
  return paths.every(
    (p) =>
      Array.isArray(p) &&
      p.length > 0 &&
      Object.prototype.hasOwnProperty.call(state, p[0]),
  );
}

export type SendCommMessage = (opts: {
  comm_id: string;
  target_name: string;
  data: unknown;
  buffers?: ArrayBuffer[];
}) => Promise<unknown>;

export interface RelayConnection {
  close: () => void;
  setTheme: (theme: WidgetTheme) => void;
}

interface Connection {
  port: MessagePort;
  // the model this frame renders
  model_id: string;
  writes: number[];
  bufferRequests: number[];
  onHeight: (height: number) => void;
}

// Whether another event fits in times (event times within the last second)
// under limit; records it if so and record is true.
function underLimit(times: number[], limit: number, record = true): boolean {
  const now = Date.now();
  while (times.length > 0 && times[0] <= now - 1000) times.shift();
  if (times.length >= limit) return false;
  if (record) times.push(now);
  return true;
}

export class WidgetRelay {
  private connections = new Set<Connection>();
  private notebookWrites: number[] = [];
  private closed = false;

  constructor(
    private readonly state: IpywidgetsState,
    private readonly sendComm: SendCommMessage,
    // Whether frames may write state and send comm messages now (the user
    // can write the notebook).
    private readonly writesAllowed: () => boolean = () => true,
  ) {
    this.state.on("change", this.handleStateChange);
  }

  isClosed = (): boolean => this.closed;

  close = (): void => {
    if (this.closed) return;
    this.closed = true;
    if (this.saveTimer != null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      void this.state.save();
    }
    this.state.removeListener("change", this.handleStateChange);
    for (const c of this.connections) c.port.close();
    this.connections.clear();
  };

  // Serve a frame that renders model_id over port.  onHeight gets the content
  // height it reports, unchecked except that it is a number (the caller
  // clamps it).
  connect(
    port: MessagePort,
    model_id: string,
    onHeight: (height: number) => void,
  ): RelayConnection {
    const conn: Connection = {
      port,
      model_id,
      writes: [],
      bufferRequests: [],
      onHeight,
    };
    const close = () => {
      if (!this.connections.delete(conn)) return;
      port.onmessage = null;
      port.close();
    };
    if (this.closed) {
      port.close();
      return { close: () => {}, setTheme: () => {} };
    }
    this.connections.add(conn);
    port.onmessage = (event) => {
      if (!this.connections.has(conn)) return;
      void this.handleRequest(conn, event.data).catch((err) =>
        console.warn("widget frame request failed", err),
      );
    };
    port.start();
    void this.sendSnapshot(conn);
    return {
      close,
      setTheme: (theme) => this.post(conn, { type: "theme", theme }),
    };
  }

  private post(
    conn: Connection,
    message: ParentMessage,
    transfer?: Transferable[],
  ): void {
    if (!this.connections.has(conn)) return;
    try {
      conn.port.postMessage(message, transfer ?? []);
    } catch (err) {
      console.warn("widget frame post failed", err);
    }
  }

  private async ready(): Promise<boolean> {
    if (this.state.get_state() === "ready") return true;
    if (this.state.get_state() === "closed") return false;
    await new Promise<void>((resolve) => {
      const done = () => {
        this.state.removeListener("ready", done);
        this.state.removeListener("closed", done);
        resolve();
      };
      this.state.on("ready", done);
      this.state.on("closed", done);
    });
    return this.state.get_state() === "ready";
  }

  private entry(
    model_id: string,
    type: WidgetStateEntry["type"],
  ): WidgetStateEntry {
    const data = this.state.get(model_id, type);
    return { model_id, type, data: data?.toJS?.() ?? data ?? null };
  }

  private async sendSnapshot(conn: Connection): Promise<void> {
    if (!(await this.ready()) || this.closed) return;
    const entries: WidgetStateEntry[] = [];
    for (const { model_id, type } of this.state.keys()) {
      // A custom message is delivered when it arrives, never replayed.
      if (`${type}` === "message" || !ENTRY_TYPES.has(type)) continue;
      entries.push(this.entry(model_id, type as WidgetStateEntry["type"]));
    }
    this.post(conn, { type: "snapshot", entries });
  }

  private handleStateChange = (keys: Iterable<string>): void => {
    if (this.closed || this.connections.size === 0) return;
    const entries: WidgetStateEntry[] = [];
    for (const key of keys) {
      let model_id: unknown, type: unknown;
      try {
        [, model_id, type] = JSON.parse(key);
      } catch {
        continue;
      }
      if (typeof model_id !== "string" || !ENTRY_TYPES.has(`${type}`)) {
        continue;
      }
      if (type === "message") {
        void this.forwardMessage(model_id);
      } else {
        entries.push(this.entry(model_id, type as WidgetStateEntry["type"]));
      }
    }
    if (entries.length > 0) this.broadcast({ type: "change", entries });
  };

  private broadcast(message: ParentMessage, except?: Connection): void {
    for (const conn of this.connections) {
      if (conn !== except) this.post(conn, message);
    }
  }

  private async forwardMessage(model_id: string): Promise<void> {
    const x = await this.state.getMessage(model_id);
    if (x == null || this.closed) return;
    this.broadcast({
      type: "message",
      model_id,
      message: x.message,
      buffers: x.buffers,
    });
  }

  private recentMessages = new Map<
    string,
    { conn: Connection; time: number }
  >();

  // Whether an identical message came from another frame just now.
  private isRepeat(conn: Connection, key: string): boolean {
    const now = Date.now();
    for (const [k, v] of this.recentMessages) {
      if (v.time > now - DUPLICATE_MESSAGE_MS) break;
      this.recentMessages.delete(k);
    }
    const prev = this.recentMessages.get(key);
    // A repeat is dropped, so the frame that sent it stays on record.
    if (prev != null && prev.conn !== conn) return true;
    this.recentMessages.delete(key);
    this.recentMessages.set(key, { conn, time: now });
    return false;
  }

  // The models a frame's widget references (its children, layout, style,
  // links, ...), as the widget state says now.
  private closure(conn: Connection): Set<string> {
    return this.state.getReferencedModelIds(conn.model_id);
  }

  private isModel(model_id: unknown): model_id is string {
    return (
      isModelId(model_id) &&
      this.state.get_state() === "ready" &&
      this.state.get(model_id, "state") != null
    );
  }

  // Writes (value writes and comm messages) are limited per frame and for
  // the whole notebook; buffer requests (project RPCs) per frame.
  private allowWrite(conn: Connection): boolean {
    if (
      !underLimit(this.notebookWrites, MAX_NOTEBOOK_WRITES_PER_SECOND, false)
    ) {
      return false;
    }
    if (!underLimit(conn.writes, MAX_WRITES_PER_SECOND)) return false;
    underLimit(this.notebookWrites, MAX_NOTEBOOK_WRITES_PER_SECOND);
    return true;
  }

  // Saves are coalesced: at most one per SAVE_INTERVAL_MS.
  private saveTimer?: ReturnType<typeof setTimeout>;
  private scheduleSave(): void {
    if (this.saveTimer != null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      if (!this.closed) void this.state.save();
    }, SAVE_INTERVAL_MS);
  }

  private async handleRequest(conn: Connection, req: any): Promise<void> {
    if (!isPlainObject(req) || this.closed) return;
    switch (req.type) {
      case "height":
        if (typeof req.height === "number") conn.onHeight(req.height);
        return;

      case "getBuffers": {
        const { id, model_id } = req;
        if (typeof id !== "number") return;
        if (!underLimit(conn.bufferRequests, MAX_BUFFER_REQUESTS_PER_SECOND)) {
          this.post(conn, { type: "reply", id, error: "too many requests" });
          return;
        }
        if (!this.isModel(model_id)) {
          this.post(conn, { type: "reply", id, error: "unknown model" });
          return;
        }
        try {
          const { buffer_paths, buffers } =
            await this.state.getModelBuffers(model_id);
          this.post(conn, {
            type: "reply",
            id,
            result: { buffer_paths, buffers },
          });
        } catch (err) {
          this.post(conn, { type: "reply", id, error: `${err}` });
        }
        return;
      }

      case "setModelValue": {
        const { model_id } = req;
        if (!this.isModel(model_id) || !isPlainObject(req.changed)) return;
        if (!this.writesAllowed()) return;
        const size = jsonSize(req.changed);
        if (size == null || size > MAX_REQUEST_JSON_BYTES) return;
        const current = this.state.getSerializedModelState(model_id);
        if (current == null) return;
        const changed = checkValueWrite(current, req.changed);
        if (changed == null) return;
        // Another frame already wrote the same values (e.g. its own copy of
        // a jslink): nothing to do.
        if (
          Object.keys(changed).every(
            (k) => k === "last_changed" || isEqual(current[k], changed[k]),
          )
        ) {
          return;
        }
        if (!this.allowWrite(conn)) return;
        // The sequence number is the relay's: the next one after the shared
        // state's, as the project does for kernel changes.
        const seq = Number.isSafeInteger(current.last_changed)
          ? current.last_changed
          : 0;
        changed.last_changed = seq + 1;
        this.state.set_model_value(model_id, changed, false);
        this.scheduleSave();
        this.broadcast(
          { type: "change", entries: [this.entry(model_id, "value")] },
          conn,
        );
        return;
      }

      case "sendComm": {
        const { comm_id, buffers } = req;
        // Widget comms are the models of this notebook; a frame messages only
        // the models its own widget references.
        if (!this.isModel(comm_id) || !this.closure(conn).has(comm_id)) return;
        if (!this.writesAllowed()) return;
        const data = checkCommData(req.data);
        if (data == null) return;
        const size = jsonSize(data);
        if (size == null || size > MAX_REQUEST_JSON_BYTES) return;
        if (buffers != null && !isBufferList(buffers)) return;
        if (bufferBytes(buffers) > MAX_REQUEST_BUFFER_BYTES) return;
        if (data.method === "update") {
          // Only binary values; checked like a value write.
          const current = this.state.getSerializedModelState(comm_id);
          if (current == null || !checkUpdateComm(current, data, buffers)) {
            return;
          }
        }
        // Every frame runs every model, so initialization messages arrive
        // once per frame. Only those are deduplicated: identical user
        // actions (e.g. clicks on two views of one button) are distinct.
        if (
          INIT_COMM_METHODS.has(data.method) &&
          (buffers == null || buffers.length === 0)
        ) {
          if (this.isRepeat(conn, JSON.stringify([comm_id, data]))) return;
        }
        if (!this.allowWrite(conn)) return;
        await this.sendComm({
          comm_id,
          target_name: "jupyter.widget",
          data,
          buffers,
        });
        return;
      }
    }
  }
}
