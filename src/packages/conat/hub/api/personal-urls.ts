/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type {
  PersonalUrlOwner,
  ResolvedPersonalUrl,
} from "@cocalc/util/personal-urls";
export type { PersonalUrlOwner } from "@cocalc/util/personal-urls";
import {
  authFirstRequireAccount,
  authFirstRequireAccountWithBoundSession,
} from "./util";

export interface AccountUsername {
  account_id: string;
  username: string | null;
  redirects: string[];
}

export interface PersonalUrlsApi {
  getUsername(opts?: { owner_account_id?: string }): Promise<AccountUsername>;
  setUsername(opts: { username: string | null }): Promise<AccountUsername>;
  releaseRedirect(opts: {
    owner_account_id: string;
    username: string;
    reason: string;
  }): Promise<void>;
  resolveOwner(opts: { owner: string }): Promise<PersonalUrlOwner>;
  resolveUrl(opts: {
    url: string;
    inspect?: boolean;
  }): Promise<ResolvedPersonalUrl>;
}

export const personalUrls = {
  getUsername: authFirstRequireAccount,
  setUsername: authFirstRequireAccount,
  releaseRedirect: authFirstRequireAccountWithBoundSession,
  resolveOwner: authFirstRequireAccount,
  resolveUrl: authFirstRequireAccount,
};
