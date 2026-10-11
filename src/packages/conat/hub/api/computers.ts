/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The owner's computers, from a signed-in browser session. Agents never use
// this API (they use `cocalc computer` with their runtime identity), so every
// method requires a bound human session: an agent acting through an account
// API key can't approve, extend or read computers. Approve and extend also
// need fresh authentication, checked at the account's home bay.
// Plan: src/.agents/computers-plan-2026-10-11.md.

import type {
  ComputerRequestSummary,
  ComputerSummary,
} from "@cocalc/util/computers/api";
import type { ComputerPolicy } from "@cocalc/util/computers/policy";
import { authFirstRequireAccountWithBoundSession } from "./util";

export interface ComputersApi {
  listComputers(opts?: { account_id?: string }): Promise<ComputerSummary[]>;
  getComputer(opts: {
    account_id?: string;
    computer: string;
  }): Promise<ComputerSummary>;
  listComputerRequests(opts?: {
    account_id?: string;
  }): Promise<ComputerRequestSummary[]>;
  createComputerRequest(opts: {
    account_id?: string;
    name: string;
    policy: unknown;
    why?: string;
  }): Promise<{ request_id: string; expires_at: number }>;
  approveComputerRequest(opts: {
    account_id?: string;
    session_hash?: string;
    request_id: string;
    transcript_hash: string;
  }): Promise<{ computer_id: string; policy: ComputerPolicy }>;
  declineComputerRequest(opts: {
    account_id?: string;
    request_id: string;
  }): Promise<void>;
  revokeComputer(opts: {
    account_id?: string;
    computer_id: string;
  }): Promise<{ epoch: number }>;
  extendComputer(opts: {
    account_id?: string;
    session_hash?: string;
    computer_id: string;
    seconds: number;
  }): Promise<{ deadline: number }>;
  renameComputer(opts: {
    account_id?: string;
    computer_id: string;
    name: string;
  }): Promise<void>;
  setComputerNotes(opts: {
    account_id?: string;
    computer: string;
    notes: string;
    expected_revision: number;
    locked?: boolean;
  }): Promise<{ notes_revision: number }>;
  setComputerEffectivePolicy(opts: {
    account_id?: string;
    computer_id: string;
    policy: unknown;
  }): Promise<{ policy_epoch: number }>;
}

export const computers = {
  listComputers: authFirstRequireAccountWithBoundSession,
  getComputer: authFirstRequireAccountWithBoundSession,
  listComputerRequests: authFirstRequireAccountWithBoundSession,
  createComputerRequest: authFirstRequireAccountWithBoundSession,
  approveComputerRequest: authFirstRequireAccountWithBoundSession,
  declineComputerRequest: authFirstRequireAccountWithBoundSession,
  revokeComputer: authFirstRequireAccountWithBoundSession,
  extendComputer: authFirstRequireAccountWithBoundSession,
  renameComputer: authFirstRequireAccountWithBoundSession,
  setComputerNotes: authFirstRequireAccountWithBoundSession,
  setComputerEffectivePolicy: authFirstRequireAccountWithBoundSession,
};
