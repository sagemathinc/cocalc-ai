import { authFirstRequireAccount } from "./util";

export interface Patch {
  seq: number;
  time: number;
  mesg: {
    time: number;
    wall: number;
    patch: string;
    user_id: number;
    is_snapshot?: boolean;
    parents: number[];
    version?: number;
  };
}

export interface HistoryInfo {
  doctype: string;
  init: { time: Date; size: number; error: string };
  last_active: Date;
  path: string;
  project_id: string;
  read_only: boolean;
  save: {
    state: string;
    error: string;
    hash: number;
    time: number;
    expected_hash: number;
  };
  string_id: string;
  users: string[];
}

export interface Sync {
  history: (opts: {
    account_id?: string;
    project_id: string;
    path: string;
  }) => Promise<{ patches: Patch[] }>;
  purgeHistory: (opts: {
    account_id?: string;
    project_id: string;
    path: string;
    // only reset the history if this patch, too large to load, is still in
    // it, and keep the old history instead of deleting it
    oversized_seq?: number;
  }) => Promise<PurgeHistoryResult>;
}

export interface PurgeHistoryResult {
  // number of patches deleted (or kept aside)
  deleted: number;
  // the history epoch now in effect
  history_epoch: number;
  // false if oversized_seq was given and that patch was already gone
  reset: boolean;
}

export const sync = {
  history: authFirstRequireAccount,
  purgeHistory: authFirstRequireAccount,
};
