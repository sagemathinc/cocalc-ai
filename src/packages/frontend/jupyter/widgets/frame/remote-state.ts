/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The notebook's widget state as a widget frame sees it: a copy kept current by
the app page's relay (relay.ts), with the part of IpywidgetsState's interface
that the widget manager uses.  Writes go to the relay, which checks them.
*/

import { EventEmitter } from "events";
import type { ParentMessage, WidgetStateEntry } from "./protocol";

type EntryType = WidgetStateEntry["type"];

// What the widget manager needs from the widget state.
export interface WidgetState extends EventEmitter {
  get_state(): "init" | "ready" | "closed";
  keys(): { model_id: string; type: EntryType }[];
  getSerializedModelState(model_id: string): { [key: string]: any } | undefined;
  get_model_value(model_id: string): { [key: string]: any };
  set_model_value(
    model_id: string,
    value: { [key: string]: any },
    fire_change_event?: boolean,
  ): void;
  save(): Promise<void>;
  getModelBuffers(
    model_id: string,
  ): Promise<{ buffer_paths: string[][]; buffers: ArrayBuffer[] }>;
  getMessage(
    model_id: string,
  ): Promise<{ message: any; buffers: ArrayBuffer[] } | undefined>;
}

function isObject(x: unknown): x is { [key: string]: any } {
  return x != null && typeof x === "object" && !Array.isArray(x);
}

function copy<T>(x: T): T {
  return x == null ? x : structuredClone(x);
}

// Change event keys have the shape IpywidgetsState uses.
function changeKey(model_id: string, type: EntryType): string {
  return JSON.stringify(["", model_id, type]);
}

export class RemoteWidgetState extends EventEmitter implements WidgetState {
  private state: "init" | "ready" | "closed" = "init";
  private table = new Map<string, any>();
  private messages = new Map<
    string,
    { message: any; buffers: ArrayBuffer[] }
  >();
  private nextRequestId = 0;
  private pending = new Map<
    number,
    { resolve: (x: any) => void; reject: (err: Error) => void }
  >();

  constructor(private readonly port: MessagePort) {
    super();
    // Many models each listen for changes while they load.
    this.setMaxListeners(0);
  }

  // Apply a message from the relay.
  handle(msg: ParentMessage): void {
    if (this.state === "closed" || msg == null) return;
    switch (msg.type) {
      case "snapshot":
        this.table.clear();
        for (const e of msg.entries ?? []) this.setEntry(e);
        if (this.state === "init") {
          this.state = "ready";
          this.emit("ready");
        }
        return;
      case "change": {
        const keys: string[] = [];
        for (const e of msg.entries ?? []) {
          if (this.setEntry(e)) keys.push(changeKey(e.model_id, e.type));
        }
        if (keys.length > 0 && this.state === "ready") {
          this.emit("change", keys);
        }
        return;
      }
      case "message":
        if (typeof msg.model_id !== "string") return;
        this.messages.set(msg.model_id, {
          message: msg.message,
          buffers: msg.buffers ?? [],
        });
        if (this.state === "ready") {
          this.emit("change", [changeKey(msg.model_id, "message")]);
        }
        return;
      case "reply": {
        const p = this.pending.get(msg.id);
        if (p == null) return;
        this.pending.delete(msg.id);
        if (msg.error != null) p.reject(Error(msg.error));
        else p.resolve(msg.result);
        return;
      }
    }
  }

  close(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    for (const p of this.pending.values()) p.reject(Error("closed"));
    this.pending.clear();
    this.emit("closed");
    this.removeAllListeners();
  }

  private setEntry(e: WidgetStateEntry): boolean {
    if (e == null || typeof e.model_id !== "string") return false;
    if (!["state", "value", "buffers"].includes(e.type)) return false;
    const key = changeKey(e.model_id, e.type);
    if (e.data == null) this.table.delete(key);
    else this.table.set(key, e.data);
    return true;
  }

  private get(model_id: string, type: EntryType): any {
    return this.table.get(changeKey(model_id, type));
  }

  get_state(): "init" | "ready" | "closed" {
    return this.state;
  }

  keys(): { model_id: string; type: EntryType }[] {
    const keys: { model_id: string; type: EntryType }[] = [];
    for (const key of this.table.keys()) {
      const [, model_id, type] = JSON.parse(key);
      keys.push({ model_id, type });
    }
    return keys;
  }

  getSerializedModelState(model_id: string) {
    if (this.state !== "ready") return;
    const state = this.get(model_id, "state");
    if (state == null) return;
    return { ...copy(state), ...copy(this.get(model_id, "value") ?? {}) };
  }

  get_model_value(model_id: string): { [key: string]: any } {
    return copy(this.get(model_id, "value")) ?? {};
  }

  // The same shallow merge IpywidgetsState does, locally, and the change
  // itself to the relay (which merges it the same way).
  set_model_value(
    model_id: string,
    value: { [key: string]: any },
    fire_change_event: boolean = true,
  ): void {
    if (this.state !== "ready") return;
    const current = this.get_model_value(model_id);
    for (const k in value) {
      if (isObject(value[k]) && isObject(current[k])) {
        current[k] = { ...current[k], ...value[k] };
      } else {
        current[k] = value[k];
      }
    }
    this.table.set(changeKey(model_id, "value"), current);
    this.port.postMessage({ type: "setModelValue", model_id, changed: value });
    if (fire_change_event) {
      this.emit("change", [changeKey(model_id, "value")]);
    }
  }

  // The relay saves.
  async save(): Promise<void> {}

  async getModelBuffers(
    model_id: string,
  ): Promise<{ buffer_paths: string[][]; buffers: ArrayBuffer[] }> {
    const none = { buffer_paths: [], buffers: [] };
    if (this.get(model_id, "buffers") == null) return none;
    const result = await this.request({ type: "getBuffers", model_id });
    return result ?? none;
  }

  // The latest custom message of a model, delivered once.
  async getMessage(model_id: string) {
    const x = this.messages.get(model_id);
    this.messages.delete(model_id);
    return x;
  }

  private request(req: { type: "getBuffers"; model_id: string }) {
    const id = this.nextRequestId++;
    return new Promise<any>((resolve, reject) => {
      if (this.state === "closed") {
        reject(Error("closed"));
        return;
      }
      this.pending.set(id, { resolve, reject });
      this.port.postMessage({ ...req, id });
    });
  }
}
