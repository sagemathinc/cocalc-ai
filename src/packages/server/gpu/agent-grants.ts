/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
GPU bring-your-own-key, step 6b: an agent launches a GPU only with its
human's approval of that exact launch, during one agent run (the contract is
STEP6.md in the RunPod working notes).

- An agent's launch without a grant records an immutable request (the
  canonical payload and its hash) and answers approval_required.
- The human approves (request_id, expected_hash) with fresh authentication.
  One transaction then creates the grant and the agent budget layer that
  funds it (layer.grant_id), from exactly that payload.
- The agent's retry finds the grant, under the same lock order as every
  launch (the account fence, then the grant, then the key's fence and its
  layers), and is admitted against the grant's layer and every other layer.
- Expiry (the end of the run) closes admission only (admission_closed_at);
  its pods run to their own deadlines. An explicit revoke also revokes the
  layer, so the reaper terminates that grant's pods, and only those.

Identity: agent_id and run_id here hold canonical principal and run keys
derived server-side from the verified auth token, never from a request body:
"agent:<agent_id>" plus the run id for a registered agent identity, or
"session:<fingerprint>" (for both) for a project-scoped agent token, which
makes the grant session-scoped (see agent-identity.ts).
*/

import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "@cocalc/database/pool";
import { toDecimal, moneyToDbString } from "@cocalc/util/money";
import { isValidUUID } from "@cocalc/util/misc";
import { maxLaunchCostUsd } from "@cocalc/util/gpu/templates";
import type { GpuLaunchSpec } from "@cocalc/util/gpu/types";
import { lockGpuAccountFence } from "@cocalc/server/gpu/account-fence";
import { ensureKeyBudget, lockKeyFence } from "@cocalc/server/gpu/budgets";

type Db = Pick<PoolClient, "query">;

// How long an agent's request (and the grant it becomes) can admit a launch
// at most, within the run's own token lifetime.
export const AGENT_REQUEST_TTL_MS = 30 * 60_000;
// An agent layer outlives its grant by the pod's runtime and this margin, so
// the reaper never mistakes the end of admission for the end of the budget.
const LAYER_MARGIN_MS = 60 * 60_000;
export const AGENT_PAYLOAD_VERSION = 1;

// The verified agent principal for one call (agent-identity.ts).
export interface GpuAgentPrincipal {
  account_id: string;
  project_id: string;
  // canonical keys, e.g. "agent:<id>" + run id, or "session:<fp>" for both
  agent_id: string;
  run_id: string;
  // the auth token's own expiry: no request or grant outlives it
  expires_at: Date;
}

// What the human is asked to approve, exactly.
export interface GpuAgentPayload {
  spec: Omit<GpuLaunchSpec, "ssh_public_key">;
  // RunPod's list price for the pod's GPUs, per hour
  hourly_usd: string;
  // the most the launch can cost: GPUs and disk for the whole runtime
  max_cost_usd: string;
  max_pods: 1;
}

export class GpuAgentApprovalRequired extends Error {
  readonly code = "gpu_agent_approval_required";
  constructor(
    readonly request_id: string,
    readonly payload_hash: string,
    readonly payload: GpuAgentPayload,
    readonly expires_at: string,
  ) {
    super(
      `This GPU launch needs your human's approval first: request ${request_id}. Ask them to approve it in CoCalc, then run the same launch again.`,
    );
  }
}

// JSON with sorted keys, so the hash is the same however the payload was
// built.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value != null && typeof value === "object") {
    const keys = Object.keys(value as object)
      .filter((k) => (value as any)[k] !== undefined)
      .sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as any)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function agentLaunchPayload(
  spec: GpuLaunchSpec,
  per_gpu_hour_usd: number,
): { payload: GpuAgentPayload; payload_hash: string } {
  // the pod's own SSH key differs per attempt and doesn't change the cost
  const { ssh_public_key: _key, ...rest } = spec;
  const payload: GpuAgentPayload = {
    spec: rest,
    hourly_usd: moneyToDbString(
      toDecimal(per_gpu_hour_usd).times(spec.gpu_count),
    ),
    max_cost_usd: maxLaunchCostUsd({
      price_per_gpu_hour: per_gpu_hour_usd,
      gpu_count: spec.gpu_count,
      max_runtime_minutes: spec.max_runtime_minutes,
      container_disk_gb: spec.container_disk_gb ?? 0,
      volume_gb: spec.volume_gb ?? 0,
    }).toFixed(2),
    max_pods: 1,
  };
  return { payload, payload_hash: agentPayloadHash(payload) };
}

export function agentPayloadHash(payload: GpuAgentPayload): string {
  return createHash("sha256")
    .update(canonicalJson({ v: AGENT_PAYLOAD_VERSION, payload }))
    .digest("hex");
}

function requireUuid(v: unknown, what: string): string {
  if (typeof v !== "string" || !isValidUUID(v)) throw Error(`invalid ${what}`);
  return v;
}

// ---- the agent's side ----

// A grant this principal may launch with now, for exactly this payload and
// operation, locked. Call inside the launch transaction, right after the account fence.
export async function lockUsableGrant(
  db: Db,
  principal: GpuAgentPrincipal,
  payload_hash: string,
  operation_id: string,
  now: Date,
): Promise<
  { grant_id: string; layer_id: string; credential_id: string } | undefined
> {
  const { rows } = await db.query(
    `SELECT g.grant_id, g.layer_id, g.credential_id FROM gpu_agent_grants g
      WHERE g.account_id = $1 AND g.project_id = $2 AND g.agent_id = $3
        AND g.run_id = $4 AND g.payload_hash = $5 AND g.operation_id = $6
        AND g.state = 'active' AND g.expires_at > $7
        AND g.launches_used < g.launches_allowed
      ORDER BY g.created
      LIMIT 1
      FOR UPDATE`,
    [
      principal.account_id,
      principal.project_id,
      principal.agent_id,
      principal.run_id,
      payload_hash,
      operation_id,
      now,
    ],
  );
  return rows[0];
}

export async function consumeGrantLaunch(
  db: Db,
  grant_id: string,
): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE gpu_agent_grants SET launches_used = launches_used + 1
      WHERE grant_id = $1 AND launches_used < launches_allowed`,
    [grant_id],
  );
  if (rowCount !== 1) throw Error("This agent's GPU approval was used up.");
}

// Record what the agent asked for (or find the identical pending request)
// and return the approval_required answer. Its own transaction: the launch's
// was rolled back or never started.
export async function requestAgentLaunch(
  db: Db,
  opts: {
    principal: GpuAgentPrincipal;
    operation_id: string;
    payload: GpuAgentPayload;
    payload_hash: string;
    now?: Date;
  },
): Promise<GpuAgentApprovalRequired> {
  const { principal, operation_id, payload, payload_hash } = opts;
  const now = opts.now ?? new Date();
  const expires = new Date(
    Math.min(
      principal.expires_at.getTime(),
      now.getTime() + AGENT_REQUEST_TTL_MS,
    ),
  );
  if (expires <= now) {
    throw Error(
      "This agent's credentials have expired; retry after they refresh.",
    );
  }
  const same = await db.query(
    `SELECT request_id, expires_at FROM gpu_agent_requests
      WHERE account_id = $1 AND project_id = $2 AND agent_id = $3 AND run_id = $4
        AND operation_id = $5 AND payload_hash = $6
        AND state = 'pending' AND expires_at > $7
      LIMIT 1`,
    [
      principal.account_id,
      principal.project_id,
      principal.agent_id,
      principal.run_id,
      operation_id,
      payload_hash,
      now,
    ],
  );
  if (same.rows[0]) {
    return new GpuAgentApprovalRequired(
      same.rows[0].request_id,
      payload_hash,
      payload,
      new Date(same.rows[0].expires_at).toISOString(),
    );
  }
  // A different payload for the same operation supersedes the older one, so
  // the human never approves a launch the agent no longer means; one past
  // its expiry just ends. (The caller holds the account fence, so identical
  // concurrent asks find one another; a unique index backs that up.)
  await db.query(
    `UPDATE gpu_agent_requests
        SET state = CASE WHEN expires_at <= $7 THEN 'expired' ELSE 'superseded' END,
            decided_at = $7
      WHERE account_id = $1 AND project_id = $2 AND agent_id = $3 AND run_id = $4
        AND operation_id = $5 AND state = 'pending'
        AND (payload_hash <> $6 OR expires_at <= $7)`,
    [
      principal.account_id,
      principal.project_id,
      principal.agent_id,
      principal.run_id,
      operation_id,
      payload_hash,
      now,
    ],
  );
  const request_id = randomUUID();
  await db.query(
    `INSERT INTO gpu_agent_requests (request_id, account_id, project_id, agent_id,
       run_id, operation_id, payload, payload_hash, state, created, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10)`,
    [
      request_id,
      principal.account_id,
      principal.project_id,
      principal.agent_id,
      principal.run_id,
      operation_id,
      payload,
      payload_hash,
      now,
      expires,
    ],
  );
  return new GpuAgentApprovalRequired(
    request_id,
    payload_hash,
    payload,
    expires.toISOString(),
  );
}

// ---- the human's side (on the key owner's home bay) ----

export interface GpuAgentGrantDeps {
  accountWriteFence?: typeof lockGpuAccountFence;
  now?: () => Date;
}

export interface GpuAgentGrantView {
  grant_id: string;
  request_id: string;
  project_id: string;
  payload_hash: string;
  state: string;
  expires_at: string;
}

// Approve exactly the request the human saw. Idempotent: approving an
// already approved request with the same hash returns its grant.
export async function approveAgentRequestLocal(
  db: Db,
  opts: {
    account_id: string;
    request_id: unknown;
    expected_hash: unknown;
    fresh_auth_verified?: boolean;
  },
  deps: GpuAgentGrantDeps & {
    // the connected key's id, read under the account fence
    credentialId: (account_id: string) => Promise<string | undefined>;
  },
): Promise<GpuAgentGrantView> {
  const request_id = requireUuid(opts.request_id, "request id");
  if (
    typeof opts.expected_hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(opts.expected_hash)
  ) {
    throw Error("invalid request hash");
  }
  if (opts.fresh_auth_verified !== true) {
    throw Object.assign(
      Error(
        "Approving an agent's GPU launch needs you to sign in again; do it in the browser.",
      ),
      { code: "fresh_auth_required" },
    );
  }
  const now = (deps.now ?? (() => new Date()))();
  // 1. the account fence (as every launch takes first)
  await (deps.accountWriteFence ?? lockGpuAccountFence)(
    db as PoolClient,
    opts.account_id,
    "approve an agent's GPU launch",
  );
  // 2. the request
  const { rows } = await db.query(
    `SELECT * FROM gpu_agent_requests WHERE request_id = $1 FOR UPDATE`,
    [request_id],
  );
  const req = rows[0];
  if (!req || req.account_id !== opts.account_id) {
    throw Error("No such GPU request.");
  }
  if (req.payload_hash !== opts.expected_hash) {
    throw Error(
      "This request isn't the one you reviewed (it changed). Review it again.",
    );
  }
  if (req.state === "approved") {
    const { rows: existing } = await db.query(
      `SELECT grant_id, request_id, project_id, payload_hash, state, expires_at
         FROM gpu_agent_grants WHERE request_id = $1`,
      [request_id],
    );
    if (existing[0]) return grantView(existing[0]);
  }
  if (req.state !== "pending") {
    throw Error(
      `This GPU request is ${req.state}; the agent has to ask again.`,
    );
  }
  if (new Date(req.expires_at) <= now) {
    await db.query(
      `UPDATE gpu_agent_requests SET state = 'expired', decided_at = $2 WHERE request_id = $1`,
      [request_id, now],
    );
    throw Error("This GPU request has expired; the agent has to ask again.");
  }
  // The stored hash must still describe the stored payload.
  if (agentPayloadHash(req.payload) !== req.payload_hash) {
    throw Error("This GPU request is damaged; the agent has to ask again.");
  }
  const payload: GpuAgentPayload = req.payload;
  const credential_id = await deps.credentialId(opts.account_id);
  if (!credential_id) {
    throw Error(
      "No RunPod API key is connected. Connect one in Settings → Connectors.",
    );
  }
  // 3. the key's fence and its key layer, then the new rows
  await ensureKeyBudget(db, {
    credential_id,
    key_owner_account_id: opts.account_id,
    now,
  });
  await lockKeyFence(db, credential_id);
  const { rows: keyLayers } = await db.query(
    `SELECT id FROM gpu_budget_layers WHERE credential_id = $1 AND scope_kind = 'key' FOR UPDATE`,
    [credential_id],
  );
  const grant_id = randomUUID();
  const layer_id = randomUUID();
  const expires_at = new Date(req.expires_at);
  const ends_at = new Date(
    expires_at.getTime() +
      payload.spec.max_runtime_minutes * 60_000 +
      LAYER_MARGIN_MS,
  );
  await db.query(
    `INSERT INTO gpu_budget_layers (id, credential_id, key_owner_account_id, scope_kind,
       parent_id, parent_scope_kind, project_id, agent_id, grant_id,
       authorized_usd, max_hourly_usd, max_concurrent_pods, max_gpu_count,
       max_runtime_minutes, allowed_gpu_type_ids, cloud, starts_at, ends_at,
       state, created, updated)
     VALUES ($1, $2, $3, 'agent', $4, 'key', $5, $6, $7, $8, $9, 1, $10, $11, $12,
       $13, $14, $15, 'active', now(), now())`,
    [
      layer_id,
      credential_id,
      opts.account_id,
      keyLayers[0].id,
      req.project_id,
      req.agent_id,
      grant_id,
      payload.max_cost_usd,
      payload.hourly_usd,
      payload.spec.gpu_count,
      payload.spec.max_runtime_minutes,
      [payload.spec.gpu_type_id],
      payload.spec.cloud ?? "SECURE",
      now,
      ends_at,
    ],
  );
  await db.query(
    `INSERT INTO gpu_agent_grants (grant_id, request_id, account_id, project_id,
       agent_id, run_id, operation_id, payload_hash, credential_id, layer_id,
       launches_allowed, launches_used, state, created, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, 0, 'active', $11, $12)`,
    [
      grant_id,
      request_id,
      opts.account_id,
      req.project_id,
      req.agent_id,
      req.run_id,
      req.operation_id,
      req.payload_hash,
      credential_id,
      layer_id,
      now,
      expires_at,
    ],
  );
  await db.query(
    `UPDATE gpu_agent_requests SET state = 'approved', decided_at = $2,
       decided_by_account_id = $3 WHERE request_id = $1`,
    [request_id, now, opts.account_id],
  );
  await db.query(
    `INSERT INTO gpu_budget_events (id, layer_id, at, actor_account_id, action, after)
     VALUES ($1, $2, now(), $3, 'create', $4)`,
    [
      randomUUID(),
      layer_id,
      opts.account_id,
      {
        grant_id,
        request_id,
        payload_hash: req.payload_hash,
        authorized_usd: payload.max_cost_usd,
        max_hourly_usd: payload.hourly_usd,
      },
    ],
  );
  return grantView({
    grant_id,
    request_id,
    project_id: req.project_id,
    payload_hash: req.payload_hash,
    state: "active",
    expires_at,
  });
}

function grantView(row: any): GpuAgentGrantView {
  return {
    grant_id: row.grant_id,
    request_id: row.request_id,
    project_id: row.project_id,
    payload_hash: row.payload_hash,
    state: row.state,
    expires_at: new Date(row.expires_at).toISOString(),
  };
}

// An explicit revoke: no new launch, and the reaper terminates this grant's
// running pods (they hold reservations on its layer, and only they do).
export async function revokeAgentGrantLocal(
  db: Db,
  opts: { account_id: string; grant_id: unknown },
  deps: GpuAgentGrantDeps = {},
): Promise<GpuAgentGrantView> {
  const grant_id = requireUuid(opts.grant_id, "grant id");
  const now = (deps.now ?? (() => new Date()))();
  await (deps.accountWriteFence ?? lockGpuAccountFence)(
    db as PoolClient,
    opts.account_id,
    "revoke an agent's GPU approval",
  );
  const { rows } = await db.query(
    `SELECT * FROM gpu_agent_grants WHERE grant_id = $1 FOR UPDATE`,
    [grant_id],
  );
  const grant = rows[0];
  if (!grant || grant.account_id !== opts.account_id) {
    throw Error("No such agent GPU approval.");
  }
  if (grant.state === "revoked") return grantView(grant);
  await lockKeyFence(db, grant.credential_id);
  await revokeLockedGrant(db, grant, opts.account_id, now, {});
  return grantView({ ...grant, state: "revoked" });
}

// The grant row is locked (and its key fence, the next in the lock order).
async function revokeLockedGrant(
  db: Db,
  grant: { grant_id: string; layer_id: string },
  by_account_id: string,
  now: Date,
  details: Record<string, unknown>,
): Promise<void> {
  await db.query(`SELECT id FROM gpu_budget_layers WHERE id = $1 FOR UPDATE`, [
    grant.layer_id,
  ]);
  await db.query(
    `UPDATE gpu_agent_grants SET state = 'revoked', revoked_at = $2,
       revoked_by_account_id = $3 WHERE grant_id = $1`,
    [grant.grant_id, now, by_account_id],
  );
  await db.query(
    `UPDATE gpu_budget_layers SET state = 'revoked', revoked_reason = 'owner',
       admission_closed_at = COALESCE(admission_closed_at, $2),
       version = version + 1, updated = now()
      WHERE id = $1`,
    [grant.layer_id, now],
  );
  await db.query(
    `INSERT INTO gpu_budget_events (id, layer_id, at, actor_account_id, action, after)
     VALUES ($1, $2, now(), $3, 'revoke', $4)`,
    [
      randomUUID(),
      grant.layer_id,
      by_account_id,
      { grant_id: grant.grant_id, ...details },
    ],
  );
}

// The kill switch (all of the account's agents, or one project's): every
// active grant is revoked, so its pods go and `gpu resume` brings none back,
// and every pending request ends, so no approval after the kill revives one.
// The human approves again. Call right after the account fence, in the kill
// switch's transaction.
export async function revokeAgentGrantsForKillSwitch(
  db: Db,
  opts: { account_id: string; project_id: string | null; now?: Date },
): Promise<{ grants: number; requests: number; project_ids: string[] }> {
  const now = opts.now ?? new Date();
  const { rows: grants } = await db.query(
    `SELECT grant_id, layer_id, credential_id, project_id FROM gpu_agent_grants
      WHERE account_id = $1 AND ($2::uuid IS NULL OR project_id = $2::uuid)
        AND state = 'active'
      ORDER BY grant_id
      FOR UPDATE`,
    [opts.account_id, opts.project_id],
  );
  const fences = [...new Set(grants.map((g: any) => g.credential_id))].sort();
  for (const credential_id of fences)
    await lockKeyFence(db, `${credential_id}`);
  for (const grant of grants) {
    await revokeLockedGrant(db, grant, opts.account_id, now, {
      reason: "kill_switch",
      project_id: opts.project_id,
    });
  }
  const { rows: requests } = await db.query(
    `UPDATE gpu_agent_requests SET state = 'denied', decided_at = $3,
       decided_by_account_id = $1
      WHERE account_id = $1 AND ($2::uuid IS NULL OR project_id = $2::uuid)
        AND state = 'pending'
      RETURNING project_id`,
    [opts.account_id, opts.project_id, now],
  );
  return {
    grants: grants.length,
    requests: requests.length,
    // whose approval banners changed
    project_ids: [
      ...new Set<string>(
        [...grants, ...requests].map((r: any) => `${r.project_id}`),
      ),
    ],
  };
}

// The human declines a pending request: nothing is approved, and the agent
// has to ask again (a new request). Idempotent; a request already decided
// some other way says so.
export async function denyAgentRequestLocal(
  db: Db,
  opts: { account_id: string; request_id: unknown },
  deps: GpuAgentGrantDeps = {},
): Promise<{ request_id: string; project_id: string; state: string }> {
  const request_id = requireUuid(opts.request_id, "request id");
  const now = (deps.now ?? (() => new Date()))();
  await (deps.accountWriteFence ?? lockGpuAccountFence)(
    db as PoolClient,
    opts.account_id,
    "decline an agent's GPU request",
  );
  const { rows } = await db.query(
    `SELECT request_id, account_id, project_id, state FROM gpu_agent_requests
      WHERE request_id = $1 FOR UPDATE`,
    [request_id],
  );
  const req = rows[0];
  if (!req || req.account_id !== opts.account_id) {
    throw Error("No such GPU request.");
  }
  if (req.state === "approved") {
    throw Error(
      "This GPU request was already approved; revoke its approval instead.",
    );
  }
  if (req.state === "pending") {
    await db.query(
      `UPDATE gpu_agent_requests SET state = 'denied', decided_at = $2,
         decided_by_account_id = $3 WHERE request_id = $1`,
      [request_id, now, opts.account_id],
    );
    return { request_id, project_id: req.project_id, state: "denied" };
  }
  return { request_id, project_id: req.project_id, state: req.state };
}

// The end of a run: admission closes, the layer stays active for its pods.
// Never 'revoked' (that would terminate them). Idempotent; admission also
// checks the grant's expiry itself, so this is cleanup, not a gate.
export async function closeExpiredAgentGrant(
  db: Db,
  opts: { account_id: string; grant_id: string },
  deps: GpuAgentGrantDeps = {},
): Promise<boolean> {
  const now = (deps.now ?? (() => new Date()))();
  await (deps.accountWriteFence ?? lockGpuAccountFence)(
    db as PoolClient,
    opts.account_id,
    "close an expired agent GPU approval",
  );
  const { rows } = await db.query(
    `SELECT * FROM gpu_agent_grants WHERE grant_id = $1 FOR UPDATE`,
    [opts.grant_id],
  );
  const grant = rows[0];
  if (!grant || grant.state !== "active" || new Date(grant.expires_at) > now) {
    return false;
  }
  await lockKeyFence(db, grant.credential_id);
  await db.query(
    `UPDATE gpu_budget_layers SET admission_closed_at = COALESCE(admission_closed_at, $2),
       updated = now() WHERE id = $1`,
    [grant.layer_id, now],
  );
  await db.query(
    `UPDATE gpu_agent_grants SET state = 'expired' WHERE grant_id = $1`,
    [opts.grant_id],
  );
  await db.query(
    `INSERT INTO gpu_budget_events (id, layer_id, at, action, after)
     VALUES ($1, $2, now(), 'close', $3)`,
    [
      randomUUID(),
      grant.layer_id,
      { grant_id: opts.grant_id, reason: "expired", admission_closed: true },
    ],
  );
  return true;
}

// Thrown inside the launch transaction when no grant admits the launch; the
// caller records the request in a transaction of its own.
export class NoUsableAgentGrant extends Error {
  readonly code = "gpu_agent_no_grant";
}
