/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Audited decrypts of GPU provider keys (STEP5D2 5d-2c, the local half of
// mitigation 5). A key is decrypted only for a capability made before it:
//
// - a user's or agent's action: a gpu_key_uses record, made only at the two
//   boundaries that authenticated the request (the hub API handler on the
//   key owner's home bay, and the inter-bay service there, from the
//   forwarded, verified principal), with the purpose, limit, expiry and rule
//   fixed by the method;
// - a worker: its open run (gpu_worker_runs) while it holds its lease.
//
// Capabilities are in-process objects this module made: one that crossed a
// wire, or was put together by hand, is refused. Each decrypt is admitted in
// one transaction (capability checked, counted, the decrypt row and its
// outbox row written) before the broker reads the key
// (external-credentials/store.ts withAuditedGpuKey).
//
// This can't detect a compromised hub process: that needs the off-host log,
// which doesn't exist yet (the outbox is its seam).

import { randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import { RunpodApiError } from "@cocalc/cloud/runpod/client";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { listExternalCredentials } from "@cocalc/server/external-credentials/store";
import type { WorkerName } from "@cocalc/server/gpu/reaper";
import type {
  GPU_KEY_USE_PURPOSES,
  GPU_KEY_WORKER_PURPOSES,
} from "@cocalc/util/db-schema/gpu-budgets";
import { GPU_PROVIDER_API_KEY_KIND } from "@cocalc/util/gpu/provider-keys";
import {
  KEY_RPC_TIMEOUT_MS,
  VERIFY_RPC_TIMEOUT_MS,
} from "@cocalc/util/gpu/provider-keys";
import {
  GPU_POD_WRITE_RPC_TIMEOUT_MS,
  GPU_READ_TIMEOUT_MS,
} from "@cocalc/util/gpu/runpod";

export type GpuKeyUsePurpose = (typeof GPU_KEY_USE_PURPOSES)[number];
export type GpuKeyWorkerPurpose = (typeof GPU_KEY_WORKER_PURPOSES)[number];

// Each method's purpose fixes what its record allows: how long it may be
// used (the method's RPC timeout), how many decrypts, and whether it is a
// write (which records an outcome).
const USE_POLICY: Record<
  GpuKeyUsePurpose,
  { ttl_ms: number; max_decrypts: number; write: boolean }
> = {
  launch: {
    ttl_ms: GPU_POD_WRITE_RPC_TIMEOUT_MS,
    max_decrypts: 1,
    write: true,
  },
  terminate: {
    ttl_ms: GPU_POD_WRITE_RPC_TIMEOUT_MS,
    max_decrypts: 1,
    write: true,
  },
  // the pod listing: its records' ambiguous resolve, a handle's lookup and
  // the live views
  pod_read: { ttl_ms: GPU_READ_TIMEOUT_MS, max_decrypts: 3, write: false },
  ssh_info: { ttl_ms: GPU_READ_TIMEOUT_MS, max_decrypts: 1, write: false },
  catalog: { ttl_ms: GPU_READ_TIMEOUT_MS, max_decrypts: 1, write: false },
  verify: { ttl_ms: VERIFY_RPC_TIMEOUT_MS, max_decrypts: 1, write: true },
  removal: { ttl_ms: KEY_RPC_TIMEOUT_MS, max_decrypts: 1, write: true },
  // the compromise report's forwarded call waits 60 s
  compromise: { ttl_ms: 60_000, max_decrypts: 1, write: true },
};

// which worker may decrypt for which purpose
const WORKER_OF: Record<GpuKeyWorkerPurpose, WorkerName> = {
  reaper: "reaper",
  cleanup: "compromise",
  reconcile: "reconciler",
  account_watch: "reconciler",
  billing: "billing",
};

// (for the decrypt audit)
export function workerForPurpose(purpose: string): WorkerName | undefined {
  return WORKER_OF[purpose as GpuKeyWorkerPurpose];
}

// the purposes that are writes (they record an outcome)
export function isWriteKeyPurpose(purpose: string): boolean {
  return USE_POLICY[purpose as GpuKeyUsePurpose]?.write === true;
}

export interface GpuKeyUse {
  readonly kind: "use";
  readonly id: string;
  readonly purpose: GpuKeyUsePurpose;
  readonly key_owner_account_id: string;
  // rule 'project': the exact approval it was made for (PROJECT_FUNDING.md
  // §5); the method checks it matches what it does
  readonly project?: ProjectKeyUseBinding;
}

export interface ProjectKeyUseBinding {
  readonly project_id: string;
  readonly approval_id: string;
  readonly layer_id: string;
  // the project's owning bay that forwarded the call (authenticated)
  readonly source_bay_id: string;
  readonly actor_kind: "project" | "user" | "agent";
  readonly actor_account_id?: string;
  // an agent actor's canonical ids
  readonly agent_id?: string;
  readonly run_id?: string;
}

// The binding a method compares a project record with: the approval it acts
// on and exactly who acts.
export type ProjectKeyUseCheck = Omit<ProjectKeyUseBinding, "source_bay_id">;

export interface GpuWorkerKeyUse {
  readonly kind: "run";
  readonly worker: WorkerName;
  readonly token: string;
  readonly purpose: GpuKeyWorkerPurpose;
}

export type GpuKeyCapability = GpuKeyUse | GpuWorkerKeyUse;

// what this module made, in this process
const issued = new WeakSet<object>();

function issue<T extends GpuKeyCapability>(cap: T): T {
  const frozen = Object.freeze(cap);
  issued.add(frozen);
  return frozen;
}

// Test capabilities (key-use-testing.ts): accepted where a method only
// requires one, refused by every decrypt admission.
const testIssued = new WeakSet<object>();

export function issueTestKeyUse(purpose: GpuKeyUsePurpose): GpuKeyUse {
  const cap = issue({
    kind: "use",
    id: `test-${randomBytes(8).toString("hex")}`,
    purpose,
    key_owner_account_id: "test",
  } as const);
  testIssued.add(cap);
  return cap;
}

export function isGpuKeyCapability(cap: unknown): cap is GpuKeyCapability {
  return typeof cap === "object" && cap != null && issued.has(cap);
}

export class KeyUseRefused extends Error {}

function newUseId(): string {
  // 128 random bits
  return randomBytes(16).toString("hex");
}

// The owner's connected key, from metadata only (no decrypt).
export async function currentGpuKeyMeta(
  account_id: string,
): Promise<{ credential_id: string; revision: string } | undefined> {
  const rows = (
    await listExternalCredentials({
      owner_account_id: account_id,
      provider: "runpod",
      kind: GPU_PROVIDER_API_KEY_KIND,
      scope: "account",
    })
  )
    .filter((row) => !row.revoked)
    .sort(
      (a, b) =>
        new Date(b.updated).getTime() - new Date(a.updated).getTime() ||
        new Date(b.created).getTime() - new Date(a.created).getTime(),
    );
  const row = rows[0];
  if (!row) return undefined;
  // the record's last write: an in-place replacement keeps the id but not this
  return {
    credential_id: row.id,
    revision: new Date(row.updated).toISOString(),
  };
}

// Is this bay the account's home bay (where its key lives)? The
// boundaries make a record only there; elsewhere the call is forwarded and
// the home bay makes its own.
export async function isGpuKeyHomeBay(account_id: string): Promise<boolean> {
  const { home_bay_id } = await resolveAccountHomeBay({ account_id });
  return (
    (`${home_bay_id ?? ""}`.trim() || getConfiguredBayId()) ===
    getConfiguredBayId()
  );
}

async function insertUse(opts: {
  account_id: string;
  purpose: GpuKeyUsePurpose;
  rule: "owner" | "agent" | "project";
  agent?: { project_id: string; agent_id: string; run_id?: string };
  project?: ProjectKeyUseBinding;
  request_id?: string;
}): Promise<GpuKeyUse> {
  const policy = USE_POLICY[opts.purpose];
  if (!policy) throw Error("unknown GPU key purpose");
  // A connect's verify reads the key it stores itself, after this record:
  // it names none yet, and is bound to that key once, in the store's
  // transaction (bindVerifyUse).
  const credential_id =
    opts.purpose === "verify"
      ? null
      : ((await currentGpuKeyMeta(opts.account_id))?.credential_id ?? null);
  const id = newUseId();
  // Under an approval the principal is who acted: the acting account, or
  // (the project itself acted) the key owner as payer; actor_kind says which.
  const principal = opts.project?.actor_account_id ?? opts.account_id;
  await getPool().query(
    `INSERT INTO gpu_key_uses (id, key_owner_account_id, credential_id,
       principal_account_id, agent_project_id, agent_id, agent_run_id, purpose,
       authorized, rule, request_id, bay_id, created, expires, max_decrypts, decrypts,
       project_id, approval_id, layer_id, source_bay_id, actor_kind)
     VALUES ($1, $2, $3, $13, $4, $5, $6, $7, true, $8, $9, $10, now(),
       now() + make_interval(secs => $11), $12, 0, $14, $15, $16, $17, $18)`,
    [
      id,
      opts.account_id,
      credential_id,
      opts.agent?.project_id ??
        (opts.project?.actor_kind === "agent" ? opts.project.project_id : null),
      opts.agent?.agent_id ??
        (opts.project?.actor_kind === "agent" ? opts.project.agent_id : null) ??
        null,
      opts.agent?.run_id ??
        (opts.project?.actor_kind === "agent" ? opts.project.run_id : null) ??
        null,
      opts.purpose,
      opts.rule,
      opts.request_id ?? null,
      getConfiguredBayId(),
      policy.ttl_ms / 1000,
      policy.max_decrypts,
      principal,
      opts.project?.project_id ?? null,
      opts.project?.approval_id ?? null,
      opts.project?.layer_id ?? null,
      opts.project?.source_bay_id ?? null,
      opts.project?.actor_kind ?? null,
    ],
  );
  return issue({
    kind: "use",
    id,
    purpose: opts.purpose,
    key_owner_account_id: opts.account_id,
    ...(opts.project ? { project: Object.freeze({ ...opts.project }) } : {}),
  });
}

// ---- the three capability constructors ----
//
// The first two are called only at the authenticated boundaries
// (server/conat/api/gpu.ts and server/inter-bay/service.ts); the third only
// by a worker's sweep, with the token of the lease it holds. A test
// enumerates their callers.

// A person acting on their own key (the hub has verified account_id).
export async function admitUserKeyUse(opts: {
  account_id: string;
  purpose: GpuKeyUsePurpose;
  request_id?: string;
}): Promise<GpuKeyUse> {
  return await insertUse({ ...opts, rule: "owner" });
}

// An agent acting for its account, from its verified principal.
export async function admitAgentKeyUse(opts: {
  principal: {
    account_id: string;
    project_id: string;
    agent_id: string;
    run_id?: string;
  };
  purpose: GpuKeyUsePurpose;
  request_id?: string;
}): Promise<GpuKeyUse> {
  const { principal } = opts;
  if (
    !/^[0-9a-f-]{36}$/i.test(`${principal.project_id ?? ""}`) ||
    !`${principal.agent_id ?? ""}`.trim()
  ) {
    throw new KeyUseRefused("not a verified agent principal");
  }
  return await insertUse({
    account_id: principal.account_id,
    purpose: opts.purpose,
    rule: "agent",
    agent: {
      project_id: principal.project_id,
      agent_id: principal.agent_id,
      run_id: principal.run_id,
    },
    request_id: opts.request_id,
  });
}

// A launch or project read under a project funding approval, made only at
// the funder's home bay's inter-bay boundary, after it verified that the
// project's current owning bay sent it (PROJECT_FUNDING.md §5). Bound to the
// exact approval and layer: decrypt admission rechecks that layer.
export async function admitProjectKeyUse(opts: {
  key_owner_account_id: string;
  purpose: GpuKeyUsePurpose;
  binding: ProjectKeyUseBinding;
  request_id?: string;
}): Promise<GpuKeyUse> {
  const b = opts.binding;
  for (const id of [b.project_id, b.approval_id, b.layer_id]) {
    if (!/^[0-9a-f-]{36}$/i.test(`${id ?? ""}`)) {
      throw new KeyUseRefused("not a verified project funding binding");
    }
  }
  if (!`${b.source_bay_id ?? ""}`.trim()) {
    throw new KeyUseRefused("not a verified project funding binding");
  }
  if (!["project", "user", "agent"].includes(b.actor_kind)) {
    throw new KeyUseRefused("not a verified project funding binding");
  }
  // exactly the fields of its kind: the project has no account; a person
  // has one; an agent has one and its agent id
  const fits =
    b.actor_kind === "project"
      ? b.actor_account_id == null && b.agent_id == null && b.run_id == null
      : b.actor_kind === "user"
        ? b.actor_account_id != null && b.agent_id == null && b.run_id == null
        : b.actor_account_id != null && !!`${b.agent_id ?? ""}`.trim();
  if (!fits) {
    throw new KeyUseRefused("not a verified project funding binding");
  }
  return await insertUse({
    account_id: opts.key_owner_account_id,
    purpose: opts.purpose,
    rule: "project",
    project: b,
    request_id: opts.request_id,
  });
}

// A worker's sweep: its run, while it holds the lease taken with `token`.
export function workerKeyUse(
  worker: WorkerName,
  token: string,
  purpose: GpuKeyWorkerPurpose,
): GpuWorkerKeyUse {
  if (WORKER_OF[purpose] !== worker) {
    throw Error(`the ${worker} worker doesn't decrypt for ${purpose}`);
  }
  return issue({ kind: "run", worker, token, purpose });
}

// A worker capability for another of its purposes, in the same run (the
// reconciler's account checks).
export function workerKeyUseFor(
  cap: GpuWorkerKeyUse,
  purpose: GpuKeyWorkerPurpose,
): GpuWorkerKeyUse {
  if (!isGpuKeyCapability(cap) || cap.kind !== "run") {
    throw new KeyUseRefused("not a worker's key capability");
  }
  return workerKeyUse(cap.worker, cap.token, purpose);
}

// The decrypt principal of a project record: the project itself, an agent
// (as for its own records), or the acting person.
export function projectUsePrincipal(r: {
  actor_kind: string | null;
  project_id: string | null;
  principal_account_id: string;
  agent_id: string | null;
}): string {
  if (r.actor_kind === "project") return `project:${r.project_id}`;
  if (r.actor_kind === "agent") {
    return `agent:${r.principal_account_id}:${r.agent_id}`;
  }
  return `${r.principal_account_id}`;
}

// ---- admission of one decrypt ----

const PROCESS = `${hostname()}:${process.pid}`.slice(0, 200);

// In one transaction: the capability is checked (and a record's counter
// taken), then the decrypt row and its outbox row are written. Returns the
// decrypt row's id, the broker's one-shot permit. Throws KeyUseRefused with
// nothing written when the capability doesn't allow this decrypt.
export async function admitDecrypt(
  cap: unknown,
  key: { account_id: string; credential_id: string },
): Promise<string> {
  if (!isGpuKeyCapability(cap) || testIssued.has(cap)) {
    throw new KeyUseRefused("no valid capability for this key");
  }
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    const row =
      cap.kind === "use"
        ? await admitUse(db, cap, key)
        : await admitRun(db, cap, key);
    if (!row) {
      await db.query("ROLLBACK");
      throw new KeyUseRefused("this capability doesn't allow using this key");
    }
    const id = randomUUID();
    const { rows } = await db.query(
      `INSERT INTO gpu_key_decrypts (id, key_use_id, worker_run_id, worker_name,
         purpose, key_owner_account_id, credential_id, principal, bay_id,
         process, started)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       RETURNING id, key_use_id, worker_run_id, worker_name, purpose,
         key_owner_account_id, credential_id, principal, bay_id, process, started`,
      [
        id,
        row.key_use_id,
        row.worker_run_id,
        row.worker_name,
        cap.purpose,
        key.account_id,
        key.credential_id,
        row.principal,
        getConfiguredBayId(),
        PROCESS,
      ],
    );
    await db.query(
      `INSERT INTO security_event_outbox (id, kind, details, created)
       VALUES (gen_random_uuid(), 'gpu_key_decrypt', $1::jsonb, now())`,
      [JSON.stringify(rows[0])],
    );
    await db.query("COMMIT");
    return id;
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

type Admitted = {
  key_use_id: string | null;
  worker_run_id: string | null;
  worker_name: string | null;
  principal: string;
};

// A record: unexpired, for this owner, purpose and exact key, under its
// limit (row-locked and counted in this transaction). A connect's verify
// admits only the key its own connect bound it to.
async function admitUse(
  db: PoolClient,
  cap: GpuKeyUse,
  key: { account_id: string; credential_id: string },
): Promise<Admitted | undefined> {
  if (cap.key_owner_account_id !== key.account_id) return undefined;
  const { rows } = await db.query(
    `UPDATE gpu_key_uses u SET decrypts = decrypts + 1
      WHERE u.id = $1 AND u.authorized AND u.decrypts < u.max_decrypts
        AND u.expires > now() AND u.purpose = $2
        AND u.key_owner_account_id = $3 AND u.bay_id = $5
        AND u.credential_id = $4
      RETURNING u.principal_account_id, u.agent_id, u.rule, u.layer_id,
        u.approval_id, u.project_id, u.actor_kind`,
    [
      cap.id,
      cap.purpose,
      key.account_id,
      key.credential_id,
      getConfiguredBayId(),
    ],
  );
  const r = rows[0];
  if (!r) return undefined;
  if (r.rule === "project") {
    // The exact approval layer, locked and rechecked now: a revoke between
    // the record and this decrypt refuses it (PROJECT_FUNDING.md §5).
    const { rows: layer } = await db.query(
      `SELECT 1 FROM gpu_budget_layers
        WHERE id = $1 AND approval_id = $2 AND project_id = $3
          AND scope_kind = 'project' AND key_owner_account_id = $4
          AND credential_id = $5 AND state = 'active'
          AND admission_closed_at IS NULL AND ended_at IS NULL
          AND starts_at <= now() AND ends_at > now()
        FOR UPDATE`,
      [
        r.layer_id,
        r.approval_id,
        r.project_id,
        key.account_id,
        key.credential_id,
      ],
    );
    if (!layer[0]) return undefined;
    return {
      key_use_id: cap.id,
      worker_run_id: null,
      worker_name: null,
      principal: projectUsePrincipal(r).slice(0, 200),
    };
  }
  return {
    key_use_id: cap.id,
    worker_run_id: null,
    worker_name: null,
    principal: r.agent_id
      ? `agent:${r.principal_account_id}:${r.agent_id}`.slice(0, 200)
      : `${r.principal_account_id}`,
  };
}

// A worker: its run with this name and token is open, and the lease of that
// name is held with the same token and unexpired, now (both rows locked
// against a concurrent close for this transaction).
async function admitRun(
  db: PoolClient,
  cap: GpuWorkerKeyUse,
  _key: { account_id: string; credential_id: string },
): Promise<Admitted | undefined> {
  if (WORKER_OF[cap.purpose] !== cap.worker) return undefined;
  const { rows } = await db.query(
    `SELECT r.id FROM gpu_worker_runs r
       JOIN gpu_worker_leases l ON l.name = r.name AND l.holder = r.token
      WHERE r.name = $1 AND r.token = $2 AND r.finished IS NULL
        AND l.expires_at >= now()
      FOR SHARE`,
    [cap.worker, cap.token],
  );
  const r = rows[0];
  if (!r) return undefined;
  return {
    key_use_id: null,
    worker_run_id: r.id,
    worker_name: cap.worker,
    principal: `worker:${cap.worker}`,
  };
}

// A connect's verify record is bound, once, to the key that connect
// stored: in the store's own transaction, before any decrypt, so its
// inventory pass can read that key and no other (not another connect's,
// stored meanwhile). Throws if the record isn't an unbound verify of this
// owner: the store then doesn't happen.
export async function bindVerifyUse(
  db: Pick<PoolClient, "query">,
  cap: unknown,
  key: { account_id: string; credential_id: string },
): Promise<void> {
  if (
    !isGpuKeyCapability(cap) ||
    cap.kind !== "use" ||
    cap.purpose !== "verify"
  ) {
    throw new KeyUseRefused("not this connect's verify");
  }
  // (a test capability has no record; no decrypt ever admits it)
  if (testIssued.has(cap)) return;
  if (cap.key_owner_account_id !== key.account_id) {
    throw new KeyUseRefused("not this connect's verify");
  }
  const { rowCount } = await db.query(
    `UPDATE gpu_key_uses SET credential_id = $3
      WHERE id = $1 AND purpose = 'verify' AND key_owner_account_id = $2
        AND credential_id IS NULL AND expires > now()`,
    [cap.id, key.account_id, key.credential_id],
  );
  if (rowCount !== 1) throw new KeyUseRefused("this connect's verify is used");
}

// ---- outcomes ----

export function isWritePurpose(purpose: GpuKeyUsePurpose): boolean {
  return USE_POLICY[purpose]?.write === true;
}

// How an attempt ended, for its outcome: RunPod not answering is "unknown"
// (the write may have happened); anything else that throws is "failed".
function outcomeOf(err: unknown): "failed" | "unknown" {
  return err instanceof RunpodApiError &&
    (err.kind === "network" ||
      err.kind === "provider" ||
      err.kind === "protocol")
    ? "unknown"
    : "failed";
}

// Run a user or agent action, recording a write's outcome once, in a
// finally, whatever happened (an attempt made explains its decrypt).
export async function withKeyUseOutcome<T>(
  cap: GpuKeyUse | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!cap || !isGpuKeyCapability(cap) || !isWritePurpose(cap.purpose)) {
    return await fn();
  }
  let outcome: "succeeded" | "failed" | "unknown" = "unknown";
  try {
    const result = await fn();
    outcome = "succeeded";
    return result;
  } catch (err) {
    outcome = outcomeOf(err);
    throw err;
  } finally {
    await getPool()
      .query(
        `INSERT INTO gpu_key_use_outcomes (key_use_id, outcome, at)
         VALUES ($1, $2, now()) ON CONFLICT (key_use_id) DO NOTHING`,
        [cap.id, outcome],
      )
      .catch(() => {
        // the audit reports a write with no outcome once it matures
      });
  }
}

// What a *Local method that may decrypt must be given, checked at its entry
// before anything is read or changed: a capability this process issued, of
// the method's own purpose, for this account.
export function requireKeyUse(
  cap: unknown,
  purposes: readonly GpuKeyUsePurpose[],
  account_id: string,
  // under a project funding approval: the approval the method acts on and
  // exactly who acts. A record made for one approval or actor never serves
  // another, nor an own-key call.
  project?: ProjectKeyUseCheck,
): GpuKeyUse {
  const bound =
    isGpuKeyCapability(cap) && cap.kind === "use" ? cap.project : undefined;
  const bindingOk = testIssued.has(cap as object)
    ? true
    : project == null
      ? bound == null
      : bound != null &&
        bound.project_id === project.project_id &&
        bound.approval_id === project.approval_id &&
        bound.layer_id === project.layer_id &&
        bound.actor_kind === project.actor_kind &&
        (bound.actor_account_id ?? null) ===
          (project.actor_account_id ?? null) &&
        (bound.agent_id ?? null) === (project.agent_id ?? null) &&
        (bound.run_id ?? null) === (project.run_id ?? null);
  if (
    !isGpuKeyCapability(cap) ||
    cap.kind !== "use" ||
    !purposes.includes(cap.purpose) ||
    (cap.key_owner_account_id !== account_id && !testIssued.has(cap)) ||
    !bindingOk
  ) {
    throw new KeyUseRefused(
      "This GPU request wasn't authorized on the key owner's home bay. Try again.",
    );
  }
  return cap;
}
