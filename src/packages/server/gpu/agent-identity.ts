/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
Who an agent GPU call is (step 6b), derived only from its verified auth: the
hub API subject carries the account, the project, the token's fingerprint
and its lifetime, never an agent or run id. Caller-supplied identity is
never used.

- A registered agent identity (agent_identity_runs, whose token_hash is the
  fingerprint): agent_id = "agent:<agent_id>", run_id = its run id. Exactly
  one active run, of this account and project; anything else fails closed.
- An external agent installation (agent_external_installations, whose
  secret_hash is the fingerprint): refused for GPU launches for now.
- Otherwise a project-scoped agent token, whose fingerprint is derived from
  (account, project, session id): agent_id = run_id = "session:<fingerprint>".
  A grant for it is session-scoped, not a durable named agent.

Resolve on the bay that authenticated the token (it holds these tables),
before forwarding to the key owner's home bay.
*/

import getPool from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";
import type { GpuAgentPrincipal } from "@cocalc/server/gpu/agent-grants";

type Db = { query: (sql: string, values?: unknown[]) => Promise<any> };

export interface GpuAgentAuth {
  account_id?: string;
  project_id?: string;
  auth_token_fingerprint?: string;
  auth_exp_s?: number;
}

function refuse(message: string): never {
  throw Object.assign(new Error(message), { code: 403 });
}

export async function resolveGpuAgentPrincipal(
  auth: GpuAgentAuth,
  deps: { db?: Db; now?: () => Date } = {},
): Promise<GpuAgentPrincipal> {
  const db = deps.db ?? getPool();
  const now = (deps.now ?? (() => new Date()))();
  const { account_id, project_id, auth_token_fingerprint: fp } = auth;
  if (
    !isValidUUID(account_id) ||
    !isValidUUID(project_id) ||
    typeof fp !== "string" ||
    !/^[a-f0-9]{64}$/.test(fp) ||
    typeof auth.auth_exp_s !== "number" ||
    !Number.isFinite(auth.auth_exp_s)
  ) {
    refuse("invalid agent identity");
  }
  const expires_at = new Date(auth.auth_exp_s! * 1000);
  if (expires_at <= now) refuse("This agent's credentials have expired.");

  const { rows: runs } = await db.query(
    `SELECT r.agent_id, r.run_id, r.account_id, r.expires_at, r.ended_at,
            a.project_id, a.disabled_at
       FROM agent_identity_runs r JOIN agent_identities a USING (agent_id)
      WHERE r.token_hash = $1`,
    [fp],
  );
  if (runs.length > 0) {
    const run = runs[0];
    if (
      runs.length !== 1 ||
      run.account_id !== account_id ||
      run.project_id !== project_id ||
      run.ended_at != null ||
      run.disabled_at != null ||
      new Date(run.expires_at) <= now
    ) {
      refuse("This agent's identity isn't active for this project.");
    }
    return {
      account_id: account_id!,
      project_id: project_id!,
      agent_id: `agent:${run.agent_id}`,
      run_id: `${run.run_id}`,
      expires_at: new Date(
        Math.min(expires_at.getTime(), new Date(run.expires_at).getTime()),
      ),
    };
  }
  const { rows: external } = await db.query(
    `SELECT 1 FROM agent_external_installations WHERE secret_hash = $1 LIMIT 1`,
    [fp],
  );
  if (external.length > 0) {
    refuse("External agents can't launch GPUs yet.");
  }
  const key = `session:${fp}`;
  return {
    account_id: account_id!,
    project_id: project_id!,
    agent_id: key,
    run_id: key,
    expires_at,
  };
}
