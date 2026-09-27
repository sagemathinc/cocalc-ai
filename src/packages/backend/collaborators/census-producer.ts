/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { CollaborationJournal } from "./journal";
import { CollaborationCensus, CollaborationCensusStore } from "./census";
import type { CensusReader, CensusRun } from "./census";

export interface CollaborationCensusProducer {
  step(journal: CollaborationJournal): Promise<void>;
  report?(journal: CollaborationJournal): Promise<void>;
  pause(): Promise<void>;
  close(): Promise<void>;
}

/** Shared host/Lite handoff. Lists never call this explicit background worker. */
export function createCensusProducer(options: {
  store: CollaborationCensusStore;
  enabled(): Promise<boolean> | boolean;
  prepare(store: CollaborationCensusStore): Promise<void>;
  openReader(run: CensusRun): Promise<CensusReader>;
  /** Fresh authorization + volume fence before accepting a retained candidate. */
  validate(run: CensusRun): Promise<void>;
  onError(error: unknown): void;
  publish?(journal: CollaborationJournal): Promise<void>;
  now?: () => number;
}): CollaborationCensusProducer {
  const engine = new CollaborationCensus(options);
  const now = options.now ?? Date.now;
  let stopped = false;
  return {
    async step(journal) {
      if (stopped || !(await options.enabled())) return;
      options.store.compactCompleted();
      options.store.retryCapacityBlocked(now());
      try {
        await options.prepare(options.store);
      } catch (error) {
        options.onError(error);
      }
      if (stopped) return;
      await engine.step();
      for (const candidate of options.store.candidates(now(), 16)) {
        if (stopped || !(await options.enabled())) return;
        try {
          const status = options.store.status(candidate.project_id);
          if (!status || status.run.run_id !== candidate.run_id) continue;
          await options.validate(status.run);
          if (stopped || !options.store.isCurrent(status.run)) continue;
          journal.acceptCensusCandidate(candidate);
          options.store.acknowledge(candidate);
        } catch (error) {
          options.store.deferCandidate(candidate, error, now());
          options.onError(error);
        }
      }
      options.store.compactCompleted();
    },
    pause: () => engine.pause(),
    async report(journal) {
      if (!stopped && (await options.enabled()))
        await options.publish?.(journal);
    },
    async close() {
      stopped = true;
      await engine.close();
      options.store.close();
    },
  };
}
