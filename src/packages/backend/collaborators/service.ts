/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { DatabaseSync } from "node:sqlite";
import type { CollaborationSourceSnapshot } from "@cocalc/util/collaborators";
import { CollaborationJournal } from "./journal";
import type { CollaborationDelivery } from "./notifications";
import type { ActivitySource, CollaborationActivityPage } from "./activity";
import type {
  CollaborationRead,
  CollaborationRegistration,
  CollaborationSource,
  CollaborationCopy,
  CollaborationRelocationRequest,
} from "./journal";

export class CollaboratorsService {
  readonly journal: CollaborationJournal;
  private readonly lock: DatabaseSync;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private nextDiscovery = 0;
  constructor(
    private readonly options: {
      filename: string;
      enabled?(): Promise<boolean>;
      initializeCopy?(copy: CollaborationCopy): Promise<void>;
      sourceActivity?(
        source: ActivitySource & { after?: string },
      ): Promise<CollaborationActivityPage>;
      relocate?(
        request: CollaborationRelocationRequest,
      ): Promise<{ epoch: string; revision: number }>;
      read(source: CollaborationSource): Promise<CollaborationRead>;
      writerState(
        source: CollaborationSource,
      ): Promise<{ epoch: string; registration_id: string | null } | null>;
      register(request: CollaborationRegistration): Promise<{ epoch: string }>;
      send(
        snapshot: CollaborationDelivery,
      ): Promise<{ revision: number; replayed: boolean }>;
      discover(): Promise<CollaborationSource[]>;
      onError(source: CollaborationSource | undefined, err: unknown): void;
      recoverWriter?(
        source: CollaborationSource,
        expectedEpoch: string | null,
      ): Promise<{ epoch: string | null } | undefined>;
      now?: () => number;
    },
  ) {
    this.lock = new DatabaseSync(options.filename + ".lock");
    try {
      this.lock.exec(
        "PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS lock (id INTEGER)",
      );
      this.journal = new CollaborationJournal(
        options.filename,
        undefined,
        !!options.sourceActivity,
        options.enabled,
      );
      this.journal.recoverInterruptedWrites();
    } catch (err) {
      this.lock.close();
      throw err;
    }
  }
  start() {
    if (this.timer || this.pending || this.stopped) return;
    const tick = () => {
      this.timer = undefined;
      void this.runOnce()
        .catch((err) => this.options.onError(undefined, err))
        .finally(() => {
          if (!this.stopped) {
            this.timer = setTimeout(tick, 2000);
            this.timer.unref?.();
          }
        });
    };
    tick();
  }
  runOnce(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.stopped) return Promise.resolve();
    this.pending = this.run().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async run() {
    if (!(await this.journal.isEnabled()) || this.stopped) return;
    const now = this.options.now ?? Date.now;
    if (this.options.initializeCopy) {
      for (const copy of this.journal.copies(16, now())) {
        if (this.stopped) return;
        try {
          await this.options.initializeCopy(copy);
          if (this.stopped) return;
          this.journal.acknowledgeCopy(copy.operation_id);
        } catch (error) {
          this.journal.deferCopy(copy.operation_id, now());
          this.options.onError(copy, error);
        }
      }
    }
    if (now() >= this.nextDiscovery) {
      this.nextDiscovery = now() + 2000;
      try {
        const sources = await this.options.discover();
        if (sources.length > 100)
          throw Error("collaboration discovery page exceeds capacity");
        if (this.stopped) return;
        for (const source of sources) this.journal.touch(source);
      } catch (err) {
        this.options.onError(undefined, err);
      }
    }
    for (const source of this.journal.registrations(16, now())) {
      if (this.stopped) return;
      if (!this.journal.registrationIsCurrent(source)) continue;
      let expectedEpoch = source.expected_epoch;
      try {
        let base = this.journal.registrationBase(source);
        if (!base) {
          const current = await this.options.writerState(source);
          if (this.stopped) return;
          if (!this.journal.registrationIsCurrent(source)) continue;
          if (current?.registration_id === source.registration_id) {
            this.journal.registered(source, current.epoch);
            continue;
          }
          base = this.journal.prepareRegistration(
            source,
            current?.epoch ?? null,
          );
        }
        expectedEpoch = base.expected_epoch;
        if (!this.journal.registrationIsCurrent(source)) continue;
        const { epoch } = await this.options.register({ ...source, ...base });
        if (this.stopped) return;
        this.journal.registered(source, epoch);
      } catch (err) {
        await this.recover(source, expectedEpoch);
        this.journal.defer(source, now());
        this.options.onError(source, err);
      }
    }
    if (this.options.relocate) {
      for (const move of this.journal.relocations(16, now())) {
        if (this.stopped) return;
        try {
          let request = this.journal.relocationRequest(move.operation_id);
          if (!request) {
            const from = await this.options.writerState({
              project_id: move.project_id,
              chat_path: move.from_path,
            });
            const to = await this.options.writerState({
              project_id: move.project_id,
              chat_path: move.to_path,
            });
            if (this.stopped) return;
            if (!from) throw Error("relocation source registration is pending");
            request = this.journal.prepareRelocation(
              move,
              from.epoch,
              to?.epoch ?? null,
            );
          }
          const result = await this.options.relocate(request);
          if (
            !result?.epoch ||
            !Number.isSafeInteger(result.revision) ||
            result.revision < 0
          )
            throw Error("invalid collaboration relocation acknowledgement");
          if (this.stopped) return;
          this.journal.acknowledgeRelocation(move.operation_id, result.epoch);
        } catch (error) {
          this.journal.deferRelocation(move.operation_id, now());
          this.options.onError(
            { project_id: move.project_id, chat_path: move.from_path },
            error,
          );
        }
      }
    }
    if (this.options.sourceActivity) {
      for (const source of this.journal.activityRecoveries(16, now())) {
        if (this.stopped) return;
        const recovery = this.journal.activityRecovery(source);
        try {
          const page = await this.options.sourceActivity({
            ...source,
            ...(recovery.after ? { after: recovery.after } : {}),
          });
          if (this.stopped) return;
          this.journal.importActivityPage(source, page);
        } catch (error) {
          if (
            recovery.after &&
            /checkpoint.*(?:restart paging|changed|expired)|invalid.*checkpoint/i.test(
              String(error),
            )
          )
            this.journal.restartActivityRecovery(source);
          await this.recover(source, source.epoch);
          this.journal.defer(source, now());
          this.options.onError(source, error);
        }
      }
    }
    for (const source of this.journal.scans(16, now())) {
      if (this.stopped) return;
      try {
        const read = await this.options.read(source);
        if (this.stopped) return;
        this.journal.prepare(source, read);
      } catch (err) {
        this.journal.defer(source, now());
        this.options.onError(source, err);
      }
    }
    for (const snapshot of this.journal.deliveries(16, now())) {
      if (this.stopped) return;
      if (!this.journal.deliveryIsCurrent(snapshot)) continue;
      try {
        const result = await this.options.send(snapshot);
        if (
          !Number.isSafeInteger(result.revision) ||
          result.revision < 0 ||
          typeof result.replayed !== "boolean"
        )
          throw Error("invalid collaboration ingest acknowledgement");
        this.journal.acknowledge(snapshot);
      } catch (err) {
        await this.recover(snapshot, snapshot.epoch);
        this.journal.defer(snapshot, now());
        this.options.onError(snapshot, err);
      }
    }
  }
  private async recover(
    source:
      | CollaborationRegistration
      | CollaborationSourceSnapshot
      | ActivitySource,
    expectedEpoch: string | null,
  ) {
    if (this.stopped || !this.options.recoverWriter) return;
    try {
      const current = await this.options.recoverWriter(source, expectedEpoch);
      if (!this.stopped && current && current.epoch !== expectedEpoch)
        this.journal.requeueRegistration(source, current.epoch);
    } catch (err) {
      this.options.onError(source, err);
    }
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
  /** Drain filesystem and room services before releasing this process fence. */
  async close() {
    this.stop();
    await this.pending;
    this.journal.close();
    this.lock.close();
  }
}
