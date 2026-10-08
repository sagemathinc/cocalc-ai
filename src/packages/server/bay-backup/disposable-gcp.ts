/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { InstancesClient, ZoneOperationsClient } from "@google-cloud/compute";

import getLogger from "@cocalc/backend/logger";

const logger = getLogger("server:bay-backup:disposable-gcp");

const RESULT_PREFIX = "COCALC_BAY_RESTORE_DRILL_RESULT_V1_";
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 5_000;

export interface TemporaryR2Credentials {
  access_key_id: string;
  secret_access_key: string;
  session_token: string;
  expires_in_seconds: number;
  prefixes: string[];
}

export interface DisposableRestoreWorkerConfig {
  run_id: string;
  result_nonce: string;
  bay_id: string;
  backup_set_id: string;
  repository_type?: "legacy-rustic" | "pgbackrest";
  snapshot_id: string;
  restore_mode: "snapshot" | "pitr";
  target_time?: string;
  pitr_run_id?: string;
  postgres_major: number;
  postgres_user: string;
  postgres_database: string;
  r2_endpoint: string;
  r2_bucket: string;
  r2_access_key_id: string;
  r2_secret_access_key: string;
  r2_session_token: string;
  rustic_repo_root: string;
  rustic_repo_password: string;
  wal_object_prefix?: string;
  pgbackrest_repo_path?: string;
  pgbackrest_cipher_pass?: string;
  pgbackrest_stanza?: string;
  pgbackrest_version?: string;
  pgbackrest_source_sha256?: string;
  require_conat: boolean;
  minimum_free_bytes: number;
  worker_timeout_seconds?: number;
  archive_get_timeout_seconds?: number;
  archive_get_attempts?: number;
  wal_replay_stall_timeout_seconds?: number;
}

export interface DisposableRestoreWorkerResult {
  version: 1;
  status: "passed" | "failed";
  run_id: string;
  stage: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  error?: string;
  /** Seconds spent in each worker stage, from older workers absent. */
  stage_seconds?: Record<string, number>;
  postgres?: {
    repository_type?: "legacy-rustic" | "pgbackrest";
    backup_label?: string | null;
    restore_mode: "snapshot" | "pitr";
    pitr_verified: boolean;
    pre_count: number | null;
    post_count: number | null;
    database: string;
    tables_verified: string[];
  };
  conat?: {
    sync_tree_found: boolean;
    database_count: number;
    database_bytes: number;
    quick_check_passed: number;
    catalog_found: boolean;
    catalog_quick_check?: string;
  };
  disk?: {
    total_bytes: number;
    free_bytes_before: number;
    free_bytes_after: number;
  };
}

export interface DisposableGcpRestoreResult {
  worker: DisposableRestoreWorkerResult;
  instance_name: string;
  project_id: string;
  zone: string;
  machine_type: string;
  boot_disk_gb: number;
  cleanup: "deleted" | "already-deleted";
}

/** Bounded, numeric stage timings from an untrusted worker result. */
export function workerStageSeconds(
  worker: Pick<DisposableRestoreWorkerResult, "stage_seconds"> | undefined,
): Record<string, number> | null {
  const raw = worker?.stage_seconds;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const seconds: Record<string, number> = {};
  for (const [stage, value] of Object.entries(raw).slice(0, 32)) {
    if (/^[a-z][a-z0-9-]{0,63}$/.test(stage) && Number.isFinite(value))
      seconds[stage] = Math.max(0, Math.round(Number(value) * 10) / 10);
  }
  return seconds;
}

export function isRetryableDisposablePitrWalFailure(
  worker: DisposableRestoreWorkerResult,
): boolean {
  return (
    worker.status === "failed" &&
    worker.stage === "postgres-pitr" &&
    /\bWAL replay stalled on segment [0-9A-F]{24} for \d+ seconds\b/i.test(
      `${worker.error ?? ""}`,
    )
  );
}

export function disposableRestoreInstanceName(run_id: string): string {
  return `cocalc-restore-${run_id.replace(/-/g, "").slice(0, 20)}`;
}

type GcpAuth = {
  projectId: string;
  credentials: {
    client_email: string;
    private_key: string;
  };
};

type GcpClients = {
  instances: Pick<
    InstancesClient,
    "insert" | "delete" | "get" | "getSerialPortOutput"
  >;
  operations: Pick<ZoneOperationsClient, "wait">;
};

function cleanPrefix(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function boundedError(value: unknown, maxLength = 2_000): string {
  const text = `${value instanceof Error ? value.message : (value ?? "")}`;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

function parseGcpServiceAccount(serviceAccountJson: string): GcpAuth {
  let parsed: any;
  try {
    parsed = JSON.parse(serviceAccountJson);
  } catch (err) {
    throw new Error(`invalid GCP service account JSON: ${boundedError(err)}`);
  }
  const projectId = `${parsed?.project_id ?? ""}`.trim();
  const client_email = `${parsed?.client_email ?? ""}`.trim();
  const private_key = `${parsed?.private_key ?? ""}`.trim();
  if (!projectId || !client_email || !private_key) {
    throw new Error("GCP service account JSON is missing required fields");
  }
  return {
    projectId,
    credentials: { client_email, private_key },
  };
}

export async function createTemporaryR2ReadCredentials({
  account_id,
  api_token,
  bucket,
  parent_access_key_id,
  prefixes,
  ttl_seconds,
  fetch_impl = fetch,
}: {
  account_id: string;
  api_token: string;
  bucket: string;
  parent_access_key_id: string;
  prefixes: string[];
  ttl_seconds: number;
  fetch_impl?: typeof fetch;
}): Promise<TemporaryR2Credentials> {
  const normalizedPrefixes = Array.from(
    new Set(prefixes.map(cleanPrefix).filter(Boolean)),
  ).map((prefix) => `${prefix}/`);
  if (!normalizedPrefixes.length) {
    throw new Error("temporary R2 credentials require at least one prefix");
  }
  const response = await fetch_impl(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account_id)}/r2/temp-access-credentials`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${api_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        bucket,
        parentAccessKeyId: parent_access_key_id,
        permission: "object-read-only",
        ttlSeconds: ttl_seconds,
        prefixes: normalizedPrefixes,
      }),
    },
  );
  const body = (await response.json().catch(() => undefined)) as any;
  const access_key_id = `${body?.result?.accessKeyId ?? ""}`.trim();
  const secret_access_key = `${body?.result?.secretAccessKey ?? ""}`.trim();
  const session_token = `${body?.result?.sessionToken ?? ""}`.trim();
  if (
    !response.ok ||
    body?.success !== true ||
    !access_key_id ||
    !secret_access_key ||
    !session_token
  ) {
    const errors = Array.isArray(body?.errors)
      ? body.errors
          .map((entry: any) => `${entry?.code ?? ""}: ${entry?.message ?? ""}`)
          .join("; ")
      : "";
    throw new Error(
      `failed to create temporary R2 credentials (${response.status}): ${errors || "invalid response"}`,
    );
  }
  return {
    access_key_id,
    secret_access_key,
    session_token,
    expires_in_seconds: ttl_seconds,
    prefixes: normalizedPrefixes,
  };
}

// The restore engine is one Python program shared by the disposable drill and
// production restores (bay-restore). It ships with every bay release in its
// bin/ directory; tests and development read it from the repository.
const RESTORE_ENGINE_FILE = "bay-restore-engine.py";

export function restoreEngineSourcePath(): string {
  const candidates = [
    `${process.env.COCALC_BAY_RESTORE_ENGINE_PATH ?? ""}`.trim(),
    join(
      `${process.env.COCALC_BAY_CURRENT_LINK ?? "/opt/cocalc/bay/current"}`,
      "bin",
      RESTORE_ENGINE_FILE,
    ),
    // src/packages/server/{dist,}/bay-backup -> src/scripts/bay-systemd/bin
    join(__dirname, "../../../../scripts/bay-systemd/bin", RESTORE_ENGINE_FILE),
    join(__dirname, "../../../scripts/bay-systemd/bin", RESTORE_ENGINE_FILE),
  ].filter(Boolean);
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      `bay restore engine not found; looked in: ${candidates.join(", ")}`,
    );
  }
  return found;
}

function pythonWorkerSource(): string {
  const source = readFileSync(restoreEngineSourcePath(), "utf8");
  if (!source.includes(RESULT_PREFIX)) {
    throw new Error("bay restore engine does not match this release");
  }
  return source;
}

export function buildDisposableRestoreStartupScript(
  config: DisposableRestoreWorkerConfig,
): string {
  const workerConfig = { ...config };
  if (workerConfig.restore_mode === "pitr" && workerConfig.target_time) {
    const target = new Date(workerConfig.target_time);
    if (Number.isNaN(target.getTime())) {
      throw new Error(
        `invalid disposable PITR target '${workerConfig.target_time}'`,
      );
    }
    workerConfig.target_time = target
      .toISOString()
      .replace("T", " ")
      .replace("Z", "+00");
  }
  const encodedConfig = Buffer.from(JSON.stringify(workerConfig)).toString(
    "base64",
  );
  const encodedWorker = Buffer.from(pythonWorkerSource()).toString("base64");
  return `#!/bin/bash
set -euo pipefail
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# The VM has no listening service. Drop unsolicited ingress before installing tools.
iptables -P INPUT DROP || true
iptables -A INPUT -i lo -j ACCEPT || true
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT || true
ip6tables -P INPUT DROP || true
ip6tables -A INPUT -i lo -j ACCEPT || true
ip6tables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT || true

printf '%s' '${encodedConfig}' | base64 -d > /root/cocalc-restore-drill.json
printf '%s' '${encodedWorker}' | base64 -d > /root/cocalc-restore-worker.py
chmod 600 /root/cocalc-restore-drill.json /root/cocalc-restore-worker.py
python3 /root/cocalc-restore-worker.py
`;
}

async function waitForOperation({
  response,
  project,
  zone,
  operations,
}: {
  response: any;
  project: string;
  zone: string;
  operations: GcpClients["operations"];
}): Promise<void> {
  let operation = response?.latestResponse ?? response;
  if (!operation?.name) return;
  while (`${operation.status ?? ""}` !== "DONE") {
    [operation] = await operations.wait({
      operation: operation.name,
      project,
      zone,
    });
  }
  const errors = Array.isArray(operation?.error?.errors)
    ? operation.error.errors
    : [];
  if (errors.length) {
    throw new Error(
      errors
        .map((entry: any) => `${entry?.code ?? ""}: ${entry?.message ?? ""}`)
        .join("; "),
    );
  }
}

function isNotFound(err: unknown): boolean {
  const value = err as any;
  return (
    value?.code === 404 ||
    value?.code === 5 ||
    /not found/i.test(`${value?.message ?? ""}`)
  );
}

function parseWorkerResult({
  contents,
  nonce,
}: {
  contents: string;
  nonce: string;
}): DisposableRestoreWorkerResult | undefined {
  const marker = `${RESULT_PREFIX}${nonce}=`;
  const index = contents.lastIndexOf(marker);
  if (index < 0) return;
  const payloadStart = index + marker.length;
  const payloadEnd = contents.indexOf("\n", payloadStart);
  // Serial output is chunked arbitrarily. Do not decode a marker until its
  // newline terminator proves that the complete base64 payload has arrived.
  if (payloadEnd < 0) return;
  const encoded = contents.slice(payloadStart, payloadEnd).trim();
  if (!encoded) return;
  const parsed = JSON.parse(
    Buffer.from(encoded, "base64").toString("utf8"),
  ) as DisposableRestoreWorkerResult;
  if (parsed.version !== 1 || !parsed.run_id || !parsed.status) {
    throw new Error("invalid disposable restore worker result");
  }
  return parsed;
}

function defaultClients(auth: GcpAuth): GcpClients {
  return {
    instances: new InstancesClient(auth),
    operations: new ZoneOperationsClient(auth),
  };
}

export async function runDisposableGcpRestoreWorker({
  service_account_json,
  zone,
  machine_type = "n2-standard-4",
  boot_disk_gb,
  config,
  timeout_ms = DEFAULT_TIMEOUT_MS,
  clients: providedClients,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: {
  service_account_json: string;
  zone: string;
  machine_type?: string;
  boot_disk_gb: number;
  config: DisposableRestoreWorkerConfig;
  timeout_ms?: number;
  clients?: GcpClients;
  sleep?: (ms: number) => Promise<void>;
}): Promise<DisposableGcpRestoreResult> {
  const auth = parseGcpServiceAccount(service_account_json);
  const clients = providedClients ?? defaultClients(auth);
  const instance_name = disposableRestoreInstanceName(config.run_id);
  const region = zone.replace(/-[a-z]$/, "");
  const startupScript = buildDisposableRestoreStartupScript({
    ...config,
    worker_timeout_seconds: Math.ceil(timeout_ms / 1000),
  });
  const timeoutSeconds = Math.max(900, Math.ceil(timeout_ms / 1000) + 600);
  let created = false;
  let cleanup: DisposableGcpRestoreResult["cleanup"] = "already-deleted";
  let result: DisposableGcpRestoreResult | undefined;
  let runError: unknown;
  try {
    // The insert may succeed server-side even if the client times out. From this
    // point onward, always attempt deletion by the deterministic instance name.
    created = true;
    const [insertResponse] = await clients.instances.insert({
      project: auth.projectId,
      zone,
      instanceResource: {
        name: instance_name,
        machineType: `zones/${zone}/machineTypes/${machine_type}`,
        canIpForward: false,
        deletionProtection: false,
        disks: [
          {
            autoDelete: true,
            boot: true,
            initializeParams: {
              diskSizeGb: `${boot_disk_gb}`,
              diskType: `projects/${auth.projectId}/zones/${zone}/diskTypes/pd-balanced`,
              sourceImage:
                "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64",
            },
          },
        ],
        labels: {
          "cocalc-role": "bay-restore-drill",
          "cocalc-bay": config.bay_id
            .toLowerCase()
            .replace(/[^a-z0-9_-]/g, "-")
            .slice(0, 63),
        },
        metadata: {
          items: [
            { key: "startup-script", value: startupScript },
            { key: "serial-port-enable", value: "TRUE" },
            { key: "block-project-ssh-keys", value: "TRUE" },
            { key: "enable-oslogin", value: "FALSE" },
          ],
        },
        networkInterfaces: [
          {
            accessConfigs: [{ name: "External NAT", networkTier: "STANDARD" }],
            stackType: "IPV4_ONLY",
            subnetwork: `projects/${auth.projectId}/regions/${region}/subnetworks/default`,
          },
        ],
        scheduling: {
          automaticRestart: false,
          onHostMaintenance: "TERMINATE",
          preemptible: false,
          provisioningModel: "STANDARD",
          maxRunDuration: { seconds: `${timeoutSeconds}` },
          instanceTerminationAction: "DELETE",
        },
        serviceAccounts: [],
        shieldedInstanceConfig: {
          enableIntegrityMonitoring: true,
          enableSecureBoot: true,
          enableVtpm: true,
        },
      },
    } as any);
    await waitForOperation({
      response: insertResponse,
      project: auth.projectId,
      zone,
      operations: clients.operations,
    });
    logger.info("created disposable GCP restore drill worker", {
      instance_name,
      project_id: auth.projectId,
      zone,
      machine_type,
      boot_disk_gb,
      run_id: config.run_id,
    });

    const deadline = Date.now() + timeout_ms;
    let cursor = "0";
    let serial = "";
    while (Date.now() < deadline) {
      try {
        const [output] = await clients.instances.getSerialPortOutput({
          project: auth.projectId,
          zone,
          instance: instance_name,
          port: 1,
          start: cursor,
        } as any);
        const contents = `${(output as any)?.contents ?? ""}`;
        cursor = `${(output as any)?.next ?? cursor}`;
        if (contents) {
          serial = `${serial}${contents}`.slice(-256 * 1024);
          const worker = parseWorkerResult({
            contents: serial,
            nonce: config.result_nonce,
          });
          if (worker) {
            if (worker.run_id !== config.run_id) {
              throw new Error("restore worker result run_id mismatch");
            }
            result = {
              worker,
              instance_name,
              project_id: auth.projectId,
              zone,
              machine_type,
              boot_disk_gb,
              cleanup: "deleted",
            };
            break;
          }
        }
      } catch (err) {
        if (isNotFound(err)) {
          throw new Error(
            "disposable restore VM disappeared before reporting a result",
          );
        }
        throw err;
      }
      if (result) break;
      await sleep(POLL_INTERVAL_MS);
    }
    if (!result) {
      throw new Error(
        `disposable restore VM timed out after ${Math.round(timeout_ms / 1000)} seconds`,
      );
    }
  } catch (err) {
    runError = err;
  }

  let cleanupError: unknown;
  if (created) {
    try {
      const [deleteResponse] = await clients.instances.delete({
        project: auth.projectId,
        zone,
        instance: instance_name,
      });
      await waitForOperation({
        response: deleteResponse,
        project: auth.projectId,
        zone,
        operations: clients.operations,
      });
      cleanup = "deleted";
    } catch (err) {
      if (!isNotFound(err)) {
        cleanupError = err;
        logger.error("failed deleting disposable GCP restore drill worker", {
          instance_name,
          project_id: auth.projectId,
          zone,
          err,
        });
      }
    }
  }
  logger.info("disposed GCP restore drill worker", {
    instance_name,
    project_id: auth.projectId,
    zone,
    cleanup,
  });
  if (cleanupError) throw cleanupError;
  if (runError) throw runError;
  if (!result) throw new Error("disposable restore worker returned no result");
  result.cleanup = cleanup;
  return result;
}

export function newDisposableRestoreWorkerIdentity(): {
  run_id: string;
  result_nonce: string;
} {
  return {
    run_id: randomUUID(),
    result_nonce: randomBytes(16).toString("hex"),
  };
}
