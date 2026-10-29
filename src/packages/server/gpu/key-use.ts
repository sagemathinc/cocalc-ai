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
export type GpuKeyWorkerPurpose =
  | (typeof GPU_KEY_WORKER_PURPOSES)[number]
  // 5d-2b's account checks: a decrypt of their own, in the reconciler's run
  | "account_watch";

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

export interface GpuKeyUse {
  readonly kind: "use";
  readonly id: string;
  readonly purpose: GpuKeyUsePurpose;
  readonly key_owner_account_id: string;
}

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
  rule: "owner" | "agent";
  agent?: { project_id: string; agent_id: string; run_id?: string };
  request_id?: string;
}): Promise<GpuKeyUse> {
  const policy = USE_POLICY[opts.purpose];
  if (!policy) throw Error("unknown GPU key purpose");
  // A connect's verify reads the key it stores itself, after this record:
  // it names no credential (see admitDecrypt).
  const credential_id =
    opts.purpose === "verify"
      ? null
      : ((await currentGpuKeyMeta(opts.account_id))?.credential_id ?? null);
  const id = newUseId();
  await getPool().query(
    `INSERT INTO gpu_key_uses (id, key_owner_account_id, credential_id,
       principal_account_id, agent_project_id, agent_id, agent_run_id, purpose,
       authorized, rule, request_id, bay_id, created, expires, max_decrypts, decrypts)
     VALUES ($1, $2, $3, $2, $4, $5, $6, $7, true, $8, $9, $10, now(),
       now() + make_interval(secs => $11), $12, 0)`,
    [
      id,
      opts.account_id,
      credential_id,
      opts.agent?.project_id ?? null,
      opts.agent?.agent_id ?? null,
      opts.agent?.run_id ?? null,
      opts.purpose,
      opts.rule,
      opts.request_id ?? null,
      getConfiguredBayId(),
      policy.ttl_ms / 1000,
      policy.max_decrypts,
    ],
  );
  return issue({
    kind: "use",
    id,
    purpose: opts.purpose,
    key_owner_account_id: opts.account_id,
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
  if (!isGpuKeyCapability(cap)) {
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

// A record: unexpired, for this owner, purpose and key, under its limit
// (row-locked and counted in this transaction). A connect's verify names no
// key: it may read only a key of its owner stored after the record was made.
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
        AND (u.credential_id = $4
             OR (u.purpose = 'verify' AND u.credential_id IS NULL
                 AND EXISTS (SELECT 1 FROM external_credentials c
                              WHERE c.id = $4 AND c.owner_account_id = $3
                                AND c.kind = $6 AND c.revoked IS NULL
                                AND c.updated >= u.created)))
      RETURNING u.principal_account_id, u.agent_id`,
    [
      cap.id,
      cap.purpose,
      key.account_id,
      key.credential_id,
      getConfiguredBayId(),
      GPU_PROVIDER_API_KEY_KIND,
    ],
  );
  const r = rows[0];
  if (!r) return undefined;
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

// What a *Local method that may decrypt must be given: refused (before any
// key read) without one of this purpose.
export function requireKeyUse(
  cap: unknown,
  purposes: readonly GpuKeyUsePurpose[],
): GpuKeyUse {
  if (
    !isGpuKeyCapability(cap) ||
    cap.kind !== "use" ||
    !purposes.includes(cap.purpose)
  ) {
    throw new KeyUseRefused(
      "This GPU request wasn't authorized on the key owner's home bay. Try again.",
    );
  }
  return cap;
}
