/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
Project funding approvals on the funder's home bay (H), the money authority
(PROJECT_FUNDING.md §3-4): an approval is a 'project' budget layer under the
funder's key layer, bound to one project by approval_id. The project's
owning bay (P) routes launches to it; see project-funding-routes.ts.

Approve, slot first:
1. P holds the project's one approval slot (pending, with a lease). A second
   funder can't get it; a retry with the same operation gets the same slot.
2. H, in one transaction under the account and key fences: the layer, the
   optional key-budget raise (recorded with its full post-raise snapshot),
   and an 'activate' message in the outbox.
3. The outbox delivers it; P activates the slot while its lease holds. An
   answer that the slot ended (lease ran out, project gone) revokes the
   layer and undoes the raise if nothing has used the key budget since.

Change and revoke apply to the layer first (it's the authority: lowering and
revoking take effect at once), then go to P as versioned messages. The
message version of a layer at layer.version v is v + 1 (P's pending slot is
version 1, so the first activate is 2).
*/

import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "@cocalc/database/pool";
import getPool from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";
import { moneyToDbString, toDecimal } from "@cocalc/util/money";
import type { InterBayGpuApi } from "@cocalc/conat/inter-bay/api";
import {
  canonicalProjectFundingTerms,
  LAUNCH_OPERATION_ID,
  normalizeProjectFundingTerms,
  projectFundingDisplay,
  PROJECT_FUNDING_LEASE_MS,
  type ProjectFundingDeliverRequest,
  type ProjectFundingDeliverResult,
  type ProjectFundingDisplay,
  type ProjectFundingEndedOnProjectRequest,
  type ProjectFundingEndedReason,
  type ProjectFundingMessage,
  type ProjectFundingReserveRequest,
  type ProjectFundingReserveResult,
  type ProjectFundingStatusRequest,
  type ProjectFundingStatusResult,
  type ProjectFundingTerms,
} from "@cocalc/util/gpu/project-funding";
import { lockGpuAccountFence } from "@cocalc/server/gpu/account-fence";
import { ensureKeyBudget, lockKeyFence } from "@cocalc/server/gpu/budgets";
import { inTransaction } from "@cocalc/server/gpu/pods";
import { launchKeyMeta } from "@cocalc/server/gpu/provider-keys";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { every } from "@cocalc/server/gpu/reaper";
import {
  LIVE_POD_SQL,
  syncProjectFundingPodLocator,
  deliverProjectFundingMessageLocal,
  enqueueProjectFundingMessage,
  expireProjectFundingLeases,
  projectFundingStatusLocal,
  reserveProjectFundingSlotLocal,
  type ProjectFundingRouteDeps,
} from "@cocalc/server/gpu/project-funding-routes";

type Db = Pick<PoolClient, "query">;

// What H needs from P: the three P methods, called locally when P is this
// bay, else over the inter-bay service of P's current owning bay.
export interface ProjectBayCalls {
  reserve(
    req: ProjectFundingReserveRequest,
  ): Promise<ProjectFundingReserveResult>;
  deliver(
    req: ProjectFundingDeliverRequest,
  ): Promise<ProjectFundingDeliverResult>;
  status(req: ProjectFundingStatusRequest): Promise<ProjectFundingStatusResult>;
}

export interface ProjectFundingDeps {
  // for tests
  credentialId?: (account_id: string) => Promise<string | undefined>;
  accountWriteFence?: typeof lockGpuAccountFence;
  // the calls to the project's current owning bay, resolved at each use
  projectBay?: (project_id: string) => Promise<ProjectBayCalls>;
  // a P-to-H call: the project's current owning bay must be the sender
  assertSentByProjectBay?: (
    source_bay_id: unknown,
    project_id: string,
  ) => Promise<void>;
  // the funder's current home bay, for P-to-H messages from P's outbox
  funderBay?: (account_id: string) => Promise<FunderBayCalls>;
  funderName?: (account_id: string) => Promise<string | undefined>;
  routeDeps?: ProjectFundingRouteDeps;
  now?: () => Date;
}

export interface FunderBayCalls {
  endedOnProject(
    req: ProjectFundingEndedOnProjectRequest,
  ): Promise<{ revoked: boolean }>;
}

export interface ProjectFundingView {
  approval_id: string;
  layer_id: string;
  project_id: string;
  state: string;
  // whether the project's bay has confirmed the approval active
  activated: boolean;
  authorized_usd: string;
  spent_usd: string;
  reserved_usd: string;
  available_usd: string;
  starts_at: string;
  ends_at: string;
  agents_allowed: boolean;
  version: number;
}

class Retryable extends Error {
  readonly retryable = true;
}

function requireAccount(account_id: unknown): string {
  if (typeof account_id !== "string" || !isValidUUID(account_id)) {
    throw Error("must be signed in");
  }
  return account_id;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || !isValidUUID(value)) {
    throw Error(`${label} must be a UUID.`);
  }
  return value;
}

// An approval's id is derived from its funder and operation, so a retried
// approve (lost response, crash) names the same slot and the same layer.
export function projectFundingApprovalId(
  funder_account_id: string,
  operation_id: string,
): string {
  const h = createHash("sha256")
    .update(`project-funding:${funder_account_id}:${operation_id}`)
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(
    (parseInt(h[16], 16) & 0x3) |
    0x8
  ).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function projectFundingTermsHash(
  project_id: string,
  terms: ProjectFundingTerms,
  raise_key_budget_to: string | null,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        project_id,
        terms: canonicalProjectFundingTerms(terms),
        raise_key_budget_to,
      }),
    )
    .digest("hex");
}

async function credentialIdFor(account_id: string) {
  return (await launchKeyMeta(account_id))?.credential_id;
}

async function requireKey(account_id: string, deps: ProjectFundingDeps) {
  const credential_id = await (deps.credentialId ?? credentialIdFor)(
    account_id,
  );
  if (!credential_id) {
    throw Error(
      "To approve GPU use in a project, connect your own RunPod key in Settings → Connectors.",
    );
  }
  return credential_id;
}

async function defaultProjectBay(project_id: string): Promise<ProjectBayCalls> {
  const { resolveProjectBay } =
    await import("@cocalc/server/inter-bay/directory");
  const owner = (await resolveProjectBay(project_id))?.bay_id;
  const bay = `${owner ?? ""}`.trim() || getConfiguredBayId();
  if (bay === getConfiguredBayId()) {
    return {
      reserve: (req) => reserveProjectFundingSlotLocal(req),
      deliver: (req) => deliverProjectFundingMessageLocal(req),
      status: (req) => projectFundingStatusLocal(req),
    };
  }
  const client = await accountLocalClient(bay);
  return {
    reserve: (req) => client.gpuProjectFundingReserve(req),
    deliver: (req) => client.gpuProjectFundingDeliver(req),
    status: (req) => client.gpuProjectFundingStatus(req),
  };
}

async function accountLocalClient(dest_bay: string): Promise<InterBayGpuApi> {
  const { createInterBayAccountLocalClient } =
    await import("@cocalc/conat/inter-bay/api");
  const { getInterBayFabricClient } =
    await import("@cocalc/server/inter-bay/fabric");
  return createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay,
    timeout: 30_000,
  });
}

async function defaultAssertSentByProjectBay(
  source_bay_id: unknown,
  project_id: string,
): Promise<void> {
  if (source_bay_id === getConfiguredBayId()) {
    // in process: this bay must own the project
    const { resolveProjectBayDirect } =
      await import("@cocalc/server/inter-bay/directory");
    const owner = (await resolveProjectBayDirect(project_id))?.bay_id;
    if ((owner ?? getConfiguredBayId()) === getConfiguredBayId()) return;
  }
  const { assertSentByProjectOwner } =
    await import("@cocalc/server/inter-bay/course-access");
  await assertSentByProjectOwner({
    source_bay_id: typeof source_bay_id === "string" ? source_bay_id : "",
    project_id,
    what: "project funding",
  });
}

async function defaultFunderBay(account_id: string): Promise<FunderBayCalls> {
  const { home_bay_id } = await resolveAccountHomeBay({
    account_id,
    user_account_id: account_id,
  });
  const bay = `${home_bay_id ?? ""}`.trim() || getConfiguredBayId();
  if (bay === getConfiguredBayId()) {
    return { endedOnProject: (req) => projectFundingEndedOnProjectLocal(req) };
  }
  const client = await accountLocalClient(bay);
  return {
    endedOnProject: (req) => client.gpuProjectFundingEndedOnProject(req),
  };
}

async function defaultFunderName(account_id: string) {
  const { rows } = await getPool().query(
    "SELECT first_name, last_name FROM accounts WHERE account_id = $1",
    [account_id],
  );
  const r = rows[0];
  if (!r) return undefined;
  return `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || undefined;
}

function displayOf(layer: any, funder_name?: string): ProjectFundingDisplay {
  const d: ProjectFundingDisplay = {
    authorized_usd: moneyToDbString(layer.authorized_usd),
    ends_at: new Date(layer.ends_at).toISOString(),
    agents_allowed: !!layer.agents_allowed,
  };
  if (funder_name) d.funder_name = funder_name;
  if (layer.max_hourly_usd != null) {
    d.max_hourly_usd = moneyToDbString(layer.max_hourly_usd);
  }
  for (const k of [
    "max_concurrent_pods",
    "max_gpu_count",
    "max_runtime_minutes",
  ] as const) {
    if (layer[k] != null) d[k] = layer[k];
  }
  if (layer.allowed_gpu_type_ids != null) {
    d.allowed_gpu_type_ids = layer.allowed_gpu_type_ids;
  }
  if (layer.cloud != null) d.cloud = layer.cloud;
  return d;
}

export function projectFundingView(layer: any): ProjectFundingView {
  const available = toDecimal(layer.authorized_usd)
    .minus(layer.spent_usd)
    .minus(layer.reserved_usd)
    .minus(layer.released_usd);
  return {
    approval_id: layer.approval_id,
    layer_id: layer.id,
    project_id: layer.project_id,
    state: layer.state,
    activated: layer.activation_acked_at != null,
    authorized_usd: moneyToDbString(layer.authorized_usd),
    spent_usd: moneyToDbString(layer.spent_usd),
    reserved_usd: moneyToDbString(layer.reserved_usd),
    available_usd: moneyToDbString(available.lt(0) ? 0 : available),
    starts_at: new Date(layer.starts_at).toISOString(),
    ends_at: new Date(layer.ends_at).toISOString(),
    agents_allowed: !!layer.agents_allowed,
    version: layer.version,
  };
}

async function event(
  db: Db,
  layer_id: string,
  actor_account_id: string | null,
  action: "create" | "update" | "revoke",
  before: unknown,
  after: unknown,
) {
  await db.query(
    `INSERT INTO gpu_budget_events (id, layer_id, at, actor_account_id, action, before, after)
     VALUES ($1, $2, now(), $3, $4, $5, $6)`,
    [
      randomUUID(),
      layer_id,
      actor_account_id,
      action,
      before == null ? null : JSON.stringify(before),
      after == null ? null : JSON.stringify(after),
    ],
  );
}

function snapshot(layer: any) {
  return {
    version: layer.version,
    authorized_usd: moneyToDbString(layer.authorized_usd),
    spent_usd: moneyToDbString(layer.spent_usd),
    reserved_usd: moneyToDbString(layer.reserved_usd),
    released_usd: moneyToDbString(layer.released_usd),
  };
}

// ---- approve ----

export async function approveProjectFundingLocal(
  opts: {
    account_id?: string;
    project_id?: unknown;
    terms?: unknown;
    operation_id?: unknown;
    raise_key_budget_to?: unknown;
    fresh_auth_verified?: boolean;
  },
  deps: ProjectFundingDeps = {},
): Promise<ProjectFundingView> {
  const account_id = requireAccount(opts.account_id);
  const project_id = requireId(opts.project_id, "project_id");
  const operation_id = requireId(opts.operation_id, "operation_id");
  if (opts.fresh_auth_verified !== true) {
    throw Object.assign(
      Error(
        "Approving GPU use in a project needs you to sign in again; do it from the project in the browser.",
      ),
      { code: "fresh_auth_required" },
    );
  }
  const terms = normalizeProjectFundingTerms(opts.terms);
  let raise: string | null = null;
  if (opts.raise_key_budget_to != null) {
    raise = normalizeProjectFundingTerms({
      ...terms,
      authorized_usd: opts.raise_key_budget_to,
    }).authorized_usd;
  }
  const now = (deps.now ?? (() => new Date()))();
  const credential_id = await requireKey(account_id, deps);
  const approval_id = projectFundingApprovalId(account_id, operation_id);
  const terms_hash = projectFundingTermsHash(project_id, terms, raise);
  const funder_name = await (deps.funderName ?? defaultFunderName)(account_id);
  const ends_at = new Date(now.getTime() + terms.days * 24 * 60 * 60_000);
  const p = await (deps.projectBay ?? defaultProjectBay)(project_id);

  // 1. the slot
  const reserved = await p.reserve({
    source_bay_id: getConfiguredBayId(),
    project_id,
    provider: terms.provider,
    approval_id,
    operation_id,
    terms_hash,
    funder_account_id: account_id,
    display: projectFundingDisplay(terms, ends_at, funder_name),
  });
  if (reserved.status === "rehoming") {
    throw new Retryable(
      "This project is moving between servers right now; try again in a minute.",
    );
  }
  if (reserved.status === "not_collaborator") {
    throw Error(
      "Only a collaborator on this project can approve GPU use in it.",
    );
  }
  if (reserved.status === "taken") {
    // A retry of an approval that already got past this step returns it.
    const existing = await layerByApproval(getPool(), approval_id, account_id);
    if (existing) return projectFundingView(existing);
    throw Error(reserved.message);
  }

  // 2. the layer, the raise, the activate message
  const layer = await inTransaction(async (db) => {
    await (deps.accountWriteFence ?? lockGpuAccountFence)(
      db,
      account_id,
      "approve GPU use in a project",
    );
    await ensureKeyBudget(db, {
      credential_id,
      key_owner_account_id: account_id,
    });
    const fence = await lockKeyFence(db, credential_id);
    if (fence.state !== "active") {
      throw Error(
        "Your RunPod key isn't active (it is being removed or was reported compromised); connect a key first.",
      );
    }
    const { rows: keyRows } = await db.query(
      `SELECT * FROM gpu_budget_layers WHERE credential_id = $1 AND scope_kind = 'key' FOR UPDATE`,
      [credential_id],
    );
    const key = keyRows[0];
    const { rows: mine } = await db.query(
      `SELECT * FROM gpu_budget_layers WHERE approval_id = $1 AND scope_kind = 'project'`,
      [approval_id],
    );
    if (mine[0]) return mine[0];
    let raised: unknown = null;
    if (raise != null && toDecimal(raise).gt(key.authorized_usd)) {
      const { rows: up } = await db.query(
        `UPDATE gpu_budget_layers SET authorized_usd = $2, version = version + 1, updated = now()
          WHERE id = $1 RETURNING *`,
        [key.id, raise],
      );
      raised = { approval_id, snapshot: snapshot(up[0]) };
      await event(
        db,
        key.id,
        account_id,
        "update",
        { authorized_usd: moneyToDbString(key.authorized_usd) },
        { authorized_usd: raise, raised_for_approval: raised },
      );
    }
    const id = randomUUID();
    const { rows } = await db.query(
      `INSERT INTO gpu_budget_layers (id, credential_id, key_owner_account_id, scope_kind,
         parent_id, parent_scope_kind, project_id, approval_id, agents_allowed,
         authorized_usd, max_hourly_usd, max_concurrent_pods, max_gpu_count,
         max_runtime_minutes, allowed_gpu_type_ids, cloud, starts_at, ends_at,
         state, version, created, updated)
       VALUES ($1, $2, $3, 'project', $4, 'key', $5, $6, $7, $8, $9, $10, $11, $12,
               $13, $14, $15, $16, 'active', 1, now(), now())
       RETURNING *`,
      [
        id,
        credential_id,
        account_id,
        key.id,
        project_id,
        approval_id,
        terms.agents_allowed,
        terms.authorized_usd,
        terms.max_hourly_usd ?? null,
        terms.max_concurrent_pods ?? null,
        terms.max_gpu_count ?? null,
        terms.max_runtime_minutes ?? null,
        terms.allowed_gpu_type_ids ?? null,
        terms.cloud ?? null,
        now,
        ends_at,
      ],
    );
    await event(db, id, account_id, "create", null, {
      approval_id,
      project_id,
      terms,
      key_budget_raise: raised,
    });
    await enqueueProjectFundingMessage(db, {
      approval_id,
      project_id,
      target: "project",
      funder_account_id: account_id,
      kind: "activate",
      version: 2,
      payload: { layer_id: id, display: displayOf(rows[0], funder_name) },
      now,
    });
    return rows[0];
  });

  // 3. deliver now if we can (the worker retries otherwise)
  await deliverProjectFundingOutbox({ approval_id }, deps).catch(() => {});
  return projectFundingView(
    (await layerByApproval(getPool(), approval_id, account_id)) ?? layer,
  );
}

async function layerByApproval(
  db: Db,
  approval_id: string,
  key_owner_account_id: string,
  lock = false,
) {
  const { rows } = await db.query(
    `SELECT * FROM gpu_budget_layers
      WHERE approval_id = $1 AND key_owner_account_id = $2 AND scope_kind = 'project'
      ${lock ? "FOR UPDATE" : ""}`,
    [approval_id, key_owner_account_id],
  );
  return rows[0];
}

// ---- change ----

const CHANGEABLE = [
  "authorized_usd",
  "max_hourly_usd",
  "max_concurrent_pods",
  "max_gpu_count",
  "max_runtime_minutes",
  "agents_allowed",
] as const;

export async function changeProjectFundingLocal(
  opts: {
    account_id?: string;
    approval_id?: unknown;
    change?: Record<string, unknown>;
    fresh_auth_verified?: boolean;
  },
  deps: ProjectFundingDeps = {},
): Promise<ProjectFundingView> {
  const account_id = requireAccount(opts.account_id);
  const approval_id = requireId(opts.approval_id, "approval_id");
  const change = opts.change ?? {};
  const keys = Object.keys(change).filter((k) =>
    (CHANGEABLE as readonly string[]).includes(k),
  );
  if (keys.length === 0) throw Error("Nothing to change.");
  const funder_name = await (deps.funderName ?? defaultFunderName)(account_id);
  await inTransaction(async (db) => {
    await (deps.accountWriteFence ?? lockGpuAccountFence)(
      db,
      account_id,
      "change a project's GPU funding",
    );
    const found = await layerByApproval(db, approval_id, account_id);
    if (!found) throw Error("No such approval.");
    await lockKeyFence(db, found.credential_id);
    const layer = await layerByApproval(db, approval_id, account_id, true);
    if (layer.state !== "active") {
      throw Error("This approval has ended; approve again instead.");
    }
    // validate as terms, against the current ones
    const current: Record<string, unknown> = {
      provider: "runpod",
      authorized_usd: moneyToDbString(layer.authorized_usd),
      days: 1,
      agents_allowed: !!layer.agents_allowed,
    };
    const next = normalizeProjectFundingTerms({
      ...current,
      ...(layer.max_hourly_usd != null
        ? { max_hourly_usd: moneyToDbString(layer.max_hourly_usd) }
        : {}),
      ...Object.fromEntries(
        ["max_concurrent_pods", "max_gpu_count", "max_runtime_minutes"]
          .filter((k) => layer[k] != null)
          .map((k) => [k, layer[k]]),
      ),
      ...Object.fromEntries(
        keys.filter((k) => change[k] != null).map((k) => [k, change[k]]),
      ),
    });
    const fields: Record<string, unknown> = {};
    const raises: string[] = [];
    for (const k of keys) {
      const v = change[k] == null ? null : (next as any)[k];
      fields[k] = v;
      const old = layer[k];
      if (k === "agents_allowed") {
        if (v === true && !old) raises.push(k);
      } else if (v == null) {
        if (old != null) raises.push(k); // removing a cap loosens
      } else if (old == null || toDecimal(`${v}`).gt(`${old}`)) {
        if (old != null || k === "authorized_usd") raises.push(k);
      }
    }
    if (fields.authorized_usd == null && keys.includes("authorized_usd")) {
      throw Error("The amount is required.");
    }
    if (raises.length > 0 && opts.fresh_auth_verified !== true) {
      throw Object.assign(
        Error(
          `Raising ${raises.join(", ")} needs you to sign in again. Lowering doesn't.`,
        ),
        { code: "fresh_auth_required" },
      );
    }
    const { rows } = await db.query(
      `UPDATE gpu_budget_layers
          SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")},
              version = version + 1, updated = now()
        WHERE id = $1 RETURNING *`,
      [layer.id, ...keys.map((k) => fields[k])],
    );
    await event(
      db,
      layer.id,
      account_id,
      "update",
      Object.fromEntries(keys.map((k) => [k, layer[k]])),
      fields,
    );
    await enqueueProjectFundingMessage(db, {
      approval_id,
      project_id: layer.project_id,
      target: "project",
      funder_account_id: account_id,
      kind: "update",
      version: rows[0].version + 1,
      payload: { display: displayOf(rows[0], funder_name) },
    });
  });
  await deliverProjectFundingOutbox({ approval_id }, deps).catch(() => {});
  return projectFundingView(
    await layerByApproval(getPool(), approval_id, account_id),
  );
}

// ---- revoke and end ----

// End the layer for good and tell P (and undo an approval's key-budget
// raise when it never activated). Caller holds the account fence; this
// takes the key fence and the layer.
async function endLayer(
  db: Db,
  layer: any,
  reason: ProjectFundingEndedReason,
  actor_account_id: string | null,
  now: Date,
): Promise<boolean> {
  await lockKeyFence(db, layer.credential_id);
  const { rows: locked } = await db.query(
    `SELECT * FROM gpu_budget_layers WHERE id = $1 FOR UPDATE`,
    [layer.id],
  );
  const l = locked[0];
  if (!l || !["active", "scheduled", "suspended"].includes(l.state)) {
    return false;
  }
  const state = reason === "expired" ? "expired" : "revoked";
  const revoked_reason =
    reason === "revoked"
      ? "owner"
      : reason === "lease_expired"
        ? "activation_failed"
        : reason;
  const { rows } = await db.query(
    `UPDATE gpu_budget_layers
        SET state = $2, revoked_reason = $3, ended_at = $4,
            admission_closed_at = COALESCE(admission_closed_at, $4),
            version = version + 1, updated = now()
      WHERE id = $1 RETURNING *`,
    [l.id, state, revoked_reason, now],
  );
  await event(
    db,
    l.id,
    actor_account_id,
    "revoke",
    { state: l.state },
    { state, revoked_reason },
  );
  // an approval that never activated: undo the raise made for it
  if (l.activation_acked_at == null) {
    await undoKeyBudgetRaise(db, l);
  }
  await enqueueProjectFundingMessage(db, {
    approval_id: l.approval_id,
    project_id: l.project_id,
    target: "project",
    funder_account_id: l.key_owner_account_id,
    kind: "end",
    version: rows[0].version + 1,
    payload: {
      reason,
      live_pods: rows[0].live_pods,
      pods_version: rows[0].pods_version,
    },
    now,
  });
  return true;
}

// Undo a key-budget raise made for an approval that never activated, only
// if the key layer is exactly as the raise left it (version and every
// money column); otherwise the raise stays (it had its own fresh auth) and
// the skip is recorded.
async function undoKeyBudgetRaise(db: Db, projectLayer: any): Promise<void> {
  const { rows: created } = await db.query(
    `SELECT after FROM gpu_budget_events WHERE layer_id = $1 AND action = 'create'
      ORDER BY at LIMIT 1`,
    [projectLayer.id],
  );
  const raise = created[0]?.after?.key_budget_raise;
  if (!raise?.snapshot) return;
  const { rows } = await db.query(
    `SELECT * FROM gpu_budget_layers WHERE id = $1 FOR UPDATE`,
    [projectLayer.parent_id],
  );
  const key = rows[0];
  if (!key) return;
  const { rows: raisedEvent } = await db.query(
    `SELECT before FROM gpu_budget_events
      WHERE layer_id = $1 AND action = 'update'
        AND after->'raised_for_approval'->>'approval_id' = $2
      ORDER BY at DESC LIMIT 1`,
    [key.id, projectLayer.approval_id],
  );
  const before = raisedEvent[0]?.before?.authorized_usd;
  const now = snapshot(key);
  // field by field (stored JSONB doesn't keep key order)
  const same =
    before != null &&
    Object.keys(now).every(
      (k) => `${(now as any)[k]}` === `${raise.snapshot[k]}`,
    );
  if (!same) {
    await event(db, key.id, null, "update", null, {
      raise_kept_for_approval: projectLayer.approval_id,
      reason:
        "The key budget changed after the raise (a launch or another change), so the raise for an approval that never activated was kept.",
    });
    return;
  }
  await db.query(
    `UPDATE gpu_budget_layers SET authorized_usd = $2, version = version + 1, updated = now()
      WHERE id = $1`,
    [key.id, before],
  );
  await event(
    db,
    key.id,
    null,
    "update",
    { authorized_usd: now.authorized_usd },
    {
      authorized_usd: before,
      raise_undone_for_approval: projectLayer.approval_id,
    },
  );
}

export async function revokeProjectFundingLocal(
  opts: { account_id?: string; approval_id?: unknown },
  deps: ProjectFundingDeps = {},
): Promise<ProjectFundingView> {
  const account_id = requireAccount(opts.account_id);
  const approval_id = requireId(opts.approval_id, "approval_id");
  const now = (deps.now ?? (() => new Date()))();
  await inTransaction(async (db) => {
    await (deps.accountWriteFence ?? lockGpuAccountFence)(
      db,
      account_id,
      "revoke a project's GPU funding",
    );
    const layer = await layerByApproval(db, approval_id, account_id);
    if (!layer) throw Error("No such approval.");
    await endLayer(db, layer, "revoked", account_id, now);
  });
  await deliverProjectFundingOutbox({ approval_id }, deps).catch(() => {});
  return projectFundingView(
    await layerByApproval(getPool(), approval_id, account_id),
  );
}

// P -> H: P ended the route itself (the slot's lease ran out, the project
// was deleted). Only the project's current owning bay may say so.
export async function projectFundingEndedOnProjectLocal(
  req: ProjectFundingEndedOnProjectRequest,
  deps: ProjectFundingDeps = {},
): Promise<{ revoked: boolean }> {
  const project_id = requireId(req?.project_id, "project_id");
  const approval_id = requireId(req.approval_id, "approval_id");
  const funder = requireId(req.funder_account_id, "funder_account_id");
  await (deps.assertSentByProjectBay ?? defaultAssertSentByProjectBay)(
    req.source_bay_id,
    project_id,
  );
  const now = (deps.now ?? (() => new Date()))();
  return await inTransaction(async (db) => {
    await (deps.accountWriteFence ?? lockGpuAccountFence)(
      db,
      funder,
      "end a project's GPU funding",
    );
    const layer = await layerByApproval(db, approval_id, funder);
    if (!layer || layer.project_id !== project_id) return { revoked: false };
    const reason: ProjectFundingEndedReason =
      req.reason === "project_deleted" ? "project_deleted" : "lease_expired";
    return { revoked: await endLayer(db, layer, reason, null, now) };
  });
}

// ---- outbox delivery (each bay delivers the messages it queued) ----

const RETRY_MS = [5_000, 15_000, 60_000, 5 * 60_000, 10 * 60_000];

function messageOf(row: any): ProjectFundingMessage {
  const p = row.payload ?? {};
  switch (row.kind) {
    case "activate":
      return {
        kind: "activate",
        approval_id: row.approval_id,
        version: row.version,
        layer_id: p.layer_id,
        display: p.display,
      };
    case "update":
      return {
        kind: "update",
        approval_id: row.approval_id,
        version: row.version,
        display: p.display,
      };
    case "end":
      return {
        kind: "end",
        approval_id: row.approval_id,
        version: row.version,
        reason: p.reason,
        live_pods: p.live_pods ?? 0,
        pods_version: p.pods_version ?? 0,
      };
    default:
      return {
        kind: "pods",
        approval_id: row.approval_id,
        live_pods: p.live_pods ?? 0,
        pods_version: row.version,
      };
  }
}

async function claim(opts: { approval_id?: string; limit?: number }) {
  const { rows } = await getPool().query(
    `UPDATE project_funding_outbox SET claimed_until = now() + interval '60 seconds',
            attempts = attempts + 1
      WHERE id IN (
        SELECT o.id FROM project_funding_outbox o
         WHERE o.delivered_at IS NULL AND o.next_attempt_at <= now()
           AND (o.claimed_until IS NULL OR o.claimed_until < now())
           ${opts.approval_id ? "AND o.approval_id = $2" : ""}
           -- in order: only the earliest undelivered message of its
           -- sequence (approval-state messages per approval and direction;
           -- pod counts their own), whoever holds an earlier one
           AND NOT EXISTS (
             SELECT 1 FROM project_funding_outbox e
              WHERE e.approval_id = o.approval_id AND e.target = o.target
                AND e.delivered_at IS NULL AND e.version < o.version
                AND (e.kind = 'pods') = (o.kind = 'pods'))
         ORDER BY o.approval_id, o.version, o.created
         LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    opts.approval_id
      ? [opts.limit ?? 50, opts.approval_id]
      : [opts.limit ?? 50],
  );
  return rows.sort(
    (a: any, b: any) =>
      a.approval_id.localeCompare(b.approval_id) || a.version - b.version,
  );
}

async function settle(id: string, error?: string, attempts = 1) {
  if (error == null) {
    await getPool().query(
      `UPDATE project_funding_outbox SET delivered_at = now(), claimed_until = NULL, last_error = NULL WHERE id = $1`,
      [id],
    );
    return;
  }
  const wait = RETRY_MS[Math.min(attempts - 1, RETRY_MS.length - 1)];
  await getPool().query(
    `UPDATE project_funding_outbox
        SET claimed_until = NULL, last_error = $2,
            next_attempt_at = now() + ($3 || ' milliseconds')::interval
      WHERE id = $1`,
    [id, error.slice(0, 500), `${wait}`],
  );
}

// Deliver due messages. Returns how many were delivered.
export async function deliverProjectFundingOutbox(
  opts: { approval_id?: string; limit?: number } = {},
  deps: ProjectFundingDeps = {},
): Promise<number> {
  let delivered = 0;
  for (const row of await claim(opts)) {
    try {
      if (row.target === "project") {
        const p = await (deps.projectBay ?? defaultProjectBay)(row.project_id);
        const result = await p.deliver({
          source_bay_id: getConfiguredBayId(),
          project_id: row.project_id,
          funder_account_id: row.funder_account_id,
          message: messageOf(row),
        });
        if (result.status === "rehoming") {
          await settle(row.id, "project rehoming", row.attempts);
          continue;
        }
        // An update reaching a slot not yet active is early, not an ack
        // (ordering makes this rare; it is retried, never dropped).
        if (
          row.kind === "update" &&
          result.status === "committed" &&
          result.state === "pending"
        ) {
          await settle(row.id, "approval not active yet", row.attempts);
          continue;
        }
        await afterProjectAnswer(row, result, deps);
      } else {
        const h = await (deps.funderBay ?? defaultFunderBay)(
          row.funder_account_id,
        );
        await h.endedOnProject({
          source_bay_id: getConfiguredBayId(),
          project_id: row.project_id,
          approval_id: row.approval_id,
          funder_account_id: row.funder_account_id,
          reason: row.payload?.reason ?? "lease_expired",
          version: row.version,
        });
      }
      await settle(row.id);
      delivered += 1;
    } catch (err) {
      await settle(row.id, `${err}`, row.attempts);
    }
  }
  return delivered;
}

// What P's answer to H's message means for the layer.
async function afterProjectAnswer(
  row: any,
  result: Exclude<ProjectFundingDeliverResult, { status: "rehoming" }>,
  deps: ProjectFundingDeps,
): Promise<void> {
  if (row.kind !== "activate") return;
  const ended =
    result.status === "unknown_approval" ||
    (result.status === "committed" && result.state === "ended");
  const reason = activationEndReason(
    result.status === "committed" ? result.ended_reason : null,
  );
  const now = (deps.now ?? (() => new Date()))();
  await inTransaction(async (db) => {
    await (deps.accountWriteFence ?? lockGpuAccountFence)(
      db,
      row.funder_account_id,
      "activate a project's GPU funding",
    );
    const layer = await layerByApproval(
      db,
      row.approval_id,
      row.funder_account_id,
    );
    if (!layer) return;
    if (ended) {
      await endLayer(db, layer, reason, null, now);
    } else if (result.status === "committed" && result.state === "active") {
      await db.query(
        `UPDATE gpu_budget_layers SET activation_acked_at = COALESCE(activation_acked_at, now()), updated = now()
          WHERE id = $1`,
        [layer.id],
      );
    }
  });
}

// Why an activation that P ended ends the layer: the binding P found lost,
// else the activation failed.
function activationEndReason(
  ended_reason: ProjectFundingEndedReason | null | undefined,
): ProjectFundingEndedReason {
  return ended_reason === "project_deleted" ||
    ended_reason === "funder_left_project"
    ? ended_reason
    : "lease_expired";
}

// ---- reconciliation (H) ----

// Activations never acknowledged (lost responses, crashes) are resolved by
// asking P; approvals past their end are ended. Returns what changed.
export async function reconcileProjectFunding(
  deps: ProjectFundingDeps = {},
): Promise<{ acked: number; ended: number }> {
  const now = (deps.now ?? (() => new Date()))();
  let acked = 0;
  let ended = 0;
  const { rows: unacked } = await getPool().query(
    `SELECT * FROM gpu_budget_layers
      WHERE scope_kind = 'project' AND state = 'active'
        AND activation_acked_at IS NULL AND created < $1
      ORDER BY created LIMIT 100`,
    [new Date(now.getTime() - PROJECT_FUNDING_LEASE_MS - 2 * 60_000)],
  );
  for (const layer of unacked) {
    try {
      const p = await (deps.projectBay ?? defaultProjectBay)(layer.project_id);
      const s = await p.status({
        source_bay_id: getConfiguredBayId(),
        project_id: layer.project_id,
        approval_id: layer.approval_id,
        funder_account_id: layer.key_owner_account_id,
      });
      if (s.status === "rehoming") continue;
      // A route P reports active is acknowledged only while its binding
      // holds; otherwise the approval ends, never activates.
      const lost =
        s.status === "found" && s.state === "active"
          ? s.project_deleted
            ? ("project_deleted" as const)
            : !s.funder_is_collaborator
              ? ("funder_left_project" as const)
              : undefined
          : undefined;
      if (s.status === "found" && s.state === "active" && !lost) {
        await getPool().query(
          `UPDATE gpu_budget_layers SET activation_acked_at = COALESCE(activation_acked_at, now())
            WHERE id = $1`,
          [layer.id],
        );
        acked += 1;
      } else if (
        lost ||
        s.status === "unknown_approval" ||
        s.state === "ended"
      ) {
        const reason =
          lost ??
          (s.status === "unknown_approval"
            ? s.project_deleted
              ? "project_deleted"
              : "lease_expired"
            : activationEndReason(s.ended_reason));
        const did = await inTransaction(async (db) => {
          await (deps.accountWriteFence ?? lockGpuAccountFence)(
            db,
            layer.key_owner_account_id,
            "end a project's GPU funding",
          );
          return await endLayer(db, layer, reason, null, now);
        });
        if (did) ended += 1;
      }
    } catch {
      // the next pass tries again
    }
  }
  const { rows: past } = await getPool().query(
    `SELECT * FROM gpu_budget_layers
      WHERE scope_kind = 'project' AND state = 'active' AND ends_at <= $1
      ORDER BY ends_at LIMIT 100`,
    [now],
  );
  for (const layer of past) {
    const did = await inTransaction(async (db) => {
      await (deps.accountWriteFence ?? lockGpuAccountFence)(
        db,
        layer.key_owner_account_id,
        "end a project's GPU funding",
      );
      return await endLayer(db, layer, "expired", null, now);
    }).catch(() => false);
    if (did) ended += 1;
  }
  return { acked, ended };
}

// ---- workers ----

export const PROJECT_FUNDING_OUTBOX_INTERVAL_MS = 15_000;
export const PROJECT_FUNDING_RECONCILE_INTERVAL_MS = 60_000;

// Every API hub delivers its bay's outbox (claims are row-locked) and
// reconciles (idempotent, under the same fences as the API).
export const PROJECT_FUNDING_BINDING_INTERVAL_MS = 5 * 60_000;
export const PROJECT_FUNDING_LOCATOR_INTERVAL_MS = 10 * 60_000;

export function initProjectFunding(): void {
  every(
    "project_funding_outbox",
    () => deliverProjectFundingOutbox(),
    PROJECT_FUNDING_OUTBOX_INTERVAL_MS,
  );
  every(
    "project_funding_reconcile",
    async () => {
      await expireProjectFundingLeases();
      await reconcileProjectFunding();
    },
    PROJECT_FUNDING_RECONCILE_INTERVAL_MS,
  );
  every(
    "project_funding_bindings",
    () => checkProjectFundingBindings(),
    PROJECT_FUNDING_BINDING_INTERVAL_MS,
  );
  every(
    "project_funding_locator",
    () => reconcileProjectFundingLocators(),
    PROJECT_FUNDING_LOCATOR_INTERVAL_MS,
  );
}

// ---- the locator's reconciliation and the binding check (§3, §7) ----

// Recount live pods for every approval that might have any: the layers
// that are active or record a positive count, and (so a wrong zero is
// found too) every approval of a pod that is actually live. Returns how
// many counts changed.
export async function reconcileProjectFundingLocators(): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT approval_id FROM gpu_budget_layers
      WHERE scope_kind = 'project' AND (state = 'active' OR live_pods > 0)
     UNION
     SELECT DISTINCT approval_id FROM gpu_pods
      WHERE approval_id IS NOT NULL AND ${LIVE_POD_SQL}`,
  );
  let changed = 0;
  for (const { approval_id } of rows) {
    const before = await getPool().query(
      "SELECT live_pods FROM gpu_budget_layers WHERE approval_id = $1",
      [approval_id],
    );
    const after = await inTransaction(async (db) => {
      const { rows: l } = await db.query(
        `SELECT credential_id FROM gpu_budget_layers WHERE approval_id = $1`,
        [approval_id],
      );
      if (!l[0]) return undefined;
      await lockKeyFence(db, l[0].credential_id);
      return await syncProjectFundingPodLocator(db, approval_id);
    }).catch(() => undefined);
    if (after != null && after !== before.rows[0]?.live_pods) changed += 1;
  }
  return changed;
}

// Every active approval's binding, asked of the project's bay: the project
// still exists and the funder is still a collaborator. A lost binding ends
// the approval (and the reaper its pods). Returns how many ended.
export async function checkProjectFundingBindings(
  deps: ProjectFundingDeps & { batch?: number } = {},
): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  // least recently checked first, and every checked one moves to the back,
  // so all approvals advance through the scan whatever their number
  const { rows } = await getPool().query(
    `SELECT * FROM gpu_budget_layers
      WHERE scope_kind = 'project' AND state = 'active'
        AND activation_acked_at IS NOT NULL
      ORDER BY binding_checked_at NULLS FIRST, id LIMIT $1`,
    [deps.batch ?? 500],
  );
  let ended = 0;
  for (const layer of rows) {
    await getPool().query(
      "UPDATE gpu_budget_layers SET binding_checked_at = now() WHERE id = $1",
      [layer.id],
    );
    try {
      const p = await (deps.projectBay ?? defaultProjectBay)(layer.project_id);
      const s = await p.status({
        source_bay_id: getConfiguredBayId(),
        project_id: layer.project_id,
        approval_id: layer.approval_id,
        funder_account_id: layer.key_owner_account_id,
      });
      if (s.status === "rehoming") continue;
      const lost: ProjectFundingEndedReason | undefined = s.project_deleted
        ? "project_deleted"
        : s.status === "found" && !s.funder_is_collaborator
          ? "funder_left_project"
          : undefined;
      if (!lost) continue;
      const did = await inTransaction(async (db) => {
        await (deps.accountWriteFence ?? lockGpuAccountFence)(
          db,
          layer.key_owner_account_id,
          "end a project's GPU funding",
        );
        return await endLayer(db, layer, lost, null, now);
      });
      if (did) ended += 1;
    } catch {
      // the next pass asks again
    }
  }
  return ended;
}

// ---- the project's pods, at the funder's home (§7) ----

// Only the project's current owning bay asks, naming approvals of that
// project; a pod is reachable only by its own immutable project and an
// approval layer of that same project. No key is read: the listing comes
// from CoCalc's records, and a terminate is carried out by the reaper.
// at most this many pods per answer; more is said, never silently dropped
export const PROJECT_PODS_LIMIT = 200;

async function projectPodRows(
  db: Db,
  project_id: string,
  approval_ids: string[],
  pod?: string,
  limit = PROJECT_PODS_LIMIT,
) {
  const ids = approval_ids.filter((id) => isValidUUID(id)).slice(0, 50);
  if (ids.length === 0) return [];
  const ref = pod == null ? null : `${pod}`.trim();
  const { rows } = await db.query(
    `SELECT p.* FROM gpu_pods p
       JOIN gpu_budget_layers l
         ON l.approval_id = p.approval_id AND l.scope_kind = 'project'
        AND l.project_id = p.project_id
      WHERE p.project_id = $1 AND p.approval_id = ANY($2::uuid[])
        ${ref == null ? "" : "AND (p.id::text = $3 OR p.handle = $3)"}
        AND (${LIVE_POD_SQL.replace(/state/g, "p.state").replace(/unmanaged_at/g, "p.unmanaged_at")}
             OR p.terminated_at > now() - interval '1 day')
      ORDER BY p.created DESC LIMIT ${Math.max(1, Math.floor(limit)) + 1}`,
    ref == null ? [project_id, ids] : [project_id, ids, ref],
  );
  return rows;
}

export async function projectPodsAtFunderLocal(
  req: {
    source_bay_id: string;
    project_id: string;
    approval_ids: string[];
  },
  deps: ProjectFundingDeps & { podLimit?: number } = {},
): Promise<{
  pods: import("@cocalc/util/gpu/types").GpuPodSummary[];
  // more pods than this answer holds: the caller says so
  truncated: boolean;
}> {
  const project_id = requireId(req?.project_id, "project_id");
  await (deps.assertSentByProjectBay ?? defaultAssertSentByProjectBay)(
    req.source_bay_id,
    project_id,
  );
  const { podSummary } = await import("@cocalc/server/gpu/pods");
  const limit = deps.podLimit ?? PROJECT_PODS_LIMIT;
  const rows = await projectPodRows(
    getPool(),
    project_id,
    req.approval_ids ?? [],
    undefined,
    limit,
  );
  return {
    pods: rows.slice(0, limit).map(podSummary),
    truncated: rows.length > limit,
  };
}

export async function projectTerminateAtFunderLocal(
  req: {
    source_bay_id: string;
    project_id: string;
    approval_ids: string[];
    pod_id: string;
    actor: {
      kind: "project" | "user" | "agent";
      account_id?: string;
      agent_id?: string;
      run_id?: string;
    };
  },
  deps: ProjectFundingDeps = {},
): Promise<{ found: boolean; state?: string }> {
  const project_id = requireId(req?.project_id, "project_id");
  await (deps.assertSentByProjectBay ?? defaultAssertSentByProjectBay)(
    req.source_bay_id,
    project_id,
  );
  const { recordEvent } = await import("@cocalc/server/gpu/pods");
  return await inTransaction(async (db) => {
    const [pod] = await projectPodRows(
      db,
      project_id,
      req.approval_ids ?? [],
      `${req.pod_id ?? ""}`,
    );
    if (!pod) return { found: false };
    if (["terminated", "failed"].includes(pod.state)) {
      return { found: true, state: pod.state };
    }
    await db.query(
      `UPDATE gpu_pods SET desired_state = 'terminated',
              reason = COALESCE(reason, 'Terminated from its project.'), updated = now()
        WHERE id = $1 AND state NOT IN ('terminated', 'failed')`,
      [pod.id],
    );
    const kind = req.actor?.kind;
    await recordEvent(
      pod.id,
      {
        kind: kind === "user" || kind === "agent" ? kind : "project",
        account_id:
          kind === "user" || kind === "agent"
            ? requireId(req.actor.account_id, "account_id")
            : undefined,
        ...(kind === "agent"
          ? {
              agent_id:
                `${req.actor.agent_id ?? ""}`.slice(0, 128) || undefined,
              run_id: `${req.actor.run_id ?? ""}`.slice(0, 128) || undefined,
            }
          : {}),
      },
      "terminate",
      { from_project: project_id },
      db,
    );
    return { found: true, state: pod.state };
  });
}

// ---- a funded launch, at this (the funder's home) bay's boundary ----

// Validate a launch forwarded by a project's owning bay: the sender owns the
// project now, and the ids are well formed. The layer itself is checked by
// admission (exactly this approval, project, key owner; active; in window;
// agents allowed) and again by decrypt admission.
export async function verifyProjectFundedLaunch(
  req: import("@cocalc/util/gpu/project-funding").ProjectFundingLaunchRequest,
  deps: ProjectFundingDeps = {},
): Promise<{
  funder_account_id: string;
  project_id: string;
  binding: import("@cocalc/server/gpu/key-use").ProjectKeyUseBinding;
  funding: import("@cocalc/server/gpu/pods").ProjectFundedLaunch;
}> {
  const project_id = requireId(req?.project_id, "project_id");
  const approval_id = requireId(req.approval_id, "approval_id");
  const layer_id = requireId(req.layer_id, "layer_id");
  const funder_account_id = requireId(
    req.funder_account_id,
    "funder_account_id",
  );
  const kind = req.actor?.kind;
  if (kind !== "project" && kind !== "user" && kind !== "agent") {
    throw Error("A funded launch needs its actor.");
  }
  const actor_account_id =
    kind === "project" ? undefined : requireId(req.actor.account_id, "actor");
  const clip = (v: unknown) =>
    v == null ? undefined : `${v}`.slice(0, 128) || undefined;
  if (kind === "agent" && !clip(req.actor.agent_id)) {
    throw Error("An agent's funded launch needs its agent id.");
  }
  const operation_id = req.operation_id;
  if (
    (operation_id != null || kind === "agent") &&
    !LAUNCH_OPERATION_ID.test(`${operation_id ?? ""}`)
  ) {
    throw Error("An agent's funded launch needs its operation id.");
  }
  await (deps.assertSentByProjectBay ?? defaultAssertSentByProjectBay)(
    req.source_bay_id,
    project_id,
  );
  return {
    funder_account_id,
    project_id,
    binding: {
      project_id,
      approval_id,
      layer_id,
      source_bay_id: `${req.source_bay_id}`,
      actor_kind: kind,
      ...(actor_account_id ? { actor_account_id } : {}),
      ...(kind === "agent"
        ? {
            agent_id: clip(req.actor.agent_id),
            ...(clip(req.actor.run_id)
              ? { run_id: clip(req.actor.run_id) }
              : {}),
          }
        : {}),
    },
    funding: {
      approval_id,
      layer_id,
      actor_kind: kind,
      actor_account_id,
      agent_id: kind === "agent" ? clip(req.actor.agent_id) : undefined,
      run_id: kind === "agent" ? clip(req.actor.run_id) : undefined,
      operation_id: operation_id ?? undefined,
    },
  };
}
