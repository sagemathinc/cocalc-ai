/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The owner's computers, from a signed-in browser session. Agents never use
// this API (they run commands through their project host), so every method
// requires a bound human session: an agent acting through an account API key
// can't approve or read computers. Approve also needs fresh authentication,
// checked at the account's home bay.
// Design: src/.agents/computers-direct-host-2026-10-16.md.

import type {
  ComputerRequestSummary,
  ComputerSummary,
  CreatedComputerRequest,
} from "@cocalc/util/computers/api";
import { authFirstRequireAccountWithBoundSession } from "./util";

export interface ComputersApi {
  listComputers(opts?: { account_id?: string }): Promise<ComputerSummary[]>;
  listComputerRequests(opts?: {
    account_id?: string;
  }): Promise<ComputerRequestSummary[]>;
  createComputerRequest(opts: {
    account_id?: string;
    name: string;
    project_id: string;
  }): Promise<CreatedComputerRequest>;
  approveComputerRequest(opts: {
    account_id?: string;
    session_hash?: string;
    request_id: string;
    pairing_phrase: string;
  }): Promise<{ computer_id: string }>;
  declineComputerRequest(opts: {
    account_id?: string;
    request_id: string;
  }): Promise<void>;
  revokeComputer(opts: {
    account_id?: string;
    computer_id: string;
  }): Promise<void>;
  renameComputer(opts: {
    account_id?: string;
    computer_id: string;
    name: string;
  }): Promise<void>;
}

export const computers = {
  listComputers: authFirstRequireAccountWithBoundSession,
  listComputerRequests: authFirstRequireAccountWithBoundSession,
  createComputerRequest: authFirstRequireAccountWithBoundSession,
  approveComputerRequest: authFirstRequireAccountWithBoundSession,
  declineComputerRequest: authFirstRequireAccountWithBoundSession,
  revokeComputer: authFirstRequireAccountWithBoundSession,
  renameComputer: authFirstRequireAccountWithBoundSession,
};
