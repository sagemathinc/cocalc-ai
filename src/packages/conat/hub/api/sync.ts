import { authFirst } from "./util";

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
    // when true (default), seed a fresh baseline patch from current file
    // contents so opening the file does not temporarily appear blank.
    keep_current_state?: boolean;
  }) => Promise<{
    deleted: number;
    seeded: boolean;
    history_epoch: number;
  }>;
}

export const sync = {
  history: authFirst,
  purgeHistory: authFirst,
};
