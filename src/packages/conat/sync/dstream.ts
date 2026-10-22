/*
Eventually Consistent Distributed Message Stream

DEVELOPMENT:


# in node -- note the package directory!!
~/cocalc/src/packages/backend node

> s = await require("@cocalc/backend/conat/sync").dstream({name:'test'});
> s = await require("@cocalc/backend/conat/sync").dstream({project_id:cc.current().project_id,name:'foo'});0

See the guide for dkv, since it's very similar, especially for use in a browser.
*/

import { EventEmitter } from "events";
import {
  CoreStream,
  type CoreStreamInitPhaseReporter,
  type RawMsg,
  type ChangeEvent,
  type HistoryGapEvent,
  type PublishOptions,
  type Configuration,
  type RecoveryState,
  type User,
} from "./core-stream";
import type {
  CheckpointUpdate,
  StreamCheckpoints,
} from "@cocalc/conat/persist/storage";
import { randomId } from "@cocalc/conat/names";
import { reuseInFlight } from "@cocalc/util/reuse-in-flight";
import { isNumericString } from "@cocalc/util/misc";
import refCache from "@cocalc/util/refcache";
import {
  type Client,
  type Headers,
  ConatError,
} from "@cocalc/conat/core/client";
import jsonStableStringify from "json-stable-stringify";
import type { JSONValue } from "@cocalc/util/types";
import { delay } from "awaiting";
import {
  asyncThrottle,
  cancel_scheduled,
  until,
} from "@cocalc/util/async-utils";
import {
  inventory,
  inventoryUpdatesDisabled,
  type Inventory,
  INVENTORY_UPDATE_INTERVAL,
} from "./inventory";
import { getLogger } from "@cocalc/conat/logger";
import { abortable } from "@cocalc/conat/core/abort";

const logger = getLogger("sync:dstream");

export interface DStreamOptions {
  // what it's called by us
  name: string;
  account_id?: string;
  project_id?: string;
  host_id?: string;
  config?: Partial<Configuration>;
  // only load historic messages starting at the given seq number.
  start_seq?: number;
  start_checkpoint?: string;
  // see CoreStreamOptions.start_instance
  start_instance?: string | null;
  desc?: JSONValue;

  client?: Client;
  noAutosave?: boolean;
  ephemeral?: boolean;
  sync?: boolean;
  bootstrapRetry?: boolean;

  noCache?: boolean;
  noInventory?: boolean;

  service?: string;
  persistUser?: User;

  initPhaseReporter?: CoreStreamInitPhaseReporter;
}

function requireDstreamClient(
  options: DStreamOptions,
  name: string,
): DStreamOptions & { client: Client } {
  if (options.client == null) {
    throw Error(`${name}: client must be specified`);
  }
  return options as DStreamOptions & { client: Client };
}

const RECEIVED_THROUGH_MAX_STEPS = 10_000;

// the persist server's refusal of a write from an older history epoch (see
// PersistentStream.checkRequiredHeaders)
function isHistoryFenceRejection(error: unknown): boolean {
  return `${error ?? ""}`.includes("required header mismatch");
}

export class DStream<T = any> extends EventEmitter {
  public readonly name: string;
  private stream: CoreStream;
  private messages: T[];
  private raw: RawMsg[];
  private noAutosave: boolean;
  // TODO: using Map for these will be better because we use .length a bunch, which is O(n) instead of O(1).
  private local: { [id: string]: T } = {};
  private publishOptions: {
    [id: string]: {
      headers?: Headers;
      ttl?: number;
      checkpoint?: CheckpointUpdate;
    };
  } = {};
  private saved: { [seq: number]: T } = {};
  // Messages the history fence refused (they were written for an epoch the
  // history has moved past).  Kept, not dropped, until the owner (SyncDoc)
  // has saved them elsewhere: see pendingMessages and forgetRejected.
  private rejected: { [id: string]: T } = {};
  // running totals of local plus rejected, so their size is known in O(1)
  private pendingCount = 0;
  private pendingBytes = 0;
  private sizeOf: (mesg: T) => number = () => 0;
  private opts: DStreamOptions;
  private lastHasUnsavedChanges = false;
  // The files of this (disk-backed) stream were replaced under it: nothing
  // more is written (see handleInstanceReset).
  private replaced = false;
  // its owner handles a replacement itself (keepOpenWhenReplaced)
  private keepWhenReplaced = false;
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(opts: DStreamOptions) {
    super();
    logger.debug("constructor", opts.name);
    if (opts.client == null) {
      throw Error("client must be specified");
    }
    this.opts = opts;
    this.noAutosave = !!opts.noAutosave;
    this.name = opts.name;
    this.stream = new CoreStream(opts);
    this.messages = this.stream.messages;
    this.raw = this.stream.raw;
    return new Proxy(this, {
      get(target, prop) {
        return typeof prop == "string" && isNumericString(prop)
          ? target.get(parseInt(prop))
          : target[String(prop)];
      },
    });
  }

  private initialized = false;
  init = async () => {
    if (this.initialized) {
      throw Error("init can only be called once");
    }
    this.initialized = true;
    if (this.isClosed()) {
      throw Error("closed");
    }
    this.stream.on("change", this.handleChange);
    this.stream.on("metadata-change", this.handleMetadataChange);
    this.stream.on("checkpoints-change", this.handleCheckpointsChange);
    this.stream.on("history-gap", this.handleHistoryGap);
    this.stream.on("instance-reset", this.handleInstanceReset);
    this.stream.on("recovery-state", this.handleRecoveryState);
    this.stream.on("disconnected", this.handleDisconnected);
    this.stream.on("recovering", this.handleRecovering);
    this.stream.on("paused", this.handlePaused);
    this.stream.on("recovered", this.handleRecovered);
    this.stream.on("reset", () => {
      this.local = {};
      this.saved = {};
      this.updateHasUnsavedChanges();
    });
    await this.stream.init();
    this.emit("connected");
  };

  private handleChange = ({ mesg, raw, msgID }: ChangeEvent<T>) => {
    if (raw?.seq !== undefined) {
      delete this.saved[raw.seq];
    }
    if (mesg === undefined) {
      return;
    }
    if (msgID) {
      // this is critical with core-stream.ts, since otherwise there is a moment
      // when the same message is in both this.local *and* this.messages, and you'll
      // see it doubled in this.getAll().
      this.deleteLocal(msgID);
      this.updateHasUnsavedChanges();
    }
    this.emit("change", mesg, raw?.seq);
    if (this.isStable()) {
      this.emit("stable");
    }
  };

  private handleMetadataChange = (metadata?: JSONValue) => {
    this.emit("metadata-change", metadata);
  };

  private handleCheckpointsChange = (checkpoints: StreamCheckpoints) => {
    this.emit("checkpoints-change", checkpoints);
  };

  private handleHistoryGap = (info: HistoryGapEvent) => {
    this.emit("history-gap", info);
  };

  // The ephemeral stream's server lost it and numbers messages from 1 again
  // (see CoreStream.resetForNewPersistInstance); emitted before any of the new
  // messages.  Unsaved local messages stay and are written to the new one.
  //
  // A disk-backed stream resets when its files were replaced, e.g., by a
  // restore (conat/persist/fence.ts).  What this copy has not saved was based
  // on the replaced history, so it is never written to the new one.  Then
  // the stream closes, so an owner that checks isClosed() opens it again and
  // one that publishes to it gets an error, never a message silently lost;
  // what it had not saved is dropped.  An owner that handles the replacement
  // itself (SyncDoc, see keepOpenWhenReplaced) keeps it open instead: what it
  // had not saved is kept for the owner like messages the history fence
  // refused (pendingMessages), and so is everything published from now on;
  // the owner saves it elsewhere and opens the stream again.
  private handleInstanceReset = (instance?: string | null) => {
    this.saved = {};
    if (!this.opts.ephemeral) {
      this.replaced = true;
      for (const id in this.local) {
        this.rejected[id] = this.local[id];
        delete this.publishOptions[id];
      }
      this.local = {};
      this.updateHasUnsavedChanges();
    }
    this.emit("instance-reset", instance);
    if (this.replaced && !this.keepWhenReplaced && !this.isClosed()) {
      const dropped = Object.keys(this.rejected).length;
      logger.warn("closing a stream whose history was replaced", {
        name: this.name,
        ...(dropped ? { dropped } : {}),
      });
      this.closeNow();
    }
  };

  // For an owner that handles a replacement of the stream's history itself
  // (see handleInstanceReset): the stream then stays open.
  keepOpenWhenReplaced = (): void => {
    this.keepWhenReplaced = true;
  };

  private handleRecoveryState = (state: RecoveryState) => {
    this.emit("recovery-state", state);
  };

  private handleDisconnected = () => {
    this.emit("disconnected");
  };

  private handleRecovering = () => {
    this.emit("recovering");
  };

  private handlePaused = () => {
    this.emit("paused");
  };

  private handleRecovered = () => {
    this.emit("recovered");
  };

  isStable = () => {
    for (const _ in this.saved) {
      return false;
    }
    for (const _ in this.local) {
      return false;
    }
    return true;
  };

  isClosed = () => {
    return this.stream == null;
  };

  close = (): void | Promise<void> => {
    if (this.closePromise != null) {
      return this.closePromise;
    }
    if (this.isClosed()) {
      return;
    }
    if (this.noAutosave || !this.hasUnsavedChanges()) {
      this.closeNow();
      return;
    }
    // Autosave may still be waiting for transport admission. Do not tear down
    // its socket until queued batches are acknowledged, but bound shutdown.
    this.closing = true;
    cancel_scheduled(this.updateInventory);
    this.closePromise = this.flushAndClose();
    // Many callers intentionally do not await close. Still surface failures,
    // while preserving rejection for callers that do await it.
    void this.closePromise.catch((err) => {
      logger.warn("close: unable to finish autosave", this.name, err);
    });
    return this.closePromise;
  };

  private flushAndClose = async (): Promise<void> => {
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new ConatError("close autosave timeout", { code: 408 }),
        ),
      15_000,
    );
    try {
      await abortable(
        (async () => {
          // Joining the current batch alone would miss messages queued after
          // it started. No new writes are admitted once closing begins.
          while (this.hasUnsavedChanges()) {
            await this.attemptToSaveBatch();
          }
        })(),
        controller.signal,
      );
    } finally {
      clearTimeout(timer);
      this.closeNow();
    }
  };

  private closeNow = () => {
    if (this.isClosed()) {
      return;
    }
    logger.debug("close", this.name);
    cancel_scheduled(this.updateInventory);
    const stream = this.stream;
    stream.removeListener("change", this.handleChange);
    stream.removeListener("metadata-change", this.handleMetadataChange);
    stream.removeListener("checkpoints-change", this.handleCheckpointsChange);
    stream.removeListener("history-gap", this.handleHistoryGap);
    stream.removeListener("recovery-state", this.handleRecoveryState);
    stream.removeListener("disconnected", this.handleDisconnected);
    stream.removeListener("recovering", this.handleRecovering);
    stream.removeListener("paused", this.handlePaused);
    stream.removeListener("recovered", this.handleRecovered);
    // @ts-ignore
    delete this.stream;
    stream.close();
    this.emit("closed");
    this.removeAllListeners();
    // @ts-ignore
    delete this.local;
    // @ts-ignore
    delete this.messages;
    // @ts-ignore
    delete this.raw;
    // @ts-ignore
    delete this.opts;
  };

  get = (n?): T | T[] => {
    if (this.isClosed()) {
      throw Error("closed");
    }
    if (n == null) {
      return this.getAll();
    } else {
      if (n < this.messages.length) {
        return this.messages[n];
      }
      const v = Object.keys(this.saved);
      if (n < v.length + this.messages.length) {
        return this.saved[n - this.messages.length];
      }
      return Object.values(this.local)[n - this.messages.length - v.length];
    }
  };

  getAll = (): T[] => {
    if (this.isClosed()) {
      throw Error("closed");
    }
    return [
      ...this.messages,
      ...Object.values(this.saved),
      ...Object.values(this.local),
    ];
  };

  // sequence number of n-th message
  seq = (n: number): number | undefined => {
    if (n < this.raw.length) {
      return this.raw[n].seq;
    }
    const v = Object.keys(this.saved);
    if (n < v.length + this.raw.length) {
      return parseInt(v[n - this.raw.length]);
    }
  };

  // all sequences numbers of messages
  seqs = (): number[] => {
    const seqs = this.raw.map(({ seq }) => seq);
    for (const seq in this.saved) {
      seqs.push(parseInt(seq));
    }
    return seqs;
  };

  getMetadata = (): JSONValue | undefined => {
    if (this.isClosed()) {
      return undefined;
    }
    return this.stream.getMetadata();
  };

  setMetadata = async (
    metadata?: JSONValue,
  ): Promise<JSONValue | undefined> => {
    if (this.isClosed()) {
      return undefined;
    }
    return await this.stream.setMetadata(metadata);
  };

  patchMetadata = async (delta: JSONValue): Promise<JSONValue | undefined> => {
    if (this.isClosed()) {
      return undefined;
    }
    return await this.stream.patchMetadata(delta);
  };

  // Every message with seq at most this is in this stream's view: received
  // from the server, or published from here and acknowledged (see
  // CoreStream.receivedThroughSeq).  Steps past at most
  // RECEIVED_THROUGH_MAX_STEPS seqs beyond what the stream itself received
  // in order; a lower answer is always safe.
  receivedThroughSeq = (): number => {
    if (this.isClosed()) {
      return 0;
    }
    let through = this.stream.receivedThroughSeq();
    for (let i = 0; i < RECEIVED_THROUGH_MAX_STEPS; i++) {
      const next = through + 1;
      if (this.saved[next] === undefined && !this.stream.isReceivedSeq(next)) {
        break;
      }
      through = next;
    }
    return through;
  };

  getCheckpoints = (): StreamCheckpoints => {
    if (this.isClosed()) {
      return {};
    }
    return this.stream.getCheckpoints();
  };

  getCheckpoint = (name: string) => {
    if (this.isClosed()) {
      return;
    }
    return this.stream.getCheckpoint(name);
  };

  setCheckpoint = async (checkpoint: CheckpointUpdate) => {
    if (this.isClosed()) {
      return;
    }
    return await this.stream.setCheckpoint(checkpoint);
  };

  deleteCheckpoint = async (name: string): Promise<void> => {
    if (this.isClosed()) {
      return;
    }
    await this.stream.deleteCheckpoint(name);
  };

  getRecoveryState = (): RecoveryState => {
    if (this.isClosed()) {
      return "closed";
    }
    return this.stream.getRecoveryState();
  };

  pauseRecovery = (reason: string) => {
    if (this.isClosed()) {
      return;
    }
    this.stream.pauseRecovery(reason);
  };

  resumeRecovery = async (
    opts: {
      epoch?: number;
      force?: boolean;
      priority?: "foreground" | "background";
    } = {},
  ) => {
    if (this.isClosed()) {
      return;
    }
    await this.stream.resumeRecovery(opts);
  };

  /** Cheap fetch of missed updates, without reconnecting. */
  catchUp = async (opts: { timeout?: number } = {}): Promise<void> => {
    if (this.isClosed()) {
      return;
    }
    await this.stream.catchUp(opts);
  };

  recoverNow = async (
    opts: {
      epoch?: number;
      force?: boolean;
      priority?: "foreground" | "background";
      reason?: string;
    } = {},
  ) => {
    if (this.isClosed()) {
      return;
    }
    await this.stream.recoverNow(opts);
  };

  time = (n: number): Date | undefined => {
    if (this.isClosed()) {
      throw Error("not initialized");
    }
    return this.stream.time(n);
  };

  // all server assigned times of messages in the stream.
  times = (): (Date | undefined)[] => {
    if (this.isClosed()) {
      throw Error("not initialized");
    }
    return this.stream.times();
  };

  get length(): number {
    return (
      this.messages.length +
      Object.keys(this.saved).length +
      Object.keys(this.local).length
    );
  }

  publish = (
    mesg: T,
    // NOTE: if you call this.headers(n) it is NOT visible until
    // the publish is confirmed. This could be changed with more work if it matters.
    options?: {
      headers?: Headers;
      ttl?: number;
      checkpoint?: CheckpointUpdate;
    },
  ): void => {
    if (this.closing || this.isClosed()) {
      throw Error("closed");
    }
    const id = randomId();
    if (this.replaced) {
      // never written (see handleInstanceReset)
      this.rejected[id] = mesg;
      this.addPending(mesg);
      return;
    }
    this.local[id] = mesg;
    this.addPending(mesg);
    this.updateHasUnsavedChanges();
    if (options != null) {
      this.publishOptions[id] = options;
    }
    if (!this.noAutosave) {
      this.save();
    }
    this.updateInventory();
  };

  headers = (n) => {
    if (this.isClosed()) {
      throw Error("closed");
    }
    return this.stream.headers(n);
  };

  push = (...args: T[]) => {
    if (this.isClosed()) {
      throw Error("closed");
    }
    for (const mesg of args) {
      this.publish(mesg);
    }
  };

  private addPending = (mesg: T): void => {
    this.pendingCount += 1;
    this.pendingBytes += this.sizeOf(mesg);
  };

  private removePending = (mesg: T | undefined): void => {
    if (mesg === undefined) return;
    this.pendingCount -= 1;
    this.pendingBytes -= this.sizeOf(mesg);
  };

  private deleteLocal = (id: string): void => {
    if (this.local[id] === undefined) return;
    this.removePending(this.local[id]);
    delete this.local[id];
  };

  // How to size a pending message for pendingStats (e.g., its patch length).
  // Normally set before anything is published; whatever is pending already
  // is resized, so the totals stay exact.
  setPendingSizeOf = (sizeOf: (mesg: T) => number): void => {
    this.sizeOf = sizeOf;
    let bytes = 0;
    for (const id in this.local) bytes += sizeOf(this.local[id]);
    for (const id in this.rejected) bytes += sizeOf(this.rejected[id]);
    this.pendingBytes = bytes;
  };

  // The unsaved messages (not yet acknowledged, or refused by the history
  // fence), counted in O(1).
  pendingStats = (): { count: number; bytes: number } => ({
    count: this.pendingCount,
    bytes: this.pendingBytes,
  });

  // The unsaved messages with their ids (their msgIDs), in the order they
  // were published.  The caller bounds how many (see pendingStats).
  pendingMessages = (): { id: string; mesg: T; rejected: boolean }[] => {
    const v: { id: string; mesg: T; rejected: boolean }[] = [];
    for (const id in this.rejected) {
      v.push({ id, mesg: this.rejected[id], rejected: true });
    }
    for (const id in this.local) {
      v.push({ id, mesg: this.local[id], rejected: false });
    }
    return v;
  };

  // Forget the refused messages with these ids, once they are saved elsewhere.
  forgetRejected = (ids: string[]): void => {
    for (const id of ids) {
      if (this.rejected[id] === undefined) continue;
      this.removePending(this.rejected[id]);
      delete this.rejected[id];
    }
    this.updateHasUnsavedChanges();
  };

  // Whether this (disk-backed) stream's files were replaced under it, so it
  // writes nothing more (see handleInstanceReset).
  isReplaced = (): boolean => this.replaced;

  hasUnsavedChanges = (): boolean => {
    if (this.isClosed()) {
      return false;
    }
    return Object.keys(this.local).length > 0;
  };

  // Refused by the history fence and not yet saved elsewhere (not counted by
  // hasUnsavedChanges, which the save loop waits on: these are never retried).
  hasRejectedChanges = (): boolean => {
    if (this.isClosed()) {
      return false;
    }
    for (const _ in this.rejected) return true;
    return false;
  };

  private updateHasUnsavedChanges = (): void => {
    const hasUnsavedChanges = this.hasUnsavedChanges();
    if (hasUnsavedChanges === this.lastHasUnsavedChanges) {
      return;
    }
    this.lastHasUnsavedChanges = hasUnsavedChanges;
    this.emit("has-unsaved-changes", hasUnsavedChanges);
  };

  unsavedChanges = (): T[] => {
    return Object.values(this.local);
  };

  save = reuseInFlight(async () => {
    //console.log("save", this.noAutosave);
    await until(
      async () => {
        if (this.isClosed()) {
          return true;
        }
        try {
          await this.attemptToSave();
          //console.log("successfully saved");
        } catch {}
        return !this.hasUnsavedChanges();
      },
      { start: 150, decay: 1.3, max: 10000 },
    );
  });

  private attemptToSave = async () => {
    await this.attemptToSaveBatch();
  };

  private attemptToSaveBatch = reuseInFlight(async () => {
    if (this.isClosed()) {
      throw Error("closed");
    }
    const v: { mesg: T; options: PublishOptions }[] = [];
    const ids = Object.keys(this.local);
    for (const id of ids) {
      const mesg = this.local[id];
      const options = {
        ...this.publishOptions[id],
        msgID: id,
      };
      v.push({ mesg, options });
    }
    const w: (
      | { seq: number; time: number; error?: undefined }
      | { error: string; code?: any }
    )[] = await this.stream.publishMany(v);

    if (this.isClosed()) {
      return;
    }

    let errors = false;
    for (let i = 0; i < w.length; i++) {
      const id = ids[i];
      if (w[i].error) {
        const x = w[i] as { error: string; code?: any };
        if (x.code == "reject") {
          if (
            isHistoryFenceRejection(x.error) &&
            this.local[id] !== undefined
          ) {
            // keep it: it is unsaved data the owner must save elsewhere
            this.rejected[id] = this.local[id];
            delete this.local[id];
            // never retried
            delete this.publishOptions[id];
          } else {
            this.deleteLocal(id);
          }
          const err = new ConatError(x.error, { code: x.code });
          // err has mesg and subject set.
          this.emit("reject", { err, mesg: v[i].mesg });
        }
        if (!process.env.COCALC_TEST_MODE) {
          console.warn(
            `WARNING -- error saving dstream '${this.name}' -- ${w[i].error}`,
          );
        }
        errors = true;
        continue;
      }
      const { seq } = w[i] as { seq: number };
      if ((this.raw[this.raw.length - 1]?.seq ?? -1) < seq) {
        // it still isn't in this.raw
        this.saved[seq] = v[i].mesg;
      }
      this.deleteLocal(id);
      delete this.publishOptions[id];
    }
    this.updateHasUnsavedChanges();
    if (errors) {
      throw Error(`there were errors saving dstream '${this.name}'`);
    }
  });

  // load older messages starting at start_seq
  load = async (opts: { start_seq: number }) => {
    if (this.isClosed()) {
      throw Error("closed");
    }
    await this.stream.load(opts);
  };

  // this is not synchronous -- it makes sure everything is saved out,
  // then delete the persistent stream
  // NOTE: for ephemeral streams, other clients will NOT see the result of a delete (unless they reconnect).
  delete = async (opts?) => {
    await this.save();
    if (this.isClosed()) {
      throw Error("closed");
    }
    return await this.stream.delete(opts);
  };

  get start_seq(): number | undefined {
    return this.stream?.start_seq;
  }

  // see CoreStream.getPersistInstance
  getPersistInstance = (): string | null | undefined =>
    this.stream?.getPersistInstance();

  // get or set config
  config = async (
    config: Partial<Configuration> = {},
  ): Promise<Configuration> => {
    if (this.isClosed()) {
      throw Error("closed");
    }
    return await this.stream.config(config);
  };

  private updateInventory = asyncThrottle(
    async () => {
      if (
        this.isClosed() ||
        this.opts == null ||
        this.opts.noInventory ||
        inventoryUpdatesDisabled()
      ) {
        return;
      }
      await delay(500);
      if (this.isClosed()) {
        return;
      }
      let inv: Inventory | undefined = undefined;
      try {
        const { account_id, project_id, desc } = this.opts;
        inv = await inventory({
          account_id,
          project_id,
          service: this.opts.service,
          client: requireDstreamClient(this.opts, "DStream.updateInventory")
            .client,
        });
        if (this.isClosed()) {
          return;
        }
        const status = {
          type: "stream" as "stream",
          name: this.opts.name,
          desc,
          ...(await this.stream.inventory()),
        };
        inv.set(status);
      } catch (err) {
        if (!process.env.COCALC_TEST_MODE) {
          console.log(
            `WARNING: unable to update inventory.  name='${this.opts.name} -- ${err}'`,
          );
        }
      } finally {
        // @ts-ignore
        inv?.close();
      }
    },
    INVENTORY_UPDATE_INTERVAL,
    { leading: true, trailing: true },
  );
}

export const cache = refCache<DStreamOptions & { client: Client }, DStream>({
  name: "dstream",
  createKey: (options: DStreamOptions & { client: Client }) => {
    if (!options.name) {
      throw Error("name must be specified");
    }
    // Everything that decides what the stream may do and who it asks as:
    // a board stream opened through the board write service (as the hub)
    // and the same stream opened through the ordinary service are different
    // streams, never one cached for the other.
    const {
      name,
      account_id,
      project_id,
      host_id,
      service,
      persistUser,
      client,
    } = options;
    const id = client?.id;
    return jsonStableStringify({
      name,
      account_id,
      project_id,
      host_id,
      service,
      persistUser,
      id,
    })!;
  },
  createObject: async (options: DStreamOptions & { client: Client }) => {
    const dstream = new DStream(options);
    await dstream.init();
    return dstream;
  },
  // A stream whose files were replaced writes nothing more: the next open
  // gets a new one.
  isValid: (dstream) => !dstream.isReplaced(),
});

export async function dstream<T>(
  options: DStreamOptions & { client: Client },
): Promise<DStream<T>> {
  return await cache(requireDstreamClient(options, "dstream"));
}
