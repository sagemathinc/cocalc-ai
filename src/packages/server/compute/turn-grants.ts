/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import centralLog from "@cocalc/database/postgres/central-log";

export interface ComputeAgentAuth {
  account_id: string;
  project_id: string;
  token_fingerprint: string;
  issued_at_s: number;
  expires_at_s: number;
}

export type ComputeAgentAction =
  | "read"
  | "data-plane"
  | "availability"
  | "billable"
  | "destructive";

export interface ComputeAgentGrantRequest {
  operation?: string;
  operation_id?: string;
  vm_id?: string;
  allow_create?: boolean;
  provider?: "gcp" | "nebius";
  machine_class?: string;
  funding_mode?: string;
  active_vms?: number;
  hourly_usd?: number;
  total_authorized_usd?: number;
  ttl_minutes?: number;
}

function validateAgentAuth(auth: ComputeAgentAuth): void {
  const now = Date.now() / 1000;
  if (!/^[a-f0-9]{64}$/.test(auth.token_fingerprint)) {
    throw Object.assign(new Error("invalid managed-compute capability"), {
      code: 403,
    });
  }
  if (
    !Number.isFinite(auth.issued_at_s) ||
    !Number.isFinite(auth.expires_at_s) ||
    auth.issued_at_s > now + 60 ||
    auth.expires_at_s <= now
  ) {
    throw Object.assign(new Error("managed-compute capability has expired"), {
      code: 403,
    });
  }
}

export async function requireAgentComputeGrant(opts: {
  auth?: ComputeAgentAuth;
  action: ComputeAgentAction;
  project_id: string;
  vm_id?: string;
  request?: ComputeAgentGrantRequest;
}): Promise<void> {
  if (!opts.auth) return;
  validateAgentAuth(opts.auth);
  if (opts.auth.project_id !== opts.project_id) {
    throw Object.assign(
      new Error("managed-compute capability cannot cross projects"),
      { code: 403 },
    );
  }
  if (
    opts.action !== "read" &&
    opts.action !== "data-plane" &&
    (!opts.request?.operation || !opts.request.operation_id)
  ) {
    throw Object.assign(
      new Error("managed-compute mutation is missing an operation identity"),
      { code: 403 },
    );
  }
  const pool = getPool();
  let { rows } = await pool.query(
    `SELECT * FROM compute_vm_turn_grants
      WHERE secret_hash=$1 AND revoked_at IS NULL AND expires_at > NOW()
      LIMIT 1`,
    [opts.auth.token_fingerprint],
  );
  if (!rows[0]) {
    const expiresAt = new Date(
      Math.min(opts.auth.expires_at_s * 1000, Date.now() + 30 * 60_000),
    );
    const grantId = randomUUID();
    await pool.query(
      `INSERT INTO compute_vm_turn_grants (
         grant_id, secret_hash, owner_account_id, project_id, turn_id,
         session_id, issued_by_account_id, allowed_actions, allowed_vm_ids,
         allow_create, allowed_providers, allowed_machine_classes,
         funding_mode, max_active_vms, max_hourly_usd,
         max_total_authorized_usd, max_ttl_minutes, expires_at,
         created_at, metadata
       ) VALUES (
         $1,$2,$3,$4,$5,$5,$3,$6,'{}'::uuid[],false,
         ARRAY['gcp','nebius']::text[],ARRAY[]::text[],NULL,0,0,0,0,$7,NOW(),$8
       ) ON CONFLICT (secret_hash) DO NOTHING`,
      [
        grantId,
        opts.auth.token_fingerprint,
        opts.auth.account_id,
        opts.auth.project_id,
        `agent-token-${opts.auth.issued_at_s}`,
        opts.action === "read" || opts.action === "data-plane"
          ? ["read", "data-plane"]
          : [],
        expiresAt,
        {
          source: "project-host-acp-token",
          issued_at_s: opts.auth.issued_at_s,
          token_expires_at_s: opts.auth.expires_at_s,
        },
      ],
    );
    ({ rows } = await pool.query(
      `SELECT * FROM compute_vm_turn_grants
        WHERE secret_hash=$1 AND revoked_at IS NULL AND expires_at > NOW()
        LIMIT 1`,
      [opts.auth.token_fingerprint],
    ));
  }
  const grant = rows[0];
  const allowedActions: string[] = grant?.allowed_actions ?? [];
  const approvedRequest = grant?.metadata?.approved_request;
  const exactMutation =
    opts.action === "read" ||
    opts.action === "data-plane" ||
    (approvedRequest?.action === opts.action &&
      approvedRequest?.operation === opts.request?.operation &&
      approvedRequest?.operation_id === opts.request?.operation_id &&
      (approvedRequest?.vm_id ?? null) ===
        (opts.vm_id ?? opts.request?.vm_id ?? null));
  if (grant && (!allowedActions.includes(opts.action) || !exactMutation)) {
    const request = {
      action: opts.action,
      operation: opts.request?.operation ?? null,
      operation_id: opts.request?.operation_id ?? null,
      vm_id: opts.vm_id ?? opts.request?.vm_id ?? null,
      allow_create: opts.request?.allow_create === true,
      provider: opts.request?.provider ?? null,
      machine_class: opts.request?.machine_class ?? null,
      funding_mode: opts.request?.funding_mode ?? null,
      active_vms: Number(opts.request?.active_vms ?? 0),
      hourly_usd: Number(opts.request?.hourly_usd ?? 0),
      total_authorized_usd: Number(opts.request?.total_authorized_usd ?? 0),
      ttl_minutes: Number(opts.request?.ttl_minutes ?? 0),
      requested_at: new Date().toISOString(),
    };
    await pool.query(
      `UPDATE compute_vm_turn_grants
          SET metadata=COALESCE(metadata,'{}'::jsonb) || $2::jsonb
        WHERE grant_id=$1`,
      [grant.grant_id, { pending_request: request }],
    );
    await centralLog({
      event: "managed_compute_agent_grant_requested",
      value: {
        account_id: opts.auth.account_id,
        project_id: opts.project_id,
        grant_id: grant.grant_id,
        turn_id: grant.turn_id,
        session_id: grant.session_id,
        request,
      },
    });
    throw Object.assign(
      new Error(
        `this VM action needs temporary account approval; open the attached project's VMs page and approve request ${grant.grant_id}`,
      ),
      { code: "agent_grant_required", grant_id: grant.grant_id },
    );
  }
  if (
    !grant ||
    grant.owner_account_id !== opts.auth.account_id ||
    grant.project_id !== opts.project_id ||
    !allowedActions.includes(opts.action) ||
    ((grant.allowed_vm_ids ?? []).length > 0 &&
      opts.vm_id &&
      !(grant.allowed_vm_ids ?? []).includes(opts.vm_id))
  ) {
    throw Object.assign(
      new Error("managed-compute capability does not permit this action"),
      { code: 403 },
    );
  }
  const request = opts.request ?? {};
  if (request.allow_create && grant.allow_create !== true) {
    throw Object.assign(
      new Error("managed-compute grant does not allow create"),
      {
        code: 403,
      },
    );
  }
  if (
    request.provider &&
    !(grant.allowed_providers ?? []).includes(request.provider)
  ) {
    throw Object.assign(
      new Error("managed-compute grant does not allow this provider"),
      { code: 403 },
    );
  }
  if (
    request.machine_class &&
    (grant.allowed_machine_classes ?? []).length > 0 &&
    !(grant.allowed_machine_classes ?? []).includes(request.machine_class)
  ) {
    throw Object.assign(
      new Error("managed-compute grant does not allow this machine class"),
      { code: 403 },
    );
  }
  if (request.funding_mode && grant.funding_mode !== request.funding_mode) {
    throw Object.assign(
      new Error("managed-compute grant does not allow this funding lane"),
      { code: 403 },
    );
  }
  const numericBounds: Array<[number | undefined, unknown, string]> = [
    [request.active_vms, grant.max_active_vms, "active VM count"],
    [request.hourly_usd, grant.max_hourly_usd, "hourly cost"],
    [
      request.total_authorized_usd,
      grant.max_total_authorized_usd,
      "total authorized cost",
    ],
    [request.ttl_minutes, grant.max_ttl_minutes, "TTL"],
  ];
  for (const [actual, rawMaximum, label] of numericBounds) {
    if (actual == null) continue;
    const maximum = Number(rawMaximum ?? 0);
    if (!Number.isFinite(maximum) || actual > maximum) {
      throw Object.assign(
        new Error(`managed-compute grant ${label} envelope exceeded`),
        { code: 403 },
      );
    }
  }
  await pool.query(
    `UPDATE compute_vm_turn_grants SET last_used_at=NOW() WHERE grant_id=$1`,
    [grant.grant_id],
  );
  await centralLog({
    event: "managed_compute_agent_grant_used",
    value: {
      account_id: opts.auth.account_id,
      project_id: opts.project_id,
      grant_id: grant.grant_id,
      turn_id: grant.turn_id,
      session_id: grant.session_id,
      vm_id: opts.vm_id ?? null,
      action: opts.action,
      request: opts.request ?? null,
      source_worker:
        process.env.PROJECT_RUNNER_NAME ?? process.env.PROJECT_HOST_ID ?? null,
      result: "authorized",
    },
  });
}

export async function listAgentComputeGrants(opts: {
  account_id: string;
  project_id: string;
  include_expired?: boolean;
}): Promise<any[]> {
  const { rows } = await getPool().query(
    `SELECT grant_id, owner_account_id, project_id, turn_id, session_id,
            issued_by_account_id, allowed_actions, allowed_vm_ids,
            allow_create, allowed_providers, allowed_machine_classes,
            funding_mode, max_active_vms, max_hourly_usd,
            max_total_authorized_usd, max_ttl_minutes, expires_at,
            revoked_at, created_at, last_used_at, metadata
       FROM compute_vm_turn_grants
      WHERE owner_account_id=$1 AND project_id=$2
        ${opts.include_expired ? "" : "AND revoked_at IS NULL AND expires_at > NOW()"}
      ORDER BY created_at DESC LIMIT 100`,
    [opts.account_id, opts.project_id],
  );
  return rows;
}

export async function approveAgentComputeGrant(opts: {
  account_id: string;
  grant_id: string;
}): Promise<any> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT * FROM compute_vm_turn_grants
        WHERE grant_id=$1 AND owner_account_id=$2 AND revoked_at IS NULL
          AND expires_at > NOW()
        FOR UPDATE`,
      [opts.grant_id, opts.account_id],
    );
    const grant = rows[0];
    const request = grant?.metadata?.pending_request;
    if (!grant || !request?.action) {
      throw new Error("managed-compute grant request is missing or expired");
    }
    if (
      !["availability", "billable", "destructive"].includes(request.action) ||
      typeof request.operation !== "string" ||
      request.operation.length === 0 ||
      !/^[a-f0-9]{64}$/.test(request.operation_id ?? "")
    ) {
      throw new Error("managed-compute grant request is invalid");
    }
    for (const value of [
      request.active_vms,
      request.hourly_usd,
      request.total_authorized_usd,
      request.ttl_minutes,
    ]) {
      if (!Number.isFinite(Number(value ?? 0)) || Number(value ?? 0) < 0) {
        throw new Error(
          "managed-compute grant request has an invalid envelope",
        );
      }
    }
    const expiresAt = new Date(
      Math.min(new Date(grant.expires_at).valueOf(), Date.now() + 30 * 60_000),
    );
    const allowedVmIds = request.vm_id ? [request.vm_id] : [];
    const updated = await client.query(
      `UPDATE compute_vm_turn_grants SET
       issued_by_account_id=$2,
       allowed_actions=ARRAY['read','data-plane',$3]::text[],
       allowed_vm_ids=$4::uuid[],
       allow_create=$5,
       allowed_providers=CASE WHEN $6::text IS NULL THEN '{}'::text[] ELSE ARRAY[$6]::text[] END,
       allowed_machine_classes=CASE WHEN $7::text IS NULL THEN '{}'::text[] ELSE ARRAY[$7]::text[] END,
       funding_mode=$8,
       max_active_vms=$9,
       max_hourly_usd=$10,
       max_total_authorized_usd=$11,
       max_ttl_minutes=$12,
       expires_at=$13,
       metadata=(COALESCE(metadata,'{}'::jsonb) - 'pending_request') || $14::jsonb
     WHERE grant_id=$1 RETURNING grant_id, owner_account_id, project_id,
       turn_id, session_id, issued_by_account_id, allowed_actions,
       allowed_vm_ids, allow_create, allowed_providers,
       allowed_machine_classes, funding_mode, max_active_vms,
       max_hourly_usd, max_total_authorized_usd, max_ttl_minutes,
       expires_at, revoked_at, created_at, last_used_at, metadata`,
      [
        grant.grant_id,
        opts.account_id,
        request.action,
        allowedVmIds,
        request.allow_create === true,
        request.provider,
        request.machine_class,
        request.funding_mode,
        Math.max(0, Number(request.active_vms ?? 0)),
        Math.max(0, Number(request.hourly_usd ?? 0)),
        Math.max(0, Number(request.total_authorized_usd ?? 0)),
        Math.max(0, Number(request.ttl_minutes ?? 0)),
        expiresAt,
        { approved_request: request, approved_at: new Date().toISOString() },
      ],
    );
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function revokeAgentComputeGrant(opts: {
  account_id: string;
  grant_id: string;
}): Promise<void> {
  await getPool().query(
    `UPDATE compute_vm_turn_grants SET revoked_at=NOW()
      WHERE grant_id=$1 AND owner_account_id=$2 AND revoked_at IS NULL`,
    [opts.grant_id, opts.account_id],
  );
}
