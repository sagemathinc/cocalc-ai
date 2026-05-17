import { authFirst, authFirstRequireAccount } from "./util";

export const db = {
  userQuery: authFirst,
  touch: authFirst,
  getLegacyTimeTravelInfo: authFirst,
  getLegacyTimeTravelPatches: authFirst,
  removeBlobTtls: authFirstRequireAccount,
  saveBlob: authFirst,
  deleteOldestAccountBlobs: authFirstRequireAccount,
  deleteOldestProjectBlobs: authFirstRequireAccount,
};

export interface DB {
  userQuery: (opts: {
    project_id?: string;
    account_id?: string;
    query: any;
    options?: any[];
  }) => Promise<any>;

  touch: (opts: {
    account_id?: string;
    project_id?: string;
    path?: string;
    action?: string;
  }) => Promise<void>;

  getLegacyTimeTravelInfo: (opts: {
    account_id?: string;
    project_id: string;
    path: string;
  }) => Promise<{ uuid: string; users?: string[] }>;

  // returns JSON.stringify({patches:[patch0,patch1,...]})
  getLegacyTimeTravelPatches: (opts: {
    account_id?: string;
    uuid: string;
    // also, make this bigger:
    timeout?: number;
  }) => Promise<string>;
  removeBlobTtls: (opts: {
    account_id?: string;
    uuids: string[];
  }) => Promise<void>;
  saveBlob: (opts: {
    account_id?: string;
    project_id?: string;
    uuid: string;
    blob: string;
    ttl?: number;
  }) => Promise<{ uuid: string }>;
  deleteOldestAccountBlobs: (opts: {
    account_id?: string;
    limit: number;
  }) => Promise<{ deleted_count: number; deleted_bytes: number }>;
  deleteOldestProjectBlobs: (opts: {
    account_id?: string;
    project_id: string;
    limit: number;
  }) => Promise<{ deleted_count: number; deleted_bytes: number }>;
}
