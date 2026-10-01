/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { CollaborationJournal } from "./journal";
import type { CollaborationCensusStore } from "./census-store";
import type { CensusRun } from "./census-types";

export interface CollaborationCensusProducer {
  step(journal: CollaborationJournal): Promise<void>;
  hasWork?(): boolean;
  report?(journal: CollaborationJournal): Promise<void>;
  pause(): Promise<void>;
  close(): Promise<void>;
}

/** Execute admitted runs and hand candidates to the normal source journal. */
export function createCensusProducer(options: {
  store: CollaborationCensusStore;
  enabled(): Promise<boolean> | boolean;
  discover(run: CensusRun): Promise<string[]>;
  /** Fresh authorization + volume fence before accepting a retained candidate. */
  validate(run: CensusRun): Promise<void>;
  onError(error: unknown): void;
  publish?(journal: CollaborationJournal): Promise<void>;
  now?: () => number;
}): CollaborationCensusProducer {
  let pending: Promise<void> | undefined;
  const now = options.now ?? Date.now;
  let stopped = false;
  let reporting: Promise<void> | undefined;
  return {
    hasWork() {
      return options.store.hasDiscoveryWork(now());
    },
    step(journal) {
      if (pending) return pending;
      pending = (async () => {
        if (stopped || !(await options.enabled())) return;
        options.store.compactCompleted();
        options.store.retryCapacityBlocked(now());
        const work = options.store.next(now());
        if (work) {
          try {
            const paths = await options.discover(work.run);
            if (stopped || !(await options.enabled())) return;
            await options.validate(work.run);
            if (!stopped && options.store.canContinue(work))
              options.store.recordDiscovery(work.run, paths);
          } catch (error) {
            options.store.fail(work, error, now());
            options.onError(error);
          }
        }
        const validated = new Set<string>();
        const runs = new Map<string, CensusRun>();
        for (const candidate of options.store.candidates(now(), 100)) {
          if (stopped || !(await options.enabled())) return;
          try {
            let run = runs.get(candidate.project_id);
            if (!run) {
              run = options.store.status(candidate.project_id)?.run;
              if (run) runs.set(candidate.project_id, run);
            }
            if (!run || run.run_id !== candidate.run_id) continue;
            if (!validated.has(candidate.project_id)) {
              await options.validate(run);
              validated.add(candidate.project_id);
            }
            if (stopped || !options.store.isCurrent(run)) continue;
            journal.acceptCensusCandidate(candidate);
            options.store.acknowledge(candidate);
          } catch (error) {
            options.store.deferCandidate(candidate, error, now());
            options.onError(error);
          }
        }
        options.store.compactCompleted();
      })().finally(() => {
        pending = undefined;
      });
      return pending;
    },
    async pause() {
      await pending;
      await reporting;
    },
    async report(journal) {
      if (!stopped && (await options.enabled()))
        await (reporting = Promise.resolve(options.publish?.(journal)));
    },
    async close() {
      stopped = true;
      await pending;
      options.store.close();
    },
  };
}
