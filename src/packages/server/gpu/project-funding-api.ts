/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
Project funding approvals, the routed entry points of the hub API
(PROJECT_FUNDING.md §6): a funder's approve, change, revoke and list run on
their home bay (the money authority), with fresh authentication checked on
the bay they are signed in to, as for the key budget; a project's state is
asked of the project's owning bay, through the caller's home.
*/

import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";
import { budgetHomeClient } from "@cocalc/server/gpu/budget-api";
import {
  approveProjectFundingLocal,
  changeProjectFundingLocal,
  fundedProjectsLocal,
  revokeProjectFundingLocal,
} from "@cocalc/server/gpu/project-funding";
import { isValidUUID } from "@cocalc/util/misc";

export interface ProjectFundingApiDeps {
  freshAuth?: typeof requireDangerousSessionAuth;
  homeClient?: typeof budgetHomeClient;
}

function requireAccount(account_id: unknown): string {
  if (typeof account_id !== "string" || !isValidUUID(account_id)) {
    throw Error("must be signed in");
  }
  return account_id;
}

async function fresh(
  opts: {
    account_id: string;
    browser_id?: string | null;
    session_hash?: string | null;
  },
  deps: ProjectFundingApiDeps,
): Promise<boolean> {
  if (!opts.browser_id && !opts.session_hash) return false;
  try {
    await (deps.freshAuth ?? requireDangerousSessionAuth)({
      account_id: opts.account_id,
      browser_id: opts.browser_id,
      session_hash: opts.session_hash,
      require_second_factor: false,
    });
    return true;
  } catch {
    return false;
  }
}

export async function approveProjectFunding(
  opts: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
    project_id?: unknown;
    terms?: unknown;
    operation_id?: unknown;
    raise_key_budget_to?: unknown;
  },
  deps: ProjectFundingApiDeps = {},
) {
  const account_id = requireAccount(opts.account_id);
  // an approval always widens spending: fresh authentication, always
  if (!(await fresh({ ...opts, account_id }, deps))) {
    throw Object.assign(
      Error(
        "Approving GPU use in a project needs you to sign in again; do it from the project in the browser.",
      ),
      { code: "fresh_auth_required" },
    );
  }
  const forwarded = {
    account_id,
    project_id: opts.project_id,
    terms: opts.terms,
    operation_id: opts.operation_id,
    raise_key_budget_to: opts.raise_key_budget_to,
    fresh_auth_verified: true,
  };
  const home = await (deps.homeClient ?? budgetHomeClient)(account_id);
  if (home) return await home.gpuApproveProjectFunding(forwarded);
  return await approveProjectFundingLocal(forwarded);
}

export async function changeProjectFunding(
  opts: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
    approval_id?: unknown;
    change?: Record<string, unknown>;
    narrow_only?: boolean;
  },
  deps: ProjectFundingApiDeps = {},
) {
  const account_id = requireAccount(opts.account_id);
  // (only a raise needs it; the funder's bay decides)
  const fresh_auth_verified = await fresh({ ...opts, account_id }, deps);
  const forwarded = {
    account_id,
    approval_id: opts.approval_id,
    change: opts.change,
    fresh_auth_verified,
    narrow_only: opts.narrow_only === true,
  };
  const home = await (deps.homeClient ?? budgetHomeClient)(account_id);
  if (home) return await home.gpuChangeProjectFunding(forwarded);
  return await changeProjectFundingLocal(forwarded);
}

export async function revokeProjectFunding(
  opts: { account_id?: string; approval_id?: unknown },
  deps: ProjectFundingApiDeps = {},
) {
  const account_id = requireAccount(opts.account_id);
  const forwarded = { account_id, approval_id: opts.approval_id };
  const home = await (deps.homeClient ?? budgetHomeClient)(account_id);
  if (home) return await home.gpuRevokeProjectFunding(forwarded);
  return await revokeProjectFundingLocal(forwarded);
}

export async function fundedProjects(
  opts: { account_id?: string },
  deps: ProjectFundingApiDeps = {},
) {
  const account_id = requireAccount(opts.account_id);
  const home = await (deps.homeClient ?? budgetHomeClient)(account_id);
  if (home) return await home.gpuFundedProjects({ account_id });
  return await fundedProjectsLocal({ account_id });
}
