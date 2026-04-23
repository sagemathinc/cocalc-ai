/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Cloud-host bootstrap reconcile helpers for hosts.

What belongs here:

- cloud-host bootstrap reconcile support checks
- the ssh-driven bootstrap reconcile execution flow
- the bootstrap status polling helpers that wait for reconcile completion

What does not belong here:

- public API handler entrypoints
- generic host lifecycle operations
- host bootstrap metadata normalization for host responses
- runtime deployment orchestration

`hosts.ts` keeps the public wrappers and dependency wiring while this module
contains the cloud bootstrap reconcile mechanics.
*/

import { spawn } from "node:child_process";
import { delay } from "awaiting";
import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { normalizeProviderId } from "@cocalc/cloud";
import { createProjectHostBootstrapToken } from "@cocalc/server/project-host/bootstrap-token";
import { buildCloudInitStartupScript } from "@cocalc/server/cloud/bootstrap-host";
import {
  getHostOwnerBaySshIdentity,
  getHostSshPublicKeys,
} from "@cocalc/server/cloud/ssh-key";
import { resolveLaunchpadBootstrapUrl } from "@cocalc/server/launchpad/bootstrap-url";
import { getRoutedHostControlClient } from "@cocalc/server/project-host/client";
import { getProviderContext } from "@cocalc/server/cloud/provider-context";

const logger = getLogger("server:conat:api:hosts");
const HOST_BOOTSTRAP_RECONCILE_TIMEOUT_MS = 20 * 60 * 1000;
const HOST_BOOTSTRAP_RECONCILE_POLL_MS = 5_000;

function pool() {
  return getPool();
}

async function runSshScript({
  target,
  script,
  identityFile,
}: {
  target: string;
  script: string;
  identityFile: string;
}): Promise<{ stdout: string; stderr: string }> {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=10",
    "-i",
    identityFile,
    target,
    "bash",
    "-se",
  ];
  return await new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `ssh ${target} failed with code ${code ?? "?"}: ${stderr || stdout}`,
          ),
        );
      }
    });
    child.stdin.end(script);
  });
}

type HostBootstrapReconcileState = {
  deleted: boolean;
  status: string;
  bootstrap_status?: string;
  bootstrap_updated_at?: string;
  bootstrap_message?: string;
  lifecycle_summary_status?: string;
  lifecycle_summary_message?: string;
  lifecycle_current_operation?: string;
  lifecycle_last_error?: string;
  lifecycle_last_reconcile_started_at?: string;
  lifecycle_last_reconcile_finished_at?: string;
};

function parseBootstrapTimestampMs(value?: string): number | undefined {
  const text = `${value ?? ""}`.trim();
  if (!text) return undefined;
  const ms = new Date(text).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function bootstrapErrorIsStale(state: HostBootstrapReconcileState): boolean {
  if (state.bootstrap_status !== "error") return false;
  const bootstrapUpdatedMs = parseBootstrapTimestampMs(
    state.bootstrap_updated_at,
  );
  if (state.lifecycle_summary_status === "in_sync") {
    const finishedMs = parseBootstrapTimestampMs(
      state.lifecycle_last_reconcile_finished_at,
    );
    return (
      finishedMs != null &&
      (bootstrapUpdatedMs == null || bootstrapUpdatedMs <= finishedMs)
    );
  }
  if (state.lifecycle_summary_status === "reconciling") {
    const startedMs = parseBootstrapTimestampMs(
      state.lifecycle_last_reconcile_started_at,
    );
    return (
      startedMs != null &&
      (bootstrapUpdatedMs == null || bootstrapUpdatedMs < startedMs)
    );
  }
  return false;
}

async function loadHostBootstrapReconcileState(
  host_id: string,
): Promise<HostBootstrapReconcileState | undefined> {
  const { rows } = await pool().query(
    `SELECT status, deleted, metadata FROM project_hosts WHERE id=$1 LIMIT 1`,
    [host_id],
  );
  const row = rows[0];
  if (!row) return undefined;
  const metadata = row.metadata ?? {};
  const bootstrap = metadata.bootstrap ?? {};
  const lifecycle = metadata.bootstrap_lifecycle ?? {};
  return {
    deleted: !!row.deleted,
    status: `${row.status ?? ""}`.trim(),
    bootstrap_status: `${bootstrap.status ?? ""}`.trim() || undefined,
    bootstrap_updated_at: `${bootstrap.updated_at ?? ""}`.trim() || undefined,
    bootstrap_message: `${bootstrap.message ?? ""}`.trim() || undefined,
    lifecycle_summary_status:
      `${lifecycle.summary_status ?? ""}`.trim() || undefined,
    lifecycle_summary_message:
      `${lifecycle.summary_message ?? ""}`.trim() || undefined,
    lifecycle_current_operation:
      `${lifecycle.current_operation ?? ""}`.trim() || undefined,
    lifecycle_last_error: `${lifecycle.last_error ?? ""}`.trim() || undefined,
    lifecycle_last_reconcile_started_at:
      `${lifecycle.last_reconcile_started_at ?? ""}`.trim() || undefined,
    lifecycle_last_reconcile_finished_at:
      `${lifecycle.last_reconcile_finished_at ?? ""}`.trim() || undefined,
  };
}

function hostBootstrapActivityChanged(
  baseline: HostBootstrapReconcileState,
  current: HostBootstrapReconcileState,
): boolean {
  return (
    current.bootstrap_status !== baseline.bootstrap_status ||
    current.bootstrap_updated_at !== baseline.bootstrap_updated_at ||
    current.bootstrap_message !== baseline.bootstrap_message ||
    current.lifecycle_summary_status !== baseline.lifecycle_summary_status ||
    current.lifecycle_summary_message !== baseline.lifecycle_summary_message ||
    current.lifecycle_current_operation !==
      baseline.lifecycle_current_operation ||
    current.lifecycle_last_error !== baseline.lifecycle_last_error ||
    current.lifecycle_last_reconcile_started_at !==
      baseline.lifecycle_last_reconcile_started_at ||
    current.lifecycle_last_reconcile_finished_at !==
      baseline.lifecycle_last_reconcile_finished_at
  );
}

function hostBootstrapReconcileSucceeded(
  state: HostBootstrapReconcileState,
): boolean {
  if (state.lifecycle_summary_status === "in_sync") {
    return true;
  }
  return state.bootstrap_status === "done";
}

function hostBootstrapReconcileFailure(
  state: HostBootstrapReconcileState,
): string | undefined {
  if (state.bootstrap_status === "error" && !bootstrapErrorIsStale(state)) {
    return (
      state.bootstrap_message ??
      state.lifecycle_last_error ??
      "bootstrap reconcile failed"
    );
  }
  if (state.lifecycle_summary_status === "error") {
    return (
      state.lifecycle_last_error ??
      state.lifecycle_summary_message ??
      "bootstrap reconcile failed"
    );
  }
  if (
    state.lifecycle_summary_status === "drifted" &&
    state.bootstrap_status === "done" &&
    state.lifecycle_current_operation !== "reconcile"
  ) {
    return (
      state.lifecycle_summary_message ??
      state.lifecycle_last_error ??
      "host software remains drifted after reconcile"
    );
  }
  return undefined;
}

async function waitForHostBootstrapReconcile({
  host_id,
  baseline,
}: {
  host_id: string;
  baseline: HostBootstrapReconcileState;
}): Promise<void> {
  const startedAt = Date.now();
  let sawActivity = false;
  while (Date.now() - startedAt < HOST_BOOTSTRAP_RECONCILE_TIMEOUT_MS) {
    const state = await loadHostBootstrapReconcileState(host_id);
    if (!state) {
      throw new Error("host not found");
    }
    if (state.deleted) {
      throw new Error("host deleted during bootstrap reconcile");
    }
    sawActivity ||= hostBootstrapActivityChanged(baseline, state);
    if (sawActivity) {
      const failure = hostBootstrapReconcileFailure(state);
      if (failure) {
        throw new Error(failure);
      }
      if (hostBootstrapReconcileSucceeded(state)) {
        return;
      }
    }
    await delay(HOST_BOOTSTRAP_RECONCILE_POLL_MS);
  }
  throw new Error("timeout waiting for host bootstrap reconcile");
}

function cloudHostSshTarget(row: {
  metadata?: Record<string, any>;
}): string | undefined {
  const runtime = row.metadata?.runtime ?? {};
  const machine = row.metadata?.machine ?? {};
  const publicIp =
    `${runtime.public_ip ?? machine.metadata?.public_ip ?? ""}`.trim();
  if (!publicIp) return undefined;
  const sshUser =
    `${runtime.ssh_user ?? machine.metadata?.ssh_user ?? "ubuntu"}`.trim();
  if (!sshUser) return undefined;
  return `${sshUser}@${publicIp}`;
}

async function trustHostOwnerBaySshKeyViaHostControl({
  host_id,
  publicKey,
}: {
  host_id: string;
  publicKey: string;
}): Promise<boolean> {
  try {
    const client = await getRoutedHostControlClient({
      host_id,
      timeout: 15_000,
      fresh: true,
    });
    const response = await client.addHostSshAuthorizedKey({
      public_key: publicKey,
    });
    logger.info("host upgrade: ensured owner bay ssh key via host control", {
      host_id,
      added: !!response.added,
    });
    return true;
  } catch (err) {
    logger.warn(
      "host upgrade: unable to repair owner bay ssh key via host control before ssh reconcile",
      {
        host_id,
        err,
      },
    );
    return false;
  }
}

async function trustHostOwnerBaySshKeyViaCloudProvider({
  row,
  publicKey,
}: {
  row: any;
  publicKey: string;
}): Promise<{ attempted: boolean; succeeded: boolean }> {
  const providerId = normalizeProviderId(row?.metadata?.machine?.cloud);
  if (!providerId || providerId === "self-host") {
    return { attempted: false, succeeded: false };
  }
  try {
    const { entry, creds } = await getProviderContext(providerId, {
      region: row?.region,
    });
    if (!entry.provider.ensureSshAccess) {
      return { attempted: false, succeeded: false };
    }
    const machine = row?.metadata?.machine ?? {};
    const runtime = row?.metadata?.runtime ?? {};
    const instanceId =
      `${runtime.instance_id ?? machine.instance_id ?? row?.name ?? ""}`.trim();
    if (!instanceId) {
      return { attempted: false, succeeded: false };
    }
    const sshUser =
      `${runtime.ssh_user ?? machine.metadata?.ssh_user ?? "ubuntu"}`.trim() ||
      "ubuntu";
    const sshPublicKeys = await getHostSshPublicKeys();
    await entry.provider.ensureSshAccess(
      {
        provider: providerId,
        instance_id: instanceId,
        public_ip: runtime.public_ip ?? machine.metadata?.public_ip,
        ssh_user: sshUser,
        zone: runtime.zone ?? machine.zone ?? machine.metadata?.zone,
        dns_name: runtime.dns_name,
        metadata: {
          ...(runtime.metadata ?? {}),
          ssh_user: sshUser,
          ssh_public_key: publicKey,
          ssh_public_keys: sshPublicKeys,
        },
      },
      creds,
    );
    logger.info("host upgrade: ensured owner bay ssh key via cloud provider", {
      host_id: row?.id,
      provider: providerId,
    });
    return { attempted: true, succeeded: true };
  } catch (err) {
    logger.warn(
      "host upgrade: unable to repair owner bay ssh key via cloud provider before ssh reconcile",
      {
        host_id: row?.id,
        provider: providerId,
        err,
      },
    );
    return { attempted: true, succeeded: false };
  }
}

export async function trustSshPublicKeyViaCloudProviderForHostRow({
  host_id,
  row,
  publicKey,
}: {
  host_id: string;
  row: any;
  publicKey: string;
}): Promise<{ attempted: boolean; succeeded: boolean }> {
  return await trustHostOwnerBaySshKeyViaCloudProvider({
    row: { ...row, id: host_id },
    publicKey,
  });
}

export async function trustHostOwnerBaySshKeyForHostRow({
  host_id,
  row,
}: {
  host_id: string;
  row: any;
}): Promise<{
  public_key: string;
  host_control_attempted: boolean;
  host_control_succeeded: boolean;
  cloud_provider_attempted: boolean;
  cloud_provider_succeeded: boolean;
}> {
  const sshIdentity = await getHostOwnerBaySshIdentity();
  const cloudProvider = await trustSshPublicKeyViaCloudProviderForHostRow({
    host_id,
    row,
    publicKey: sshIdentity.publicKey,
  });
  const hostControlSucceeded = await trustHostOwnerBaySshKeyViaHostControl({
    host_id,
    publicKey: sshIdentity.publicKey,
  });
  return {
    public_key: sshIdentity.publicKey,
    host_control_attempted: true,
    host_control_succeeded: hostControlSucceeded,
    cloud_provider_attempted: cloudProvider.attempted,
    cloud_provider_succeeded: cloudProvider.succeeded,
  };
}

export function assertCloudHostBootstrapReconcileSupported(row: any): void {
  const machineCloud = normalizeProviderId(row?.metadata?.machine?.cloud);
  if (!machineCloud || machineCloud === "self-host") {
    throw new Error(
      "bootstrap reconcile is only supported for cloud hosts with ssh access",
    );
  }
  if (!cloudHostSshTarget(row)) {
    throw new Error(
      "bootstrap reconcile requires a reachable cloud ssh target for this host",
    );
  }
}

export async function reconcileCloudHostBootstrapOverSsh(opts: {
  host_id: string;
  row: any;
}): Promise<void> {
  const target = cloudHostSshTarget(opts.row);
  if (!target) {
    logger.debug(
      "host upgrade: skip bootstrap reconcile (missing ssh target)",
      {
        host_id: opts.host_id,
      },
    );
    return;
  }
  const { baseUrl: bootstrapBaseUrl } = await resolveLaunchpadBootstrapUrl({
    preferCurrentBay: true,
    requirePublic: true,
  });
  const bootstrapToken = await createProjectHostBootstrapToken(opts.host_id);
  const sshIdentity = await getHostOwnerBaySshIdentity();
  await trustHostOwnerBaySshKeyForHostRow({
    host_id: opts.host_id,
    row: opts.row,
  });
  const bootstrapScript = await buildCloudInitStartupScript(
    opts.row,
    bootstrapToken.token,
    bootstrapBaseUrl,
  );
  const baseline = await loadHostBootstrapReconcileState(opts.host_id);
  if (!baseline) {
    throw new Error("host not found");
  }
  const encodedBootstrapScript = Buffer.from(bootstrapScript, "utf8").toString(
    "base64",
  );
  const script = `
set -euo pipefail
BOOTSTRAP_DIR=""
for candidate in /mnt/cocalc/data/.host-bootstrap/bootstrap /home/ubuntu/cocalc-host/bootstrap /root/cocalc-host/bootstrap
do
  if [ -d "$candidate" ]; then
    BOOTSTRAP_DIR="$candidate"
    break
  fi
done
if [ -z "$BOOTSTRAP_DIR" ]; then
  echo "bootstrap directory not found" >&2
  exit 1
fi
BOOTSTRAP_SH="$BOOTSTRAP_DIR/bootstrap.sh"
python3 - "$BOOTSTRAP_SH" <<'PY'
import base64, sys
body = base64.b64decode("""${encodedBootstrapScript}""")
with open(sys.argv[1], "wb") as handle:
    handle.write(body)
PY
chmod 700 "$BOOTSTRAP_SH"
LOG_DIR="/mnt/cocalc/data/logs"
BOOTSTRAP_LOG="$LOG_DIR/bootstrap-reconcile.log"
sudo -n install -d -m 0755 "$LOG_DIR"
sudo -n touch "$BOOTSTRAP_LOG"
BOOTSTRAP_PID="$(sudo -n bash -lc 'nohup bash "$1" >>"$2" 2>&1 </dev/null & echo $!' -- "$BOOTSTRAP_SH" "$BOOTSTRAP_LOG")"
echo "started bootstrap reconcile pid=$BOOTSTRAP_PID log=$BOOTSTRAP_LOG"
`;
  logger.info("host upgrade: reconciling host bootstrap over ssh", {
    host_id: opts.host_id,
    target,
  });
  const { stdout, stderr } = await runSshScript({
    target,
    script,
    identityFile: sshIdentity.privateKeyPath,
  });
  if (stdout.trim()) {
    logger.info("host upgrade: bootstrap reconcile stdout", {
      host_id: opts.host_id,
      target,
      stdout,
    });
  }
  if (stderr.trim()) {
    logger.info("host upgrade: bootstrap reconcile stderr", {
      host_id: opts.host_id,
      target,
      stderr,
    });
  }
  await waitForHostBootstrapReconcile({
    host_id: opts.host_id,
    baseline,
  });
}
