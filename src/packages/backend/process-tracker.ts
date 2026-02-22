/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export interface ProcessRootMeta {
  kind: string;
  path?: string;
  thread_id?: string;
  session_id?: string;
}

export interface TrackedProcessRoot {
  attachPid: (pid: number, start_time?: number) => void;
  markExited: (opts?: { pid?: number; exited_at?: number }) => void;
  close: () => void;
}

type ProcessTrackerFactory = (meta: ProcessRootMeta) => TrackedProcessRoot;

const NOOP_TRACKED_ROOT: TrackedProcessRoot = {
  attachPid: () => {},
  markExited: () => {},
  close: () => {},
};

let trackerFactory: ProcessTrackerFactory | undefined;

export function setProcessTracker(factory?: ProcessTrackerFactory) {
  trackerFactory = factory;
}

export function trackProcessRoot(meta: ProcessRootMeta): TrackedProcessRoot {
  if (trackerFactory == null) {
    return NOOP_TRACKED_ROOT;
  }
  try {
    return trackerFactory(meta);
  } catch {
    return NOOP_TRACKED_ROOT;
  }
}

