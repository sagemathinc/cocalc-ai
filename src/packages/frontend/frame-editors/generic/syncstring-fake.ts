/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Used to make code cleaner without having to have lots of cases
// depending on whether syncstring is defined or undefined.
import { EventEmitter } from "events";

import { Map } from "immutable";

import { delay } from "awaiting";

type FakeDbDocument = {
  get?: (where?: unknown) => unknown[];
  get_one?: (where?: unknown) => unknown;
  set?: (obj: unknown) => FakeDbDocument;
  delete?: (where?: unknown) => FakeDbDocument;
  to_str?: () => string;
};

export class FakeSyncstring extends EventEmitter {
  _string_id: string = "";
  public readonly is_fake = true;
  private value: string;
  private readOnly: boolean;
  private state: "loading" | "ready" | "closed";

  constructor({
    value = "",
    readOnly = false,
    autoReady = true,
  }: {
    value?: string;
    readOnly?: boolean;
    autoReady?: boolean;
  } = {}) {
    super();
    this.value = value;
    this.readOnly = readOnly;
    this.state = autoReady ? "loading" : "loading";
    if (autoReady) {
      this.init();
    }
  }

  async init() {
    await delay(0); // wait, so 'ready' event can be listened to.
    this.setReady();
  }

  setReady(err?: Error) {
    this.state = err == null ? "ready" : "closed";
    this.emit("ready", err);
  }

  hasFullHistory = () => true;

  close() {}

  from_str(value: string) {
    this.value = value;
  }

  to_str(): string {
    return this.value;
  }

  exit_undo_mode() {}

  in_undo_mode() {}

  undo() {
    return this;
  }

  redo() {
    return this;
  }

  commit() {}

  is_read_only(): boolean {
    return this.readOnly;
  }

  get_state(): string {
    return this.state;
  }

  versions(): string[] {
    return [];
  }

  has_uncommitted_changes(): boolean {
    return false;
  }
  has_unsaved_changes(): boolean {
    return false;
  }

  hash_of_saved_version(): number {
    return 0;
  }

  save_to_disk(cb): void {
    if (cb) {
      cb();
    }
  }

  save(cb) {
    if (cb) {
      cb();
    }
  }

  _save(cb) {
    if (cb) {
      cb();
    }
  }

  get_settings(): Map<string, any> {
    return Map();
  }

  set_settings(_: object): void {}

  set_cursor_locs(_): void {}
}

export class FakeSyncdb extends EventEmitter {
  public readonly is_fake = true;
  public opts: Record<string, unknown>;
  private doc: FakeDbDocument;
  private readOnly: boolean;
  private state: "loading" | "ready" | "closed" = "loading";
  private fromString: (value: string) => FakeDbDocument;

  constructor({
    fromString,
    readOnly = true,
    opts = {},
  }: {
    fromString: (value: string) => FakeDbDocument;
    readOnly?: boolean;
    opts?: Record<string, unknown>;
  }) {
    super();
    this.fromString = fromString;
    this.readOnly = readOnly;
    this.opts = opts;
    this.doc = fromString("");
  }

  setReady(err?: Error) {
    this.state = err == null ? "ready" : "closed";
    this.emit("ready", err);
  }

  hasFullHistory = () => true;

  close() {
    this.state = "closed";
    this.removeAllListeners();
  }

  isClosed(): boolean {
    return this.state === "closed";
  }

  from_str(value: string) {
    this.doc = this.fromString(value);
  }

  to_str(): string {
    return this.doc.to_str?.() ?? "";
  }

  get(where?: unknown): unknown[] {
    return this.doc.get?.(where) ?? [];
  }

  get_one(where?: unknown): unknown {
    return this.doc.get_one?.(where);
  }

  set(obj: unknown): this {
    if (!this.readOnly) {
      const next = this.doc.set?.(obj);
      if (next != null) {
        this.doc = next;
      }
    }
    return this;
  }

  delete(where?: unknown): this {
    if (!this.readOnly) {
      const next = this.doc.delete?.(where);
      if (next != null) {
        this.doc = next;
      }
    }
    return this;
  }

  commit() {}

  is_read_only(): boolean {
    return this.readOnly;
  }

  get_state(): string {
    return this.state;
  }

  has_uncommitted_changes(): boolean {
    return false;
  }

  has_unsaved_changes(): boolean {
    return false;
  }

  hash_of_saved_version(): number {
    return 0;
  }

  save_to_disk(cb): void {
    cb?.();
  }

  save(cb) {
    cb?.();
  }

  _save(cb) {
    cb?.();
  }

  get_settings(): Map<string, any> {
    return Map();
  }

  set_settings(_: object): void {}

  set_cursor_locs(_): void {}
}
