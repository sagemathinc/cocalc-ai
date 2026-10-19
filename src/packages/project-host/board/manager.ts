/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The single writer between a Sagebrush board's file and its live document.

foo.board.json is the only thing on disk: canonical, pretty-printed JSON
(Sagebrush's canonical()). While the board is open, its live document is a
syncdb of the board's records (type, page, id), as a notebook's is a syncdb
of its cells. Browsers edit only the syncdb; this manager, one per open
board on the project host, is the only thing that writes the file:

- On start it loads the file into the syncdb. A syncdb that already holds
  the board (it was open before) is brought to the file's state, since the
  file is the official version.
- After the document changes it saves, debounced, and on demand: the file
  gets canonical(fromRecords(records)), only if that differs from what is
  on disk, so an open board nobody edits never rewrites its file.
- It follows the file. A change made by someone else (an agent, git, an
  editor) is merged into the syncdb by records, as a three-way merge from
  the file's previous state, so a person typing in the same note at the
  same moment keeps their typing. Its own writes are recognized by their
  content and ignored.
- A file that is not a board (unparsable, or not a board) is never written
  over and never loaded: the syncdb is left as it was, and the status says
  so until the file is a board again.
*/

import { createHash } from "node:crypto";

export interface BoardLib {
  toRecords(doc: any): any[];
  fromRecords(records: any): any;
  canonical(doc: any): string;
  cleanDoc(doc: any): any;
  formatError(doc: any): string | null | undefined;
}

// The parts of an ImmerDB the manager uses.
export interface BoardSyncdb {
  // The current records document (patchflow's immer-db document), which
  // Sagebrush's fromRecords reads.
  get_doc(): any;
  // Set the document from a string of the doc's own format; with base, as
  // a change made from base, merged with whatever reached the document.
  from_str(value: string, opts?: { base?: string }): void;
  commit(): unknown;
  save?(): Promise<void>;
  on(event: "change", f: () => void): unknown;
  removeListener(event: "change", f: () => void): unknown;
}

export interface BoardFile {
  // The file's text, or undefined if it does not exist.
  read(): Promise<string | undefined>;
  write(text: string): Promise<void>;
  // Call onChange (any number of times) when the file may have changed.
  // Returns a function that stops watching.
  watch(onChange: () => void): () => void;
}

export type BoardStatus =
  | { state: "ok"; bytes: number }
  | { state: "invalid"; message: string }
  | { state: "missing" };

export interface BoardManagerOptions {
  lib: BoardLib;
  syncdb: BoardSyncdb;
  file: BoardFile;
  // The string a list of records has in the syncdb's format.
  recordsToString: (records: any[]) => string;
  saveDelayMs?: number;
  log?: (message: string, extra?: object) => void;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

type Parsed =
  | { ok: true; doc: any; records: any[] }
  | { ok: false; message: string };

export class BoardManager {
  private readonly lib: BoardLib;
  private readonly syncdb: BoardSyncdb;
  private readonly file: BoardFile;
  private readonly recordsToString: (records: any[]) => string;
  private readonly saveDelayMs: number;
  private readonly log: (message: string, extra?: object) => void;

  private status: BoardStatus = { state: "missing" };
  // The file's text as last read or written by this manager.
  private diskText: string | undefined = undefined;
  // The syncdb-format string of the records that text has: the base of a
  // three-way merge when the file changes.
  private diskRecords: string | undefined = undefined;
  // Hashes of what this manager wrote, so their watch events are ignored.
  private written = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private unwatch: (() => void) | undefined;
  // One load or save at a time, in order.
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(opts: BoardManagerOptions) {
    this.lib = opts.lib;
    this.syncdb = opts.syncdb;
    this.file = opts.file;
    this.recordsToString = opts.recordsToString;
    this.saveDelayMs = opts.saveDelayMs ?? 1000;
    this.log = opts.log ?? (() => {});
  }

  getStatus(): BoardStatus {
    return this.status;
  }

  async start(): Promise<void> {
    await this.run(() => this.loadFromDisk());
    this.syncdb.on("change", this.onDocumentChange);
    this.unwatch = this.file.watch(() => {
      void this.run(() => this.loadFromDisk()).catch((err) =>
        this.log("board: reading the changed file failed", { err: `${err}` }),
      );
    });
  }

  // Save now, if the document differs from the file.
  async save(): Promise<void> {
    this.clearSaveTimer();
    await this.run(() => this.saveToDisk());
  }

  // A final save, then stop following the document and the file.
  async close(): Promise<void> {
    if (this.closed) return;
    this.clearSaveTimer();
    this.syncdb.removeListener("change", this.onDocumentChange);
    this.unwatch?.();
    try {
      await this.run(() => this.saveToDisk());
    } finally {
      this.closed = true;
    }
  }

  private run<T>(step: () => Promise<T>): Promise<T> {
    const next = this.queue.then(step, step);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private onDocumentChange = (): void => {
    if (this.closed) return;
    this.clearSaveTimer();
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.run(() => this.saveToDisk()).catch((err) =>
        this.log("board: saving failed", { err: `${err}` }),
      );
    }, this.saveDelayMs);
    (this.saveTimer as any).unref?.();
  };

  private clearSaveTimer(): void {
    if (this.saveTimer != null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
  }

  private parse(text: string): Parsed {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      return { ok: false, message: `not JSON: ${err}`.slice(0, 500) };
    }
    const error = this.lib.formatError(raw);
    if (error) return { ok: false, message: `${error}`.slice(0, 500) };
    const doc = this.lib.cleanDoc(raw);
    return { ok: true, doc, records: this.lib.toRecords(doc) };
  }

  private documentText(): string {
    return this.lib.canonical(this.lib.fromRecords(this.syncdb.get_doc()));
  }

  // Bring the syncdb to the file's state, merging what changed in the file
  // since this manager last saw it with what changed in the document.
  private async loadFromDisk(): Promise<void> {
    if (this.closed) return;
    const text = await this.file.read();
    if (text === undefined) {
      this.status = { state: "missing" };
      return;
    }
    if (text === this.diskText) return;
    if (this.written.has(sha256(text))) {
      // This manager wrote it: the document already has it.
      this.diskText = text;
      return;
    }
    const parsed = this.parse(text);
    if (!parsed.ok) {
      // What is on disk now, so that the file becoming a board again, even
      // the same one as before, is read; the records stay the merge base.
      this.diskText = text;
      this.status = { state: "invalid", message: parsed.message };
      this.log("board: the file is not a board", { message: parsed.message });
      return;
    }
    const value = this.recordsToString(parsed.records);
    // The first load: the file's state replaces whatever the syncdb held
    // (the document from an earlier session, or nothing). Later: a
    // three-way merge from the file's previous state.
    const base =
      this.diskRecords ?? this.recordsToString(this.currentRecords());
    if (value !== base || this.diskRecords === undefined) {
      this.syncdb.from_str(value, { base });
      this.syncdb.commit();
      await this.syncdb.save?.();
    }
    this.diskText = text;
    this.diskRecords = value;
    this.status = { state: "ok", bytes: Buffer.byteLength(text) };
  }

  private currentRecords(): any[] {
    const doc = this.syncdb.get_doc();
    const records = doc?.get?.({}) ?? [];
    return typeof records.toJS === "function" ? records.toJS() : [...records];
  }

  private async saveToDisk(): Promise<void> {
    if (this.closed || this.status.state === "invalid") return;
    if (this.diskRecords === undefined) return; // nothing was ever loaded
    // A change to the file not yet seen is merged first, never overwritten.
    const onDisk = await this.file.read();
    if (onDisk !== undefined && onDisk !== this.diskText) {
      await this.loadFromDisk();
      if (this.status.state !== "ok") return;
    }
    const text = this.documentText();
    if (text === this.diskText) return;
    this.written.add(sha256(text));
    if (this.written.size > 16) {
      this.written.delete(this.written.values().next().value as string);
    }
    await this.file.write(text);
    this.diskText = text;
    this.diskRecords = this.recordsToString(this.parseRecords(text));
    this.status = { state: "ok", bytes: Buffer.byteLength(text) };
  }

  private parseRecords(text: string): any[] {
    const parsed = this.parse(text);
    if (!parsed.ok)
      throw Error(`saved board is not a board: ${parsed.message}`);
    return parsed.records;
  }
}
