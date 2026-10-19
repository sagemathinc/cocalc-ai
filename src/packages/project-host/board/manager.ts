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
- A write replaces the file only if it is still exactly the text this
  manager last read or wrote, and never creates it (service.ts,
  replaceBoardFile: the file is renamed aside, checked, and the new text
  renamed in only if the name is still free). Every version another writer
  produced is kept: at the board's name, put back, or as a conflict copy.
  A save that finds another version is a conflict: the manager merges it,
  or stops. So a manager that lost the board (a later owner wrote, or the
  file was deleted) cannot write it.
- Everything about what would be written is checked before writing: size,
  format and record count.
- It follows the file. A change made by someone else (an agent, git, an
  editor), including a restore of an earlier version, is merged into the
  syncdb by records, as a three-way merge from the file's previous state,
  so a person typing in the same note at the same moment keeps their
  typing. A change is anything that is not the text this manager last read
  or wrote. Watch events are coalesced: at most one load runs and one waits,
  at most one per loadIntervalMs.
- A file that is not a board (unparsable, or not a board) or is over the
  limits is never loaded and never written over: the syncdb is left as it
  was, and the status says so until the file changes.
- A file that disappears after it was loaded (deleted or moved) retires the
  manager: it never writes again, and the status says so. So does a live
  document grown past what a host keeps for a board (hardMaxBytes,
  hardMaxRecords): its host closes it, and it reopens from its file.
*/

import {
  BOARD_EDITABLE_LIMIT,
  BOARD_HOST_RECORD_LIMIT,
} from "@cocalc/util/board/names";

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
  // The file's size and kind (not following a symbolic link), or
  // undefined if it does not exist.
  info(): Promise<BoardFileInfo | undefined>;
  // The file's text, reading at most maxBytes + 1 bytes: a larger file is
  // never allocated whole. undefined if it does not exist.
  read(maxBytes: number): Promise<BoardRead | undefined>;
  // Replace the file's text, only if it is exactly expected now; never
  // create it. "conflict" if it is not (it changed, or is gone).
  replace(text: string, expected: string): Promise<"ok" | "conflict">;
  // Call onChange (any number of times) when the file may have changed.
  // Returns a function that stops watching.
  watch(onChange: () => void): () => void;
}

export interface BoardFileInfo {
  size: number;
  // Hard links to the file (1 for an ordinary file).
  links: number;
  symlink: boolean;
}

export type BoardRead =
  | { text: string }
  // Over maxBytes (it grew after info()).
  | { tooLarge: true }
  // Not a file this board may be read from (not a regular file, or no
  // longer the board's identity).
  | { refused: string };

export type BoardStatus =
  | { state: "ok"; bytes: number }
  | { state: "invalid"; message: string }
  | { state: "missing"; message?: string }
  | { state: "too-large"; message: string; bytes?: number };

export interface BoardManagerOptions {
  lib: BoardLib;
  syncdb: BoardSyncdb;
  file: BoardFile;
  // The string a list of records has in the syncdb's format.
  recordsToString: (records: any[]) => string;
  saveDelayMs?: number;
  // At most one load from the file per this many ms.
  loadIntervalMs?: number;
  // Over these the board is not loaded or saved (it is "too-large"), but a
  // document that shrinks back under them saves again.
  maxBytes?: number;
  maxRecords?: number;
  // A document over these (default twice the above) is more than a host
  // keeps for a board: the manager retires, its host closes it, and the
  // board reopens from its file.
  hardMaxBytes?: number;
  hardMaxRecords?: number;
  log?: (message: string, extra?: object) => void;
}

// A write that loses its compare-and-swap reloads and tries again, at most
// this many times; then it waits for the next change.
const MAX_SAVE_ATTEMPTS = 3;

type Parsed =
  | { ok: true; doc: any; records: any[] }
  | { ok: false; status: BoardStatus };

export class BoardManager {
  private readonly lib: BoardLib;
  private readonly syncdb: BoardSyncdb;
  private readonly file: BoardFile;
  private readonly recordsToString: (records: any[]) => string;
  private readonly saveDelayMs: number;
  private readonly loadIntervalMs: number;
  private readonly maxBytes: number;
  private readonly maxRecords: number;
  private readonly hardMaxBytes: number;
  private readonly hardMaxRecords: number;
  private readonly log: (message: string, extra?: object) => void;

  private status: BoardStatus = { state: "missing" };
  // The file's text as last read or written by this manager: the only
  // text a write may replace.
  private diskText: string | undefined = undefined;
  // The syncdb-format string of the records the file last had as a board:
  // the base of a three-way merge when the file changes.
  private diskRecords: string | undefined = undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private loadTimer: ReturnType<typeof setTimeout> | undefined;
  // A load is waiting (in loadTimer or the queue) and has not started.
  private loadWaiting = false;
  private lastLoadStart = 0;
  // A save is waiting in the queue and has not started.
  private pendingSave: Promise<void> | undefined;
  private unwatch: (() => void) | undefined;
  // One load or save at a time, in order.
  private queue: Promise<unknown> = Promise.resolve();
  // Closing: no new work but the final save.
  private stopping = false;
  // Closed or revoked: no work at all.
  private closed = false;
  // The file was deleted or moved: never written again.
  private retired = false;
  private retireListeners: (() => void)[] = [];

  constructor(opts: BoardManagerOptions) {
    this.lib = opts.lib;
    this.syncdb = opts.syncdb;
    this.file = opts.file;
    this.recordsToString = opts.recordsToString;
    this.saveDelayMs = opts.saveDelayMs ?? 1000;
    this.loadIntervalMs = opts.loadIntervalMs ?? 250;
    this.maxBytes = opts.maxBytes ?? BOARD_EDITABLE_LIMIT;
    this.maxRecords = opts.maxRecords ?? BOARD_HOST_RECORD_LIMIT;
    this.hardMaxBytes = opts.hardMaxBytes ?? 2 * this.maxBytes;
    this.hardMaxRecords = opts.hardMaxRecords ?? 2 * this.maxRecords;
    this.log = opts.log ?? (() => {});
  }

  getStatus(): BoardStatus {
    return this.status;
  }

  // The file was deleted or moved while the board was open: this manager
  // never writes again, and the board needs a new one.
  isRetired(): boolean {
    return this.retired;
  }

  async start(): Promise<void> {
    await this.run(() => this.loadFromDisk());
    if (this.stopping || this.closed) return;
    this.syncdb.on("change", this.onDocumentChange);
    this.unwatch = this.file.watch(this.requestLoad);
  }

  // Save now, if the document differs from the file. Calls made while a
  // save waits share it.
  save(): Promise<void> {
    this.clearSaveTimer();
    return this.queueSave();
  }

  // A final save, then stop following the document and the file.
  async close(): Promise<void> {
    if (this.stopping || this.closed) return await this.settled();
    this.stopWork();
    try {
      await this.run(() => this.saveToDisk());
    } finally {
      this.closed = true;
    }
  }

  // Stop at once: no step that has not started runs, and none writes
  // after this (a write already in the storage completes or fails by its
  // compare-and-swap). For a close that does not finish in time.
  revoke(): void {
    this.stopWork();
    this.closed = true;
  }

  // Resolves when no step runs or waits.
  async settled(): Promise<void> {
    let queue: Promise<unknown>;
    do {
      queue = this.queue;
      await queue;
    } while (queue !== this.queue);
  }

  private stopWork(): void {
    this.stopping = true;
    this.clearSaveTimer();
    if (this.loadTimer != null) {
      clearTimeout(this.loadTimer);
      this.loadTimer = undefined;
    }
    this.loadWaiting = false;
    this.syncdb.removeListener("change", this.onDocumentChange);
    this.unwatch?.();
    this.unwatch = undefined;
  }

  private run<T>(step: () => Promise<T>): Promise<T> {
    const next = this.queue.then(step, step);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private queueSave(): Promise<void> {
    if (this.pendingSave == null) {
      const pending = this.run(async () => {
        if (this.pendingSave === pending) this.pendingSave = undefined;
        await this.saveToDisk();
      });
      this.pendingSave = pending;
    }
    return this.pendingSave;
  }

  // The file may have changed: load it, coalesced and rate limited. A load
  // reads the file when it starts, so one waiting load covers every event
  // before it starts.
  private requestLoad = (): void => {
    if (this.loadWaiting || this.stopping || this.closed) return;
    this.loadWaiting = true;
    const delay = Math.max(
      0,
      this.lastLoadStart + this.loadIntervalMs - Date.now(),
    );
    this.loadTimer = setTimeout(() => {
      this.loadTimer = undefined;
      void this.run(async () => {
        this.loadWaiting = false;
        this.lastLoadStart = Date.now();
        await this.loadFromDisk();
      }).catch((err) =>
        this.log("board: reading the changed file failed", { err: `${err}` }),
      );
    }, delay);
    (this.loadTimer as any).unref?.();
  };

  private onDocumentChange = (): void => {
    if (this.stopping || this.closed) return;
    this.clearSaveTimer();
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.queueSave().catch((err) =>
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

  private tooLarge(bytes: number): BoardStatus {
    return {
      state: "too-large",
      bytes,
      message: `the board is ${bytes} bytes, over the ${this.maxBytes} a board can be edited at`,
    };
  }

  private tooManyRecords(count: number): BoardStatus {
    return {
      state: "too-large",
      message: `the board has ${count} records, over the ${this.maxRecords} a board can be edited with here, so it opens read-only`,
    };
  }

  // Parse a board, refusing more than maxRecords records.
  private parse(text: string, maxRecords = this.maxRecords): Parsed {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      const message = `not JSON: ${err}`.slice(0, 500);
      return { ok: false, status: { state: "invalid", message } };
    }
    const error = this.lib.formatError(raw);
    if (error) {
      const message = `${error}`.slice(0, 500);
      return { ok: false, status: { state: "invalid", message } };
    }
    const doc = this.lib.cleanDoc(raw);
    const records = this.lib.toRecords(doc);
    if (records.length > maxRecords) {
      return { ok: false, status: this.tooManyRecords(records.length) };
    }
    return { ok: true, doc, records };
  }

  // Read the file, never allocating more than the limit. undefined: the
  // status says why not.
  private async readBounded(): Promise<string | undefined> {
    const info = await this.file.info();
    if (info !== undefined && (info.symlink || info.links > 1)) {
      // Another name for the file would be another board with its own
      // writer: a board is one ordinary file.
      this.diskText = undefined;
      this.status = {
        state: "invalid",
        message: info.symlink
          ? "the board's file was replaced by a symbolic link"
          : "the board's file has other hard links",
      };
      return;
    }
    if (info !== undefined && info.size > this.maxBytes) {
      this.diskText = undefined;
      this.status = this.tooLarge(info.size);
      return;
    }
    const read =
      info === undefined ? undefined : await this.file.read(this.maxBytes);
    if (read === undefined) {
      this.fileGone();
      return;
    }
    if ("tooLarge" in read) {
      // It grew between info() and the read, which stopped at the limit.
      this.diskText = undefined;
      this.status = this.tooLarge(this.maxBytes + 1);
      return;
    }
    if ("refused" in read) {
      this.diskText = undefined;
      this.status = { state: "invalid", message: read.refused };
      return;
    }
    return read.text;
  }

  // No file. One this manager had loaded was deleted or moved: retire.
  private fileGone(): void {
    this.diskText = undefined;
    if (this.diskRecords !== undefined) {
      this.retire({
        state: "missing",
        message: "the board was deleted or moved",
      });
    } else {
      this.status = { state: "missing" };
    }
  }

  private documentText(): string {
    return this.lib.canonical(this.lib.fromRecords(this.syncdb.get_doc()));
  }

  // Bring the syncdb to the file's state, merging what changed in the file
  // since this manager last saw it with what changed in the document.
  private async loadFromDisk(): Promise<void> {
    if (this.closed || this.retired) return;
    const text = await this.readBounded();
    if (this.closed || text === undefined) return;
    if (text === this.diskText) return;
    const parsed = this.parse(text);
    if (!parsed.ok) {
      // Nothing is written until the file changes; the records stay the
      // merge base.
      this.diskText = undefined;
      this.status = parsed.status;
      this.log("board: the file is not loaded", parsed.status);
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
    for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt++) {
      if (this.closed || this.retired) return;
      // Nothing loaded, or the file is not one this manager may replace (not
      // a board, too large, gone).
      if (this.diskText === undefined) return;
      const text = this.documentText();
      const bytes = Buffer.byteLength(text);
      if (bytes > this.hardMaxBytes) {
        this.retire(this.tooLarge(bytes));
        return;
      }
      if (bytes > this.maxBytes) {
        this.status = this.tooLarge(bytes);
        return;
      }
      if (text === this.diskText) {
        this.status = { state: "ok", bytes };
        return;
      }
      // All of what would be written is checked before it is: the format
      // and the record limit, not just the size.
      const parsed = this.parse(text, this.hardMaxRecords);
      if (!parsed.ok) {
        this.retire(parsed.status);
        return;
      }
      if (parsed.records.length > this.maxRecords) {
        this.status = this.tooManyRecords(parsed.records.length);
        return;
      }
      if ((await this.file.replace(text, this.diskText)) === "ok") {
        this.diskText = text;
        this.diskRecords = this.recordsToString(parsed.records);
        this.status = { state: "ok", bytes };
        return;
      }
      // The file is not what this manager last saw: never write over it.
      // Merge it (or learn it is not a board, or gone), then try again.
      this.log("board: the file changed under a save; merging it first");
      await this.loadFromDisk();
    }
  }

  // Stop for good: the file went away, or the document grew past what a
  // host keeps for a board (it reopens from its file).
  private retire(status: BoardStatus): void {
    this.status = status;
    if (this.retired) return;
    this.retired = true;
    this.log("board: retired", status);
    for (const f of this.retireListeners) {
      try {
        f();
      } catch {}
    }
  }

  // Call f when this manager retires.
  onRetire(f: () => void): void {
    if (this.retired) {
      f();
      return;
    }
    this.retireListeners.push(f);
  }
}
