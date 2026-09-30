/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHmac, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { isIP } from "node:net";
import getLogger from "@cocalc/backend/logger";
import { conatPassword } from "@cocalc/backend/data";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import {
  decryptSecretStorageValue,
  encryptSecretStorageValue,
} from "@cocalc/database/settings/secret-settings";
import type {
  HostExamCleanupMode,
  HostExamConfig,
  HostExamConfigInput,
  HostExamRun,
  HostExamRunStatus,
  HostExamRuntimeStatus,
  HostExamState,
} from "@cocalc/conat/hub/api/hosts";
import {
  ensureHostnameCnameDns,
  ensureProxiedAddressDns,
} from "@cocalc/server/cloud/dns";
import { getRoutedHostControlClient } from "@cocalc/server/project-host/client";
import adminAlert from "@cocalc/server/messages/admin-alert";
import type { RootfsImageManifest } from "@cocalc/util/rootfs-images";

const logger = getLogger("server:project-host:exam");

const CONFIG_TABLE = "project_host_exam_configs";
const RUN_TABLE = "project_host_exam_runs";
const ACTIVE_RUN_STATUSES: HostExamRunStatus[] = [
  "preparing",
  "ready",
  "open",
  "closing",
  "cleaning",
  "error",
];
const PROJECT_HOST_RPC_TIMEOUT_MS = 10 * 60_000;
const MANUAL_CLEANUP_DEADLINE = "9999-12-31T23:59:59.000Z";
const WAITING_FOR_HOST_STOPPED_AT_DEADLINE =
  "waiting for the project host to report that the exam projects were erased; the host shuts itself down at the deadline, so the run completes when the host next runs";
const STABLE_TOKEN_MARKER = "stable:";
const DEFAULT_EXAM_CONFIG: Omit<HostExamConfigInput, "enabled"> = {
  title: "Exam Scratchpad",
  max_projects: 100,
  project_cpu: 1,
  project_memory_mb: 2_000,
  project_disk_mb: 5_000,
  project_ttl_minutes: 6 * 60,
  cleanup_grace_minutes: 10,
  terminal_enabled: false,
  network_mode: "disabled",
};

let schemaPromise: Promise<void> | undefined;

export interface ExamHostRow {
  id: string;
  name?: string;
  status?: string;
  public_ip?: string | null;
  public_url?: string | null;
  metadata?: Record<string, any>;
}

function dateString(value: unknown): string | undefined {
  if (value == null) return;
  const date = value instanceof Date ? value : new Date(`${value}`);
  if (!Number.isFinite(date.valueOf())) return;
  return date.toISOString();
}

function mapConfig(row: any): HostExamConfig {
  return {
    host_id: row.host_id,
    enabled: row.enabled === true,
    title: `${row.title ?? "Exam Scratchpad"}`,
    hostname: row.hostname,
    dns_record_id: row.dns_record_id ?? null,
    dns_target: row.dns_target ?? null,
    generation: Number(row.generation),
    max_projects: Number(row.max_projects),
    project_cpu: Number(row.project_cpu),
    project_memory_mb: Number(row.project_memory_mb),
    project_disk_mb: Number(row.project_disk_mb),
    project_ttl_minutes: Number(row.project_ttl_minutes),
    cleanup_grace_minutes: Number(row.cleanup_grace_minutes),
    terminal_enabled: row.terminal_enabled === true,
    network_mode: "disabled",
    created_at: dateString(row.created_at)!,
    updated_at: dateString(row.updated_at)!,
    created_by: row.created_by,
    updated_by: row.updated_by,
  };
}

function mapRun(row: any): HostExamRun {
  return {
    run_id: row.run_id,
    host_id: row.host_id,
    config_generation: Number(row.config_generation),
    status: row.status,
    rootfs_image: row.rootfs_image,
    rootfs_digest: row.rootfs_digest,
    run_quota:
      typeof row.run_quota === "string"
        ? JSON.parse(row.run_quota)
        : row.run_quota,
    max_projects: Number(row.max_projects),
    terminal_enabled: row.terminal_enabled === true,
    network_mode: "disabled",
    cleanup_mode: row.cleanup_mode === "manual" ? "manual" : "scheduled",
    scheduled_stop_at: dateString(row.scheduled_stop_at)!,
    stop_host_at_deadline: row.stop_host_at_deadline !== false,
    owner_account_id: row.owner_account_id,
    opened_at: dateString(row.opened_at) ?? null,
    admission_closed_at: dateString(row.admission_closed_at) ?? null,
    cleanup_started_at: dateString(row.cleanup_started_at) ?? null,
    cleaned_at: dateString(row.cleaned_at) ?? null,
    stopped_at: dateString(row.stopped_at) ?? null,
    last_error: row.last_error ?? null,
    created_at: dateString(row.created_at)!,
    updated_at: dateString(row.updated_at)!,
    created_by: row.created_by,
  };
}

async function migrateLegacyExamColumnNames(): Promise<void> {
  const renames = [
    [CONFIG_TABLE, "max_workspaces", "max_projects"],
    [CONFIG_TABLE, "workspace_cpu", "project_cpu"],
    [CONFIG_TABLE, "workspace_memory_mb", "project_memory_mb"],
    [CONFIG_TABLE, "workspace_disk_mb", "project_disk_mb"],
    [CONFIG_TABLE, "workspace_ttl_minutes", "project_ttl_minutes"],
    [RUN_TABLE, "max_workspaces", "max_projects"],
  ] as const;
  for (const [table, legacy, current] of renames) {
    const { rows } = await getPool().query<{ column_name: string }>(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name=$1
          AND column_name IN ($2, $3)
      `,
      [table, legacy, current],
    );
    const columns = new Set(rows.map(({ column_name }) => column_name));
    if (!columns.has(legacy)) continue;
    if (!columns.has(current)) {
      await getPool().query(
        `ALTER TABLE ${table} RENAME COLUMN ${legacy} TO ${current}`,
      );
      continue;
    }
    await getPool().query(
      `UPDATE ${table} SET ${current}=COALESCE(${current}, ${legacy})`,
    );
    await getPool().query(`ALTER TABLE ${table} DROP COLUMN ${legacy}`);
  }
}

async function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await getPool().query(`
        CREATE TABLE IF NOT EXISTS ${CONFIG_TABLE} (
          host_id UUID PRIMARY KEY,
          enabled BOOLEAN NOT NULL DEFAULT FALSE,
          title TEXT NOT NULL DEFAULT 'Exam Scratchpad',
          hostname TEXT NOT NULL UNIQUE,
          dns_record_id TEXT,
          dns_target TEXT,
          generation BIGINT NOT NULL DEFAULT 1,
          max_projects INTEGER NOT NULL,
          project_cpu DOUBLE PRECISION NOT NULL,
          project_memory_mb INTEGER NOT NULL,
          project_disk_mb INTEGER NOT NULL,
          project_ttl_minutes INTEGER NOT NULL,
          cleanup_grace_minutes INTEGER NOT NULL,
          terminal_enabled BOOLEAN NOT NULL DEFAULT FALSE,
          network_mode TEXT NOT NULL DEFAULT 'disabled',
          token_hash TEXT,
          token_ciphertext TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by UUID NOT NULL,
          updated_by UUID NOT NULL
        )
      `);
      await getPool().query(`
        CREATE TABLE IF NOT EXISTS ${RUN_TABLE} (
          run_id UUID PRIMARY KEY,
          host_id UUID NOT NULL,
          config_generation BIGINT NOT NULL,
          status TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          create_idempotency_key TEXT NOT NULL,
          token_idempotency_key TEXT NOT NULL,
          rootfs_image TEXT NOT NULL,
          rootfs_digest TEXT NOT NULL,
          run_quota JSONB NOT NULL,
          max_projects INTEGER NOT NULL,
          terminal_enabled BOOLEAN NOT NULL DEFAULT FALSE,
          network_mode TEXT NOT NULL DEFAULT 'disabled',
          cleanup_mode TEXT NOT NULL DEFAULT 'scheduled',
          scheduled_stop_at TIMESTAMPTZ NOT NULL,
          stop_host_at_deadline BOOLEAN NOT NULL DEFAULT TRUE,
          owner_account_id UUID NOT NULL,
          opened_at TIMESTAMPTZ,
          admission_closed_at TIMESTAMPTZ,
          cleanup_started_at TIMESTAMPTZ,
          cleaned_at TIMESTAMPTZ,
          stopped_at TIMESTAMPTZ,
          last_error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_by UUID NOT NULL
        )
      `);
      await migrateLegacyExamColumnNames();
      await getPool().query(`
        ALTER TABLE ${CONFIG_TABLE}
          ADD COLUMN IF NOT EXISTS title TEXT DEFAULT 'Exam Scratchpad'
      `);
      await getPool().query(`
        UPDATE ${CONFIG_TABLE}
        SET title='Exam Scratchpad'
        WHERE title IS NULL OR BTRIM(title)=''
      `);
      await getPool().query(`
        ALTER TABLE ${CONFIG_TABLE}
          ALTER COLUMN title SET DEFAULT 'Exam Scratchpad',
          ALTER COLUMN title SET NOT NULL
      `);
      await getPool().query(`
        ALTER TABLE ${CONFIG_TABLE}
          ALTER COLUMN max_projects SET NOT NULL,
          ALTER COLUMN project_cpu SET NOT NULL,
          ALTER COLUMN project_memory_mb SET NOT NULL,
          ALTER COLUMN project_disk_mb SET NOT NULL,
          ALTER COLUMN project_ttl_minutes SET NOT NULL
      `);
      await getPool().query(`
        ALTER TABLE ${RUN_TABLE}
          ALTER COLUMN max_projects SET NOT NULL
      `);
      await getPool().query(`
        ALTER TABLE ${RUN_TABLE}
          ADD COLUMN IF NOT EXISTS stop_host_at_deadline BOOLEAN DEFAULT TRUE
      `);
      await getPool().query(`
        ALTER TABLE ${CONFIG_TABLE}
          ADD COLUMN IF NOT EXISTS token_hash TEXT,
          ADD COLUMN IF NOT EXISTS token_ciphertext TEXT
      `);
      await getPool().query(`
        ALTER TABLE ${RUN_TABLE}
          ADD COLUMN IF NOT EXISTS cleanup_mode TEXT DEFAULT 'scheduled'
      `);
      await getPool().query(`
        UPDATE ${RUN_TABLE}
        SET cleanup_mode='scheduled'
        WHERE cleanup_mode IS NULL
      `);
      await getPool().query(`
        ALTER TABLE ${RUN_TABLE}
          ALTER COLUMN cleanup_mode SET DEFAULT 'scheduled',
          ALTER COLUMN cleanup_mode SET NOT NULL
      `);
      await getPool().query(`
        UPDATE ${RUN_TABLE}
        SET stop_host_at_deadline=TRUE
        WHERE stop_host_at_deadline IS NULL
      `);
      await getPool().query(`
        ALTER TABLE ${RUN_TABLE}
          ALTER COLUMN stop_host_at_deadline SET DEFAULT TRUE,
          ALTER COLUMN stop_host_at_deadline SET NOT NULL
      `);
      // The shared schema synchronizer creates declared timestamp fields before
      // this feature-specific schema initializer runs. Those generic columns are
      // nullable and have no default, so CREATE TABLE IF NOT EXISTS alone does
      // not establish the lifecycle invariants required here.
      await getPool().query(`
        UPDATE ${CONFIG_TABLE}
        SET created_at=COALESCE(created_at, updated_at, NOW()),
            updated_at=COALESCE(updated_at, created_at, NOW())
        WHERE created_at IS NULL OR updated_at IS NULL
      `);
      await getPool().query(`
        ALTER TABLE ${CONFIG_TABLE}
          ALTER COLUMN created_at SET DEFAULT NOW(),
          ALTER COLUMN created_at SET NOT NULL,
          ALTER COLUMN updated_at SET DEFAULT NOW(),
          ALTER COLUMN updated_at SET NOT NULL
      `);
      await getPool().query(`
        UPDATE ${RUN_TABLE}
        SET created_at=COALESCE(created_at, updated_at, NOW()),
            updated_at=COALESCE(updated_at, created_at, NOW())
        WHERE created_at IS NULL OR updated_at IS NULL
      `);
      await getPool().query(`
        ALTER TABLE ${RUN_TABLE}
          ALTER COLUMN created_at SET DEFAULT NOW(),
          ALTER COLUMN created_at SET NOT NULL,
          ALTER COLUMN updated_at SET DEFAULT NOW(),
          ALTER COLUMN updated_at SET NOT NULL
      `);
      await getPool().query(`
        CREATE UNIQUE INDEX IF NOT EXISTS project_host_exam_runs_active_host_idx
        ON ${RUN_TABLE}(host_id)
        WHERE status <> 'stopped'
      `);
      await getPool().query(`
        CREATE UNIQUE INDEX IF NOT EXISTS project_host_exam_runs_create_key_idx
        ON ${RUN_TABLE}(host_id, created_by, create_idempotency_key)
      `);
      await getPool().query(`
        CREATE INDEX IF NOT EXISTS project_host_exam_runs_due_idx
        ON ${RUN_TABLE}(scheduled_stop_at)
        WHERE status <> 'stopped'
      `);
    })().catch((err) => {
      schemaPromise = undefined;
      throw err;
    });
  }
  await schemaPromise;
}

function requireFiniteRange(
  value: unknown,
  {
    label,
    min,
    max,
    integer = false,
  }: { label: string; min: number; max: number; integer?: boolean },
): number {
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < min ||
    parsed > max ||
    (integer && !Number.isInteger(parsed))
  ) {
    throw new Error(
      `${label} must be ${integer ? "an integer " : ""}between ${min} and ${max}`,
    );
  }
  return parsed;
}

function normalizeConfig(input: HostExamConfigInput): HostExamConfigInput {
  const legacy = input as HostExamConfigInput & Record<string, unknown>;
  if (input.network_mode != null && input.network_mode !== "disabled") {
    throw new Error("the exam MVP supports only disabled project networking");
  }
  return {
    enabled: input.enabled === true,
    title: normalizeScratchpadTitle(input.title),
    max_projects: requireFiniteRange(
      input.max_projects ?? legacy.max_workspaces,
      {
        label: "max_projects",
        min: 1,
        max: 1_000,
        integer: true,
      },
    ),
    project_cpu: requireFiniteRange(input.project_cpu ?? legacy.workspace_cpu, {
      label: "project_cpu",
      min: 0.1,
      max: 128,
    }),
    project_memory_mb: requireFiniteRange(
      input.project_memory_mb ?? legacy.workspace_memory_mb,
      {
        label: "project_memory_mb",
        min: 256,
        max: 1_048_576,
        integer: true,
      },
    ),
    project_disk_mb: requireFiniteRange(
      input.project_disk_mb ?? legacy.workspace_disk_mb,
      {
        label: "project_disk_mb",
        min: 1_000,
        max: 4_000_000,
        integer: true,
      },
    ),
    project_ttl_minutes: requireFiniteRange(
      input.project_ttl_minutes ?? legacy.workspace_ttl_minutes,
      {
        label: "project_ttl_minutes",
        min: 180,
        max: 2 * 24 * 60,
        integer: true,
      },
    ),
    cleanup_grace_minutes: requireFiniteRange(input.cleanup_grace_minutes, {
      label: "cleanup_grace_minutes",
      min: 1,
      max: 60,
      integer: true,
    }),
    terminal_enabled: input.terminal_enabled === true,
    network_mode: "disabled",
    admission_token:
      input.admission_token == null
        ? undefined
        : normalizeAdmissionToken(input.admission_token),
  };
}

function normalizeAdmissionToken(value: unknown): string {
  const token = `${value ?? ""}`.trim();
  if (token.length < 8 || token.length > 200 || !/^[\x20-\x7e]+$/.test(token)) {
    throw new Error(
      "admission_token must contain 8 to 200 printable characters",
    );
  }
  return token;
}

function generateAdmissionToken(): string {
  return randomBytes(24).toString("base64url");
}

function tokenSecretName(host_id: string): string {
  return `project-host-exam-token:${host_id}`;
}

async function decryptExamToken(
  host_id: string,
  ciphertext: string,
): Promise<string> {
  return (await decryptSecretStorageValue(tokenSecretName(host_id), ciphertext))
    .value;
}

async function loadStableExamToken({
  host_id,
  create = false,
}: {
  host_id: string;
  create?: boolean;
}): Promise<string | undefined> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT token_ciphertext FROM ${CONFIG_TABLE} WHERE host_id=$1`,
    [host_id],
  );
  const ciphertext = rows[0]?.token_ciphertext;
  if (ciphertext) return await decryptExamToken(host_id, ciphertext);
  if (!create || !rows[0]) return;
  const token = generateAdmissionToken();
  const encrypted = await encryptSecretStorageValue(
    tokenSecretName(host_id),
    token,
  );
  const updated = await getPool().query(
    `UPDATE ${CONFIG_TABLE}
     SET token_hash=$2, token_ciphertext=$3, updated_at=NOW()
     WHERE host_id=$1 AND token_ciphertext IS NULL
     RETURNING token_ciphertext`,
    [host_id, hashToken(token), encrypted],
  );
  if (updated.rows[0]) return token;
  return await loadStableExamToken({ host_id });
}

function normalizeScratchpadTitle(value: unknown): string {
  const title = `${value ?? "Exam Scratchpad"}`.trim();
  if (!title || title.length > 100) {
    throw new Error("title must contain 1 to 100 characters");
  }
  return title;
}

function publicHostname(host: ExamHostRow): string {
  const raw = `${host.public_url ?? host.metadata?.public_url ?? ""}`.trim();
  if (!raw) {
    throw new Error("host must have a public URL before exam mode is enabled");
  }
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    throw new Error("host public URL is invalid");
  }
}

function examHostnameForHost(host: ExamHostRow): string {
  const target = publicHostname(host);
  const labels = target.split(".");
  const first = labels[0] ?? "";
  labels[0] = first.startsWith("host-")
    ? `exam-${first.slice("host-".length)}`
    : `exam-${host.id}`;
  return labels.join(".");
}

function publicIp(host: ExamHostRow): string {
  const value = `${
    host.public_ip ??
    host.metadata?.runtime?.public_ip ??
    host.metadata?.public_ip ??
    host.metadata?.ip_address ??
    ""
  }`.trim();
  if (isIP(value) !== 4) {
    throw new Error(
      "host must have a reconciled public IPv4 address before exam mode is enabled",
    );
  }
  return value;
}

function examDnsRoute(
  host: ExamHostRow,
): { type: "A"; target: string } | { type: "CNAME"; target: string } {
  if (host.metadata?.public_route?.active_mode === "cloudflare-proxy") {
    return { type: "A", target: publicIp(host) };
  }
  const tunnelId = `${host.metadata?.cloudflare_tunnel?.id ?? ""}`.trim();
  if (!tunnelId) {
    throw new Error(
      "host must have an active direct route or Cloudflare tunnel before exam mode is enabled",
    );
  }
  return { type: "CNAME", target: `${tunnelId}.cfargotunnel.com` };
}

async function ensureExamPublicIngress({
  host,
  route,
  ensureDirectIngress = async (host) => {
    const { ensureDirectCloudflareIngressForHost } =
      await import("@cocalc/server/cloud/public-route");
    await ensureDirectCloudflareIngressForHost(host);
  },
}: {
  host: ExamHostRow;
  route: ReturnType<typeof examDnsRoute>;
  ensureDirectIngress?: (host: ExamHostRow) => Promise<void>;
}): Promise<void> {
  if (route.type !== "A") return;
  await ensureDirectIngress(host);
}

function ownerAccountId(host: ExamHostRow): string {
  const owner = `${
    host.metadata?.owner ?? host.metadata?.owner_account_id ?? ""
  }`.trim();
  if (!owner) {
    throw new Error("project host has no billing owner");
  }
  return owner;
}

async function ensureExamRootfsCached({
  control,
  rootfs_image,
  actor_account_id,
  loadVisibleRootfsImages = async (account_id) => {
    const { listVisibleRootfsImages } =
      await import("@cocalc/server/rootfs/catalog");
    return await listVisibleRootfsImages(account_id);
  },
}: {
  control: {
    listRootfsImages: () => Promise<
      Array<{ image: string; digest?: string | null }>
    >;
    pullRootfsImage: (opts: {
      image: string;
    }) => Promise<{ image: string; digest?: string | null }>;
  };
  rootfs_image: string;
  actor_account_id: string;
  loadVisibleRootfsImages?: (
    account_id: string,
  ) => Promise<RootfsImageManifest>;
}): Promise<{ image: string; digest: string }> {
  const image = rootfs_image.trim();
  const cached = await control.listRootfsImages();
  const existing = cached.find((entry) => entry.image === image);
  if (existing?.digest) {
    return { image: existing.image, digest: existing.digest };
  }

  const catalog = await loadVisibleRootfsImages(actor_account_id);
  const visible = catalog.images.find((entry) => entry.image === image);
  if (!visible) {
    throw new Error(
      "the selected RootFS is not available in your managed image catalog",
    );
  }
  const pulled = await control.pullRootfsImage({ image: visible.image });
  if (!pulled.digest) {
    throw new Error(
      "the selected RootFS could not be cached with an immutable digest",
    );
  }
  return { image: pulled.image, digest: pulled.digest };
}

function validateIdempotencyKey(value: string): string {
  const key = `${value ?? ""}`.trim();
  if (!/^[a-zA-Z0-9._:-]{8,200}$/.test(key)) {
    throw new Error("idempotency_key must contain 8 to 200 safe characters");
  }
  return key;
}

function deterministicToken({
  run_id,
  idempotency_key,
}: {
  run_id: string;
  idempotency_key: string;
}): string {
  return createHmac("sha256", conatPassword)
    .update(`project-host-exam-token-v1:${run_id}:${idempotency_key}`)
    .digest("base64url");
}

function hashToken(token: string): string {
  const salt = randomBytes(16);
  const digest = scryptSync(token, salt, 32);
  return `scrypt-v1$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

function validateDeadline(
  scheduled_stop_at: string,
  project_ttl_minutes: number,
): string {
  const deadline = new Date(scheduled_stop_at);
  const now = Date.now();
  if (!Number.isFinite(deadline.valueOf())) {
    throw new Error("scheduled_stop_at must be a valid timestamp");
  }
  if (deadline.valueOf() < now + 60_000) {
    throw new Error(
      "scheduled_stop_at must be at least one minute in the future",
    );
  }
  if (deadline.valueOf() > now + project_ttl_minutes * 60_000) {
    throw new Error(
      `scheduled_stop_at exceeds the configured ${project_ttl_minutes}-minute run limit`,
    );
  }
  return deadline.toISOString();
}

async function loadConfig(
  host_id: string,
  client: PoolClient | ReturnType<typeof getPool> = getPool(),
): Promise<HostExamConfig | undefined> {
  await ensureSchema();
  const { rows } = await client.query(
    `SELECT * FROM ${CONFIG_TABLE} WHERE host_id=$1`,
    [host_id],
  );
  return rows[0] ? mapConfig(rows[0]) : undefined;
}

async function loadCurrentRun(
  host_id: string,
  client: PoolClient | ReturnType<typeof getPool> = getPool(),
): Promise<HostExamRun | undefined> {
  await ensureSchema();
  const { rows } = await client.query(
    `
      SELECT *
      FROM ${RUN_TABLE}
      WHERE host_id=$1
      ORDER BY
        (status = 'stopped') ASC,
        COALESCE(created_at, updated_at) DESC,
        updated_at DESC,
        run_id DESC
      LIMIT 1
    `,
    [host_id],
  );
  return rows[0] ? mapRun(rows[0]) : undefined;
}

async function loadRunById({
  host_id,
  run_id,
}: {
  host_id: string;
  run_id: string;
}): Promise<HostExamRun | undefined> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT * FROM ${RUN_TABLE} WHERE host_id=$1 AND run_id=$2`,
    [host_id, run_id],
  );
  return rows[0] ? mapRun(rows[0]) : undefined;
}

async function loadRunToken({
  host_id,
  run_id,
}: {
  host_id: string;
  run_id: string;
}): Promise<string | undefined> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT run_id, status, token_idempotency_key FROM ${RUN_TABLE} WHERE host_id=$1 AND run_id=$2`,
    [host_id, run_id],
  );
  const row = rows[0];
  if (`${row?.token_idempotency_key ?? ""}`.startsWith(STABLE_TOKEN_MARKER)) {
    return await loadStableExamToken({ host_id, create: true });
  }
  return tokenForRunRecord(row);
}

function tokenForRunRecord(row?: {
  run_id?: string;
  status?: string;
  token_idempotency_key?: string;
}): string | undefined {
  if (!row?.run_id || row.status === "stopped" || !row.token_idempotency_key) {
    return;
  }
  return deterministicToken({
    run_id: row.run_id,
    idempotency_key: row.token_idempotency_key,
  });
}

async function loadRuntimeStatus(
  host: ExamHostRow,
  run?: HostExamRun,
): Promise<HostExamRuntimeStatus | undefined> {
  if (host.status !== "running") return;
  try {
    const client = await getRoutedHostControlClient({
      host_id: host.id,
      timeout: 15_000,
      fresh: true,
    });
    // The project host is authoritative for which run is actually active.
    // Do not constrain this query using potentially stale central state.
    let runtime = (await client.getExamRunStatus({})) as HostExamRuntimeStatus &
      Record<string, unknown>;
    if (!runtime.run_id && run && run.status !== "stopped") {
      // A run the host has finished, for example at its deadline, is no
      // longer its current run. Ask for it by id so the central row heals.
      const finished = (await client.getExamRunStatus({
        run_id: run.run_id,
      })) as HostExamRuntimeStatus & Record<string, unknown>;
      if (finished.run_id === run.run_id) runtime = finished;
    }
    return {
      ...runtime,
      active_projects: Number(
        runtime.active_projects ?? runtime.active_workspaces ?? 0,
      ),
      max_projects:
        runtime.max_projects == null && runtime.max_workspaces == null
          ? undefined
          : Number(runtime.max_projects ?? runtime.max_workspaces),
    };
  } catch (err) {
    logger.warn("unable to load project-host exam runtime status", {
      host_id: host.id,
      run_id: run?.run_id,
      err: `${err}`,
    });
    return {
      run_id: run?.run_id,
      status: run?.status,
      admission_open: false,
      active_projects: 0,
      max_projects: run?.max_projects,
      scheduled_stop_at: run?.scheduled_stop_at,
      last_error: `project-host status unavailable: ${err}`,
    };
  }
}

export async function getExamStateLocal({
  host,
  eligible,
  eligibility_reason,
}: {
  host: ExamHostRow;
  eligible: boolean;
  eligibility_reason?: string;
}): Promise<HostExamState> {
  const [config, centralRun] = await Promise.all([
    loadConfig(host.id),
    loadCurrentRun(host.id),
  ]);
  const runtime = await loadRuntimeStatus(host, centralRun);
  let run = centralRun;
  if (runtime?.run_id && runtime.run_id !== run?.run_id) {
    run =
      (await loadRunById({ host_id: host.id, run_id: runtime.run_id })) ?? run;
  }
  if (shouldReconcileRunWithRuntime(run, runtime)) {
    if (run && runtime) {
      // The project host owns execution state. Heal the central row when a
      // hub restart or lost RPC response interrupted the original mutation.
      run = await updateRunFromRuntime({
        run_id: run.run_id,
        runtime,
      });
    }
  }
  const token =
    run && run.status !== "stopped"
      ? await loadRunToken({ host_id: host.id, run_id: run.run_id })
      : config
        ? await loadStableExamToken({ host_id: host.id, create: true })
        : undefined;
  return {
    eligible,
    eligibility_reason,
    host_status: host.status,
    config,
    run,
    runtime,
    token,
  };
}

function shouldReconcileRunWithRuntime(
  run?: HostExamRun,
  runtime?: HostExamRuntimeStatus,
): boolean {
  return !!(
    run &&
    runtime?.run_id === run.run_id &&
    ((runtime.status && runtime.status !== run.status) ||
      (runtime.max_projects != null &&
        runtime.max_projects !== run.max_projects))
  );
}

async function ensureExamDns({
  host,
  config,
  ensure_public_ingress = false,
}: {
  host: ExamHostRow;
  config: HostExamConfig;
  ensure_public_ingress?: boolean;
}): Promise<HostExamConfig> {
  const route = examDnsRoute(host);
  if (ensure_public_ingress) {
    await ensureExamPublicIngress({ host, route });
  }
  const { record_id } =
    route.type === "A"
      ? await ensureProxiedAddressDns({
          name: config.hostname,
          ipAddress: route.target,
          record_id: config.dns_record_id ?? undefined,
        })
      : await ensureHostnameCnameDns({
          hostname: config.hostname,
          target_hostname: route.target,
          record_id: config.dns_record_id ?? undefined,
          adopt_existing: true,
        });
  const { rows } = await getPool().query(
    `
      UPDATE ${CONFIG_TABLE}
      SET dns_record_id=$2, dns_target=$3, updated_at=NOW()
      WHERE host_id=$1
      RETURNING *
    `,
    [host.id, record_id, route.target],
  );
  return mapConfig(rows[0]);
}

export async function setExamConfigLocal({
  host,
  actor_account_id,
  input,
}: {
  host: ExamHostRow;
  actor_account_id: string;
  input: HostExamConfigInput;
}): Promise<HostExamConfig> {
  await ensureSchema();
  const config = normalizeConfig(input);
  const hostname = examHostnameForHost(host);
  const token =
    config.admission_token ??
    (await loadStableExamToken({ host_id: host.id })) ??
    generateAdmissionToken();
  const token_hash = hashToken(token);
  const token_ciphertext = await encryptSecretStorageValue(
    tokenSecretName(host.id),
    token,
  );
  // Serialize with run creation so a run cannot be reserved between the
  // active-run check and the configuration change.
  const db = await getPool().connect();
  let saved: HostExamConfig;
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
      "project-host-exam-run-create",
      host.id,
    ]);
    const activeRun = await loadCurrentRun(host.id, db);
    if (activeRun && activeRun.status !== "stopped") {
      throw new Error(
        "exam configuration cannot change while an exam run is active",
      );
    }
    const { rows } = await db.query(
      `
        INSERT INTO ${CONFIG_TABLE} (
          host_id, enabled, title, hostname, generation, max_projects,
          project_cpu, project_memory_mb, project_disk_mb,
          project_ttl_minutes, cleanup_grace_minutes, terminal_enabled,
          network_mode, token_hash, token_ciphertext, created_by, updated_by
        )
        VALUES (
          $1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10, $11, 'disabled',
          $12, $13, $14, $14
        )
        ON CONFLICT (host_id) DO UPDATE SET
          enabled=EXCLUDED.enabled,
          title=EXCLUDED.title,
          max_projects=EXCLUDED.max_projects,
          project_cpu=EXCLUDED.project_cpu,
          project_memory_mb=EXCLUDED.project_memory_mb,
          project_disk_mb=EXCLUDED.project_disk_mb,
          project_ttl_minutes=EXCLUDED.project_ttl_minutes,
          cleanup_grace_minutes=EXCLUDED.cleanup_grace_minutes,
          terminal_enabled=EXCLUDED.terminal_enabled,
          network_mode='disabled',
          token_hash=EXCLUDED.token_hash,
          token_ciphertext=EXCLUDED.token_ciphertext,
          generation=${CONFIG_TABLE}.generation + 1,
          updated_by=EXCLUDED.updated_by,
          updated_at=NOW()
        RETURNING *
      `,
      [
        host.id,
        config.enabled,
        config.title,
        hostname,
        config.max_projects,
        config.project_cpu,
        config.project_memory_mb,
        config.project_disk_mb,
        config.project_ttl_minutes,
        config.cleanup_grace_minutes,
        config.terminal_enabled,
        token_hash,
        token_ciphertext,
        actor_account_id,
      ],
    );
    await db.query("COMMIT");
    saved = mapConfig(rows[0]);
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    db.release();
  }
  if (!saved.enabled) return saved;
  return await ensureExamDns({
    host,
    config: saved,
    ensure_public_ingress: true,
  });
}

async function updateRunFromRuntime({
  run_id,
  runtime,
  keep_stopped = false,
}: {
  run_id: string;
  runtime: HostExamRuntimeStatus;
  keep_stopped?: boolean;
}): Promise<HostExamRun> {
  const status = runtime.status ?? "error";
  const { rows } = await getPool().query(
    `
      UPDATE ${RUN_TABLE}
      SET status=$2,
          max_projects=CASE
            WHEN $4::INTEGER IS NULL THEN max_projects
            ELSE GREATEST(max_projects, $4::INTEGER)
          END,
          opened_at=CASE WHEN $2='open' THEN COALESCE(opened_at, NOW()) ELSE opened_at END,
          admission_closed_at=CASE
            WHEN $2 IN ('closing', 'cleaning', 'stopped') THEN COALESCE(admission_closed_at, NOW())
            ELSE admission_closed_at
          END,
          cleanup_started_at=CASE
            WHEN $2 IN ('cleaning', 'stopped') THEN COALESCE(cleanup_started_at, NOW())
            ELSE cleanup_started_at
          END,
          cleaned_at=CASE WHEN $2='stopped' THEN COALESCE(cleaned_at, NOW()) ELSE cleaned_at END,
          stopped_at=CASE WHEN $2='stopped' THEN COALESCE(stopped_at, NOW()) ELSE stopped_at END,
          last_error=$3,
          updated_at=NOW()
      WHERE run_id=$1 AND NOT ($5::BOOLEAN AND status='stopped')
      RETURNING *
    `,
    [
      run_id,
      status,
      runtime.last_error ?? null,
      runtime.max_projects ?? null,
      keep_stopped,
    ],
  );
  if (rows[0]) return mapRun(rows[0]);
  if (keep_stopped) {
    const stopped = await getPool().query(
      `SELECT * FROM ${RUN_TABLE} WHERE run_id=$1`,
      [run_id],
    );
    if (stopped.rows[0]) return mapRun(stopped.rows[0]);
  }
  throw new Error("exam run not found");
}

export async function createExamRunLocal({
  host,
  actor_account_id,
  rootfs_image,
  cleanup_mode = "scheduled",
  scheduled_stop_at,
  stop_host_at_deadline = true,
  idempotency_key,
}: {
  host: ExamHostRow;
  actor_account_id: string;
  rootfs_image: string;
  cleanup_mode?: HostExamCleanupMode;
  scheduled_stop_at?: string;
  stop_host_at_deadline?: boolean;
  idempotency_key: string;
}): Promise<{ run: HostExamRun; token: string }> {
  await ensureSchema();
  if (host.status !== "running") {
    throw new Error(
      "the project host must be running before preparing an exam",
    );
  }
  let config = await loadConfig(host.id);
  if (!config?.enabled) {
    throw new Error("exam mode is not enabled for this project host");
  }
  config = await ensureExamDns({
    host,
    config,
    ensure_public_ingress: true,
  });
  const key = validateIdempotencyKey(idempotency_key);
  const nextCleanupMode: HostExamCleanupMode =
    cleanup_mode === "manual" ? "manual" : "scheduled";
  const deadline =
    nextCleanupMode === "manual"
      ? MANUAL_CLEANUP_DEADLINE
      : validateDeadline(
          `${scheduled_stop_at ?? ""}`,
          config.project_ttl_minutes,
        );
  const token = await loadStableExamToken({ host_id: host.id, create: true });
  if (!token) throw new Error("exam admission token is not configured");
  const control = await getRoutedHostControlClient({
    host_id: host.id,
    timeout: PROJECT_HOST_RPC_TIMEOUT_MS,
    fresh: true,
  });
  const selected = await ensureExamRootfsCached({
    control,
    rootfs_image,
    actor_account_id,
  });

  const run_id = randomUUID();
  const token_hash = hashToken(token);
  const run_quota = {
    cpu_limit: config.project_cpu,
    memory_limit: config.project_memory_mb,
    disk_quota: config.project_disk_mb,
    pids_limit: 4_096,
  };
  const db = await getPool().connect();
  let transactionOpen = false;
  let run: HostExamRun;
  try {
    await db.query("BEGIN");
    transactionOpen = true;
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
      "project-host-exam-run-create",
      host.id,
    ]);
    const existingByKey = await db.query(
      `
        SELECT *
        FROM ${RUN_TABLE}
        WHERE host_id=$1 AND created_by=$2 AND create_idempotency_key=$3
        LIMIT 1
      `,
      [host.id, actor_account_id, key],
    );
    if (existingByKey.rows[0]) {
      run = mapRun(existingByKey.rows[0]);
      await db.query("COMMIT");
      transactionOpen = false;
      return {
        run,
        token:
          `${existingByKey.rows[0].token_idempotency_key ?? ""}`.startsWith(
            STABLE_TOKEN_MARKER,
          )
            ? token
            : deterministicToken({
                run_id: run.run_id,
                idempotency_key: key,
              }),
      };
    }
    const active = await db.query(
      `
        SELECT run_id
        FROM ${RUN_TABLE}
        WHERE host_id=$1 AND status <> 'stopped'
        LIMIT 1
        FOR UPDATE
      `,
      [host.id],
    );
    if (active.rows[0]) {
      throw new Error("another exam run is still active on this host");
    }
    // The configuration may have been saved while the RootFS was cached.
    const configured = (
      await db.query(
        `SELECT generation, token_ciphertext FROM ${CONFIG_TABLE} WHERE host_id=$1`,
        [host.id],
      )
    ).rows[0];
    if (
      Number(configured?.generation) !== config.generation ||
      !configured?.token_ciphertext ||
      (await decryptExamToken(host.id, configured.token_ciphertext)) !== token
    ) {
      throw new Error(
        "exam configuration changed while the run was being prepared; prepare the exam again",
      );
    }
    const { rows } = await db.query(
      `
        INSERT INTO ${RUN_TABLE} (
          run_id, host_id, config_generation, status, token_hash,
          create_idempotency_key, token_idempotency_key, rootfs_image,
          rootfs_digest, run_quota, max_projects, terminal_enabled,
          network_mode, cleanup_mode, scheduled_stop_at, stop_host_at_deadline,
          owner_account_id, created_by
        )
        VALUES (
          $1, $2, $3, 'preparing', $4, $5, $6, $7, $8, $9::JSONB,
          $10, $11, 'disabled', $12, $13, $14, $15, $16
        )
        RETURNING *
      `,
      [
        run_id,
        host.id,
        config.generation,
        token_hash,
        key,
        `${STABLE_TOKEN_MARKER}${key}`,
        selected.image,
        selected.digest,
        JSON.stringify(run_quota),
        config.max_projects,
        config.terminal_enabled,
        nextCleanupMode,
        deadline,
        nextCleanupMode === "scheduled" && stop_host_at_deadline !== false,
        ownerAccountId(host),
        actor_account_id,
      ],
    );
    run = mapRun(rows[0]);
    await db.query("COMMIT");
    transactionOpen = false;
  } catch (err) {
    if (transactionOpen) {
      await db.query("ROLLBACK");
    }
    throw err;
  } finally {
    db.release();
  }

  try {
    const runtime = await control.applyExamRun({
      config,
      run,
      token_hash,
    });
    // The run may have been ended while the host was preparing it.
    run = await updateRunFromRuntime({ run_id, runtime, keep_stopped: true });
  } catch (err) {
    let runtime: HostExamRuntimeStatus | undefined;
    let inspectedRuntime = false;
    try {
      runtime = await control.getExamRunStatus({});
      inspectedRuntime = true;
    } catch (statusErr) {
      logger.warn("unable to inspect exam runtime after apply failure", {
        host_id: host.id,
        run_id,
        err: `${statusErr}`,
      });
    }
    const rejectedBeforeActivation =
      inspectedRuntime && runtime?.run_id !== run_id;
    await getPool().query(
      `
        UPDATE ${RUN_TABLE}
        SET status=$2,
            admission_closed_at=CASE WHEN $2='stopped' THEN COALESCE(admission_closed_at, NOW()) ELSE admission_closed_at END,
            cleanup_started_at=CASE WHEN $2='stopped' THEN COALESCE(cleanup_started_at, NOW()) ELSE cleanup_started_at END,
            cleaned_at=CASE WHEN $2='stopped' THEN COALESCE(cleaned_at, NOW()) ELSE cleaned_at END,
            stopped_at=CASE WHEN $2='stopped' THEN COALESCE(stopped_at, NOW()) ELSE stopped_at END,
            last_error=$3,
            updated_at=NOW()
        WHERE run_id=$1 AND status <> 'stopped'
      `,
      [run_id, rejectedBeforeActivation ? "stopped" : "error", `${err}`],
    );
    throw err;
  }
  return { run, token };
}

async function requireRunForMutation({
  host_id,
  run_id,
}: {
  host_id: string;
  run_id: string;
}): Promise<HostExamRun> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT * FROM ${RUN_TABLE} WHERE run_id=$1 AND host_id=$2`,
    [run_id, host_id],
  );
  if (!rows[0]) throw new Error("exam run not found");
  return mapRun(rows[0]);
}

export async function rotateExamTokenLocal({
  host,
  run_id,
  idempotency_key,
  token: requestedToken,
}: {
  host: ExamHostRow;
  run_id: string;
  idempotency_key: string;
  token?: string;
}): Promise<{ run: HostExamRun; token: string }> {
  const run = await requireRunForMutation({ host_id: host.id, run_id });
  if (
    run.status === "closing" ||
    run.status === "cleaning" ||
    run.status === "stopped"
  ) {
    throw new Error("cannot rotate the token after exam cleanup has started");
  }
  const key = validateIdempotencyKey(idempotency_key);
  const token =
    requestedToken == null
      ? deterministicToken({ run_id, idempotency_key: key })
      : normalizeAdmissionToken(requestedToken);
  const token_hash = hashToken(token);
  const control = await getRoutedHostControlClient({
    host_id: host.id,
    timeout: 30_000,
    fresh: true,
  });
  const runtime = await control.rotateExamRunToken({
    run_id,
    config_generation: run.config_generation,
    token_hash,
  });
  if (runtime.last_error) {
    throw new Error(runtime.last_error);
  }
  const token_ciphertext = await encryptSecretStorageValue(
    tokenSecretName(host.id),
    token,
  );
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    const { rows } = await db.query(
      `UPDATE ${RUN_TABLE}
       SET token_hash=$2, token_idempotency_key=$3, updated_at=NOW()
       WHERE run_id=$1
       RETURNING *`,
      [run_id, token_hash, `${STABLE_TOKEN_MARKER}${key}`],
    );
    if (!rows[0]) {
      throw new Error("exam run not found while saving rotated token");
    }
    await db.query(
      `UPDATE ${CONFIG_TABLE}
       SET token_hash=$2, token_ciphertext=$3, updated_at=NOW()
       WHERE host_id=$1`,
      [host.id, token_hash, token_ciphertext],
    );
    await db.query("COMMIT");
    return { run: mapRun(rows[0]), token };
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

export async function openExamRunLocal({
  host,
  run_id,
}: {
  host: ExamHostRow;
  run_id: string;
}): Promise<HostExamRun> {
  const run = await requireRunForMutation({ host_id: host.id, run_id });
  if (
    run.cleanup_mode === "scheduled" &&
    new Date(run.scheduled_stop_at).valueOf() <= Date.now()
  ) {
    throw new Error("the exam deadline has already passed");
  }
  const control = await getRoutedHostControlClient({
    host_id: host.id,
    timeout: 60_000,
    fresh: true,
  });
  const runtime = await control.openExamRun({
    run_id,
    config_generation: run.config_generation,
  });
  return await updateRunFromRuntime({ run_id, runtime });
}

export async function updateExamDeadlineLocal({
  host,
  run_id,
  cleanup_mode,
  scheduled_stop_at,
  stop_host_at_deadline,
}: {
  host: ExamHostRow;
  run_id: string;
  cleanup_mode?: HostExamCleanupMode;
  scheduled_stop_at?: string;
  stop_host_at_deadline?: boolean;
}): Promise<HostExamRun> {
  const [run, config] = await Promise.all([
    requireRunForMutation({ host_id: host.id, run_id }),
    loadConfig(host.id),
  ]);
  if (!config) throw new Error("exam configuration not found");
  if (
    run.status === "closing" ||
    run.status === "cleaning" ||
    run.status === "stopped"
  ) {
    throw new Error("cannot change the deadline after cleanup has started");
  }
  const nextCleanupMode: HostExamCleanupMode =
    cleanup_mode == null
      ? run.cleanup_mode
      : cleanup_mode === "manual"
        ? "manual"
        : "scheduled";
  const deadline =
    nextCleanupMode === "manual"
      ? MANUAL_CLEANUP_DEADLINE
      : validateDeadline(
          `${scheduled_stop_at ?? ""}`,
          config.project_ttl_minutes,
        );
  const control = await getRoutedHostControlClient({
    host_id: host.id,
    timeout: 30_000,
    fresh: true,
  });
  await control.updateExamRunDeadline({
    run_id,
    config_generation: run.config_generation,
    cleanup_mode: nextCleanupMode,
    scheduled_stop_at: deadline,
    stop_host_at_deadline:
      nextCleanupMode === "scheduled" &&
      (stop_host_at_deadline ?? run.stop_host_at_deadline),
  });
  const { rows } = await getPool().query(
    `
      UPDATE ${RUN_TABLE}
      SET cleanup_mode=$2, scheduled_stop_at=$3, stop_host_at_deadline=$4,
          updated_at=NOW()
      WHERE run_id=$1
      RETURNING *
    `,
    [
      run_id,
      nextCleanupMode,
      deadline,
      nextCleanupMode === "scheduled" &&
        (stop_host_at_deadline ?? run.stop_host_at_deadline),
    ],
  );
  return mapRun(rows[0]);
}

export async function increaseExamCapacityLocal({
  host,
  run_id,
  max_projects,
}: {
  host: ExamHostRow;
  run_id: string;
  max_projects: number;
}): Promise<HostExamRun> {
  const run = await requireRunForMutation({ host_id: host.id, run_id });
  if (run.status !== "ready" && run.status !== "open") {
    throw new Error(
      `exam capacity can only increase while the run is ready or open (status=${run.status})`,
    );
  }
  const capacity = requireFiniteRange(max_projects, {
    label: "max_projects",
    min: 1,
    max: 1_000,
    integer: true,
  });
  if (capacity < run.max_projects) {
    throw new Error(
      `exam capacity cannot decrease during a run (current=${run.max_projects})`,
    );
  }
  if (capacity === run.max_projects) return run;
  const control = await getRoutedHostControlClient({
    host_id: host.id,
    timeout: 30_000,
    fresh: true,
  });
  const runtime = await control.increaseExamRunCapacity({
    run_id,
    config_generation: run.config_generation,
    max_projects: capacity,
  });
  const appliedCapacity = runtime.max_projects;
  if (appliedCapacity == null || appliedCapacity < capacity) {
    throw new Error("project host did not apply the requested exam capacity");
  }
  const { rows } = await getPool().query(
    `
      UPDATE ${RUN_TABLE}
      SET max_projects=GREATEST(max_projects, $2), updated_at=NOW()
      WHERE run_id=$1
      RETURNING *
    `,
    [run_id, appliedCapacity],
  );
  if (!rows[0]) throw new Error("exam run not found");
  return mapRun(rows[0]);
}

export async function stopAndEraseExamRunLocal({
  host,
  run_id,
  poweroff,
}: {
  host: ExamHostRow;
  run_id: string;
  poweroff: boolean;
}): Promise<HostExamRun> {
  const run = await requireRunForMutation({ host_id: host.id, run_id });
  if (run.status === "stopped") return run;
  assertExamHostRunningForCleanup(host);
  await getPool().query(
    `
      UPDATE ${RUN_TABLE}
      SET status='closing',
          admission_closed_at=COALESCE(admission_closed_at, NOW()),
          updated_at=NOW()
      WHERE run_id=$1 AND status <> 'stopped'
    `,
    [run_id],
  );
  const control = await getRoutedHostControlClient({
    host_id: host.id,
    timeout: PROJECT_HOST_RPC_TIMEOUT_MS,
    fresh: true,
  });
  const runtime = await control.closeAndCleanupExamRun({
    run_id,
    config_generation: run.config_generation,
    poweroff,
  });
  return await updateRunFromRuntime({ run_id, runtime });
}

export async function eraseActiveExamRunBeforeHostStopLocal({
  host,
}: {
  host: ExamHostRow;
}): Promise<boolean> {
  const run = await loadCurrentRun(host.id);
  if (!run || run.status === "stopped") return false;
  await stopAndEraseExamRunLocal({
    host,
    run_id: run.run_id,
    poweroff: false,
  });
  return true;
}

function assertExamHostRunningForCleanup(host: ExamHostRow): void {
  if (host.status === "running") return;
  const status = `${host.status ?? "unknown"}`;
  throw Object.assign(
    new Error(
      `the exam host must be running so its temporary projects can be erased before stopping (current status: ${status}); start the host and end the exam before stopping or deprovisioning it`,
    ),
    { code: "exam_host_cleanup_requires_running" },
  );
}

export async function reconcileExamDnsOnce(): Promise<void> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `
      SELECT c.*, h.public_url, h.metadata, h.status, h.name
      FROM ${CONFIG_TABLE} c
      JOIN project_hosts h ON h.id=c.host_id
      WHERE c.enabled=TRUE AND h.deleted IS NULL
    `,
  );
  for (const row of rows) {
    try {
      await ensureExamDns({
        host: row as ExamHostRow,
        config: mapConfig(row),
      });
    } catch (err) {
      logger.warn("exam DNS reconciliation failed", {
        host_id: row.host_id,
        hostname: row.hostname,
        err: `${err}`,
      });
    }
  }
}

export async function reconcileDueExamRunsOnce(): Promise<void> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `
      SELECT r.*, h.public_url, h.metadata, h.status AS host_status, h.name,
        -- The host's own cleanup deadline. A host that stops at the deadline
        -- is powered off by its watchdog once this passes, even if its
        -- cleanup failed.
        r.scheduled_stop_at
          + COALESCE(c.cleanup_grace_minutes, 0) * INTERVAL '1 minute'
          <= NOW() AS host_cleanup_deadline_passed
      FROM ${RUN_TABLE} r
      JOIN project_hosts h ON h.id=r.host_id
      LEFT JOIN ${CONFIG_TABLE} c
        ON c.host_id=r.host_id AND c.generation=r.config_generation
      WHERE r.status = ANY($1::TEXT[])
        AND r.cleanup_mode = 'scheduled'
        AND r.scheduled_stop_at <= NOW()
        -- A run waiting for its stopped host has nothing to do until the host
        -- runs again, and must not crowd newly due runs out of this batch.
        AND (h.status = 'running' OR r.last_error IS DISTINCT FROM $2)
      -- A run waiting for a host that still looks running is asked about
      -- again, but only after the runs that are not waiting.
      ORDER BY r.last_error IS NOT DISTINCT FROM $2, r.scheduled_stop_at
      LIMIT 16
    `,
    [ACTIVE_RUN_STATUSES, WAITING_FOR_HOST_STOPPED_AT_DEADLINE],
  );
  for (const row of rows) {
    const lockKey = `project-host-exam-run:${row.run_id}`;
    const db = await getPool().connect();
    let acquired = false;
    try {
      const lock = await db.query(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
        [lockKey],
      );
      acquired = lock.rows[0]?.locked === true;
      if (!acquired) continue;
      const host: ExamHostRow = {
        id: row.host_id,
        name: row.name,
        status: row.host_status,
        public_url: row.public_url,
        metadata: row.metadata,
      };
      const stopHostAtDeadline = row.stop_host_at_deadline !== false;
      await db.query("BEGIN");
      try {
        await db.query(
          `
            UPDATE ${RUN_TABLE}
            SET status='closing',
                admission_closed_at=COALESCE(admission_closed_at, NOW()),
                updated_at=NOW()
            WHERE run_id=$1 AND status <> 'stopped'
          `,
          [row.run_id],
        );
        await db.query("COMMIT");
      } catch (err) {
        await db.query("ROLLBACK");
        throw err;
      }
      let hostUnavailable = host.status !== "running";
      if (stopHostAtDeadline && !hostUnavailable) {
        try {
          const control = await getRoutedHostControlClient({
            host_id: host.id,
            timeout: 15_000,
            fresh: true,
          });
          await control.getExamRunStatus({ run_id: row.run_id });
        } catch (err) {
          hostUnavailable = true;
          logger.warn("unable to load exam run status at its deadline", {
            host_id: row.host_id,
            run_id: row.run_id,
            err: `${err}`,
          });
        }
      }
      // The host erases the projects and powers itself off at the deadline
      // without the hub, so its absence is expected rather than a failure.
      // A host that still looks running but does not answer is waited for
      // only until its own cleanup deadline. After that the cleanup below
      // runs, and reports a failure if the host still does not answer.
      const hostAbsenceExpected =
        host.status !== "running" || row.host_cleanup_deadline_passed !== true;
      if (hostUnavailable && stopHostAtDeadline && hostAbsenceExpected) {
        await getPool().query(
          `
            UPDATE ${RUN_TABLE}
            SET status='closing', last_error=$2, updated_at=NOW()
            WHERE run_id=$1 AND status <> 'stopped'
          `,
          [row.run_id, WAITING_FOR_HOST_STOPPED_AT_DEADLINE],
        );
        continue;
      }
      await stopAndEraseExamRunLocal({
        host,
        run_id: row.run_id,
        poweroff: stopHostAtDeadline,
      });
      if (stopHostAtDeadline) {
        const { stopHostInternal } =
          await import("@cocalc/server/conat/api/hosts");
        await stopHostInternal({
          id: row.host_id,
          account_id: row.owner_account_id,
        });
      }
    } catch (err) {
      logger.error("scheduled exam cleanup failed", {
        host_id: row.host_id,
        run_id: row.run_id,
        err: `${err}`,
      });
      await getPool().query(
        `
          UPDATE ${RUN_TABLE}
          SET status='error', last_error=$2, updated_at=NOW()
          WHERE run_id=$1 AND status <> 'stopped'
        `,
        [row.run_id, `${err}`],
      );
      void adminAlert({
        subject: `Exam cleanup failed on ${row.name ?? row.host_id}`,
        body: `Run ${row.run_id} reached its deadline but cleanup${row.stop_host_at_deadline !== false ? " or host stop" : ""} failed:\n\n${err}`,
        dedupMinutes: 15,
      });
    } finally {
      if (acquired) {
        await db
          .query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey])
          .catch((err) => {
            logger.warn("unable to release exam reconciliation lock", {
              run_id: row.run_id,
              err: `${err}`,
            });
          });
      }
      db.release();
    }
  }
}

let maintenanceStarted = false;

export function startExamHostMaintenance(): void {
  if (maintenanceStarted) return;
  maintenanceStarted = true;
  const run = async () => {
    await reconcileExamDnsOnce();
    await reconcileDueExamRunsOnce();
  };
  void run().catch((err) => {
    logger.error("initial exam host maintenance failed", { err: `${err}` });
  });
  const timer = setInterval(() => {
    void run().catch((err) => {
      logger.error("exam host maintenance failed", { err: `${err}` });
    });
  }, 30_000);
  timer.unref?.();
}

export const __test__ = {
  DEFAULT_EXAM_CONFIG,
  ensureSchema,
  examHostnameForHost,
  examDnsRoute,
  ensureExamPublicIngress,
  ensureExamRootfsCached,
  hashToken,
  normalizeAdmissionToken,
  normalizeConfig,
  publicIp,
  assertExamHostRunningForCleanup,
  shouldReconcileRunWithRuntime,
  tokenForRunRecord,
  validateDeadline,
};
