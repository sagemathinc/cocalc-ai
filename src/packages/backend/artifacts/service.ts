/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import { DatabaseSync } from "node:sqlite";
import type {
  ArtifactCatalogItem,
  ArtifactCatalogSnapshot,
  ArtifactCatalogSource,
} from "@cocalc/util/artifact-catalog";
import { ArtifactCatalogJournal, type CatalogRegistration } from "./journal";
import { ArtifactCatalogRegistrar } from "./registrar";
import { ArtifactCatalogProjector } from "./projector";

/** Service-owned lifecycle shared by host and Lite adapters. */
export class ArtifactCatalogService {
  readonly journal: ArtifactCatalogJournal;
  private readonly lock: DatabaseSync;
  private readonly registrar: ArtifactCatalogRegistrar;
  private readonly projector: ArtifactCatalogProjector;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private pending?: Promise<void>;
  private nextDiscovery = 0;

  constructor(
    private readonly options: {
      filename: string;
      read: (source: ArtifactCatalogSource) => Promise<ArtifactCatalogItem[]>;
      writerState: ConstructorParameters<
        typeof ArtifactCatalogRegistrar
      >[0]["writerState"];
      register: ConstructorParameters<
        typeof ArtifactCatalogRegistrar
      >[0]["register"];
      send: (snapshot: ArtifactCatalogSnapshot) => Promise<void>;
      /** Authenticated current-host lookup; never replace another same-host writer. */
      recoverWriter?: (
        source: ArtifactCatalogSource,
        expectedEpoch: string | null,
      ) => Promise<{ epoch: string | null } | undefined>;
      /** One bounded background page, never called by opening an artifact browser. */
      discover: () => Promise<ArtifactCatalogSource[]>;
      discoveryIntervalMs?: number;
      onError: (
        source: ArtifactCatalogSource | undefined,
        error: unknown,
      ) => void;
    },
  ) {
    // A separate SQLite exclusive transaction is an OS-released process lock.
    // It is never expired by a timer while the old process might still write.
    this.lock = new DatabaseSync(options.filename + ".lock");
    try {
      this.lock.exec(
        "PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS service_lock (id INTEGER)",
      );
      this.journal = new ArtifactCatalogJournal(options.filename);
      this.journal.recoverInterruptedWrites();
    } catch (err) {
      this.lock.close();
      throw err;
    }
    this.registrar = new ArtifactCatalogRegistrar({
      journal: this.journal,
      writerState: options.writerState,
      register: async (request) => {
        try {
          return await options.register(request);
        } catch (err) {
          await this.recoverWriter(request, request.expected_epoch);
          throw err;
        }
      },
      onError: options.onError,
    });
    this.projector = new ArtifactCatalogProjector({
      journal: this.journal,
      read: options.read,
      send: async (snapshot) => {
        try {
          await options.send(snapshot);
        } catch (err) {
          await this.recoverWriter(snapshot, snapshot.epoch);
          throw err;
        }
      },
      onError: options.onError,
    });
  }

  private async recoverWriter(
    source: CatalogRegistration | ArtifactCatalogSnapshot,
    expectedEpoch: string | null,
  ) {
    if (this.stopped || !this.options.recoverWriter) return;
    const current = await this.options.recoverWriter(source, expectedEpoch);
    if (this.stopped || !current || current.epoch === expectedEpoch) return;
    this.journal.requeueRegistration(source, current.epoch);
  }

  start() {
    if (this.timer || this.pending || this.stopped) return;
    const tick = () => {
      this.timer = undefined;
      this.pending = this.runOnce()
        .catch((err) => this.options.onError(undefined, err))
        .finally(() => {
          this.pending = undefined;
          if (!this.stopped) {
            this.timer = setTimeout(tick, 2000);
            this.timer.unref?.();
          }
        });
    };
    tick();
  }

  private async runOnce() {
    if (Date.now() >= this.nextDiscovery) {
      this.nextDiscovery =
        Date.now() + (this.options.discoveryIntervalMs ?? 30_000);
      try {
        const sources = await this.options.discover();
        if (sources.length > 100)
          throw Error("artifact discovery page exceeds limit");
        if (sources.length && this.options.discoveryIntervalMs == null)
          this.nextDiscovery = Date.now() + 2000;
        if (this.stopped) return;
        for (const source of sources)
          this.journal.finishWrite(this.journal.beginWrite(source));
      } catch (err) {
        this.options.onError(undefined, err);
      }
    }
    if (this.stopped) return;
    await this.registrar.runOnce();
    if (this.stopped) return;
    await this.projector.runOnce();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.registrar.stop();
    this.projector.stop();
  }

  /** Caller must close/drain the filesystem service before releasing its lock. */
  async close() {
    this.stop();
    await this.pending;
    this.journal.close();
    this.lock.close();
  }
}
