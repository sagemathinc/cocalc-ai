/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { DatabaseSync } from "node:sqlite";
import type { CollaborationSourceSnapshot } from "@cocalc/util/collaborators";
import type { CollaborationRelationPage } from "@cocalc/util/collaboration-relations";
import { CollaborationJournal } from "./journal";
import type { CollaborationDelivery } from "./notifications";
import type { ActivitySource, CollaborationActivityPage } from "./activity";
import type { CollaborationCensusProducer } from "./census-producer";
import {
  journalCapacityFromEnvironment,
  validateJournalCapacity,
} from "./capacity";
import type { CollaborationJournalCapacity } from "./capacity";
import type {
  CollaborationRead,
  CollaborationScan,
  CollaborationRegistration,
  CollaborationSource,
  CollaborationCopy,
  CollaborationRelocationRequest,
} from "./journal";

export class CollaboratorsService {
  readonly journal: CollaborationJournal;
  private readonly lock: DatabaseSync;
  private stopped = false;
  private processingEnabled = false;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private nextDiscovery = 0;
  constructor(
    private readonly options: {
      filename: string;
      journalCapacity?: CollaborationJournalCapacity;
      census?: CollaborationCensusProducer;
      enabled?(): Promise<boolean>;
      /** Bounded canonical-room durability work, before capturing the final read fence. */
      beforeRead?(source: CollaborationScan): Promise<void>;
      initializeCopy?(copy: CollaborationCopy): Promise<void>;
      sourceActivity?(
        source: ActivitySource & { after?: string },
      ): Promise<CollaborationActivityPage>;
      relocate?(
        request: CollaborationRelocationRequest,
      ): Promise<{ epoch: string; revision: number }>;
      read(source: CollaborationScan): Promise<CollaborationRead>;
      stageRelationPage?(page: CollaborationRelationPage): Promise<unknown>;
      writerState(source: CollaborationSource): Promise<{
        epoch: string;
        registration_id: string | null;
        retired_room_id?: string;
      } | null>;
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
    const journalCapacity = options.journalCapacity
      ? validateJournalCapacity(options.journalCapacity)
      : journalCapacityFromEnvironment();
    this.lock = new DatabaseSync(options.filename + ".lock");
    try {
      this.lock.exec(
        "PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS lock (id INTEGER)",
      );
      this.journal = new CollaborationJournal(
        options.filename,
        journalCapacity,
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
            const now = (this.options.now ?? Date.now)();
            const ready =
              this.processingEnabled &&
              (this.options.census?.hasWork?.() ||
                this.journal.registrations(1, now).length ||
                this.journal.scans(1, now).length ||
                this.journal.deliveries(1, now).length);
            this.timer = setTimeout(tick, ready ? 25 : 2000);
            this.timer.unref?.();
          }
        });
    };
    tick();
  }
  /** Explicit admissions may wake the idle worker without waiting for polling. */
  wake() {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.start();
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
    this.processingEnabled = await this.journal.isEnabled();
    if (!this.processingEnabled || this.stopped) {
      await this.options.census?.pause();
      return;
    }
    const now = this.options.now ?? Date.now;
    this.journal.relations.recover();
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
    if (this.options.census && !this.stopped) {
      try {
        await this.options.census.step(this.journal);
      } catch (err) {
        this.options.onError(undefined, err);
      }
    }
    await this.parallel(
      this.journal.registrations(16, now()),
      async (source) => {
        if (this.stopped) return;
        if (!this.journal.registrationIsCurrent(source)) return;
        let expectedEpoch = source.expected_epoch;
        try {
          let base = this.journal.registrationBase(source);
          if (!base) {
            const current = await this.options.writerState(source);
            if (this.stopped) return;
            if (current?.retired_room_id) {
              this.journal.retireRoomSource(source, current.retired_room_id);
              return;
            }
            if (!this.journal.registrationIsCurrent(source)) return;
            if (current?.registration_id === source.registration_id) {
              this.journal.registered(source, current.epoch);
              return;
            }
            base = this.journal.prepareRegistration(
              source,
              current?.epoch ?? null,
            );
          }
          expectedEpoch = base.expected_epoch;
          if (!this.journal.registrationIsCurrent(source)) return;
          const { epoch } = await this.options.register({ ...source, ...base });
          if (this.stopped) return;
          this.journal.registered(source, epoch);
        } catch (err) {
          await this.recover(source, expectedEpoch);
          this.journal.defer(source, now(), err);
          this.options.onError(source, err);
        }
      },
    );
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
          this.journal.defer(source, now(), error);
          this.options.onError(source, error);
        }
      }
    }
    await this.parallel(this.journal.scans(16, now()), async (source) => {
      if (this.stopped) return;
      try {
        let scan = this.journal.currentScan(source, now());
        if (!scan) return;
        if (this.options.beforeRead) {
          await this.options.beforeRead(scan);
          if (this.stopped || !(await this.journal.isEnabled())) return;
          scan = this.journal.currentScan(source, now());
          if (!scan) return;
        }
        const read = await this.options.read(scan);
        if (this.stopped) return;
        this.journal.prepare(scan, read);
      } catch (err) {
        if (this.options.beforeRead) await this.recover(source, source.epoch);
        this.journal.defer(source, now(), err, true);
        this.options.onError(source, err);
      }
    });
    await this.parallel(
      this.journal.deliveries(16, now()),
      async (snapshot) => {
        if (this.stopped) return;
        if (!this.journal.deliveryIsCurrent(snapshot)) return;
        try {
          const send = async (payload: CollaborationDelivery) => {
            const result = await this.options.send(payload);
            if (
              !Number.isSafeInteger(result.revision) ||
              result.revision < 0 ||
              typeof result.replayed !== "boolean"
            )
              throw Error("invalid collaboration ingest acknowledgement");
            return result;
          };
          if (this.journal.relations.has(snapshot)) {
            if (!this.options.stageRelationPage)
              throw Error("relation page transport is unavailable");
            const done = await this.journal.relations.deliver(
              snapshot,
              {
                stage: async (page) => {
                  const result = await this.options.stageRelationPage!(page);
                  if (
                    !result ||
                    typeof (result as { replayed?: unknown }).replayed !==
                      "boolean"
                  )
                    throw Error(
                      "invalid collaboration relation page acknowledgement",
                    );
                },
                commit: (relations) => send({ ...snapshot, relations }),
              },
              () => !this.stopped && this.journal.deliveryIsCurrent(snapshot),
            );
            if (!done) return;
          } else await send(snapshot);
          this.journal.acknowledge(snapshot);
        } catch (err) {
          await this.recover(snapshot, snapshot.epoch);
          this.journal.defer(snapshot, now(), err);
          this.options.onError(snapshot, err);
        }
      },
    );
    if (!this.stopped) {
      try {
        await this.options.census?.report?.(this.journal);
      } catch (err) {
        this.options.onError(undefined, err);
      }
    }
  }
  /** Independent source fences allow bounded I/O overlap without overlapping
   * phases or admitting a second operation for the same source. */
  private async parallel<T>(items: T[], process: (item: T) => Promise<void>) {
    let next = 0;
    const results = await Promise.allSettled(
      // The owner admits two concurrent writer requests per host. Every phase
      // can call that API, including the authority checks before source reads.
      Array.from({ length: Math.min(2, items.length) }, async () => {
        while (!this.stopped && next < items.length)
          await process(items[next++]);
      }),
    );
    for (const result of results)
      if (result.status === "rejected") throw result.reason;
  }
  private async recover(
    source:
      | CollaborationRegistration
      | CollaborationSourceSnapshot
      | ActivitySource,
    expectedEpoch: string | null,
  ) {
    if (this.stopped) return;
    try {
      const writer = await this.options.writerState(source);
      if (this.stopped) return;
      if (writer?.retired_room_id) {
        this.journal.retireRoomSource(source, writer.retired_room_id);
        return;
      }
      if (!this.options.recoverWriter) return;
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
    await this.options.census?.close();
    this.journal.close();
    this.lock.close();
  }
}
