/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { CollaborationCensusStore } from "./census-store";
import type {
  CensusDirectory,
  CensusObservation,
  CensusReader,
  CensusRun,
  CensusWork,
} from "./census-types";
export * from "./census-types";
export { CollaborationCensusStore } from "./census-store";

interface Cursor {
  work: CensusWork;
  reader: CensusReader;
  directory: CensusDirectory;
}
export interface CensusStep {
  examined: number;
  completed: boolean;
}

/** Explicit worker only: construction and store reads never access project files. */
export class CollaborationCensus {
  private readonly cursors = new Map<string, Cursor>();
  private pending?: Promise<CensusStep>;
  private stopped = false;
  private readonly entriesPerStep: number;
  private readonly openDirectories: number;
  private readonly stepMs: number;
  private readonly now: () => number;

  constructor(
    private readonly options: {
      store: CollaborationCensusStore;
      openReader(run: CensusRun): Promise<CensusReader>;
      enabled(): Promise<boolean> | boolean;
      onError?(error: unknown): void;
      entriesPerStep?: number;
      openDirectories?: number;
      stepMs?: number;
      now?: () => number;
    },
  ) {
    this.entriesPerStep = options.entriesPerStep ?? 100;
    this.openDirectories = options.openDirectories ?? 4;
    this.stepMs = options.stepMs ?? 100;
    this.now = options.now ?? Date.now;
    if (
      !Number.isInteger(this.entriesPerStep) ||
      this.entriesPerStep < 1 ||
      this.entriesPerStep > 100 ||
      !Number.isInteger(this.openDirectories) ||
      this.openDirectories < 1 ||
      this.openDirectories > 32 ||
      !Number.isFinite(this.stepMs) ||
      this.stepMs <= 0
    )
      throw Error("invalid census worker budget");
  }

  step(): Promise<CensusStep> {
    if (this.pending) return this.pending;
    if (this.stopped) return Promise.resolve({ examined: 0, completed: false });
    this.pending = this.run().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private key(work: CensusWork) {
    return JSON.stringify([work.run.project_id, work.run.run_id, work.path]);
  }

  private async release(cursor: Cursor) {
    this.cursors.delete(this.key(cursor.work));
    try {
      await cursor.directory.close();
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      try {
        await cursor.reader.close();
      } catch (error) {
        this.options.onError?.(error);
      }
    }
  }

  private async run(): Promise<CensusStep> {
    const idle = { examined: 0, completed: false };
    const { store } = this.options;
    if (!(await this.options.enabled()) || this.stopped) {
      for (const cursor of [...this.cursors.values()])
        await this.release(cursor);
      return idle;
    }
    for (const cursor of [...this.cursors.values()])
      if (!store.canContinue(cursor.work)) await this.release(cursor);
    const work = store.next(
      this.now(),
      this.cursors.size >= this.openDirectories
        ? [...this.cursors.values()].map((cursor) => cursor.work)
        : undefined,
    );
    if (!work) return idle;
    let cursor = this.cursors.get(this.key(work));
    let examined = 0;
    try {
      if (!cursor) {
        const reader = await this.options.openReader(work.run);
        try {
          await reader.assertCurrent();
          if (this.stopped || !store.canContinue(work)) {
            await reader.close();
            return idle;
          }
          const directory = await reader.openDirectory(work.path);
          cursor = { work, reader, directory };
          this.cursors.set(this.key(work), cursor);
        } catch (error) {
          await reader.close();
          throw error;
        }
      }
      await cursor.reader.assertCurrent();
      if (this.stopped || !store.canContinue(work)) {
        await this.release(cursor);
        return idle;
      }
      const start = this.now();
      const observations: CensusObservation[] = [];
      let complete = false;
      while (
        !this.stopped &&
        store.isCurrent(work.run) &&
        examined < this.entriesPerStep &&
        this.now() - start < this.stepMs
      ) {
        const entry = await cursor.directory.read();
        examined++;
        if (!entry) {
          complete = true;
          break;
        }
        observations.push({
          name: entry.name,
          kind: entry.isSymbolicLink()
            ? "symlink"
            : entry.isDirectory()
              ? "directory"
              : entry.isFile()
                ? "file"
                : "other",
        });
      }
      if (
        this.stopped ||
        !(await this.options.enabled()) ||
        !store.isCurrent(work.run)
      ) {
        await this.release(cursor);
        return { examined, completed: false };
      }
      // This must be the last awaited operation before the durable commit.
      await cursor.reader.assertCurrent();
      await cursor.directory.assertCurrent?.();
      if (this.stopped || !store.canContinue(work)) {
        await this.release(cursor);
        return { examined, completed: false };
      }
      const accepted = store.record(work, observations, complete);
      if (complete || !accepted) await this.release(cursor);
      return { examined, completed: accepted && complete };
    } catch (error) {
      // A failed commit or read invalidates the in-memory cursor. Reopening replays
      // the unfinished directory, deduplicating only durably recorded entries.
      if (cursor) await this.release(cursor);
      store.fail(work, error, this.now());
      this.options.onError?.(error);
      return { examined, completed: false };
    }
  }

  /** Feature disable drops open handles, but retains durable progress for replay. */
  async pause(): Promise<void> {
    await this.pending;
    for (const cursor of [...this.cursors.values()]) await this.release(cursor);
  }

  async close(): Promise<void> {
    this.stopped = true;
    await this.pending;
    for (const cursor of [...this.cursors.values()]) await this.release(cursor);
  }
}
