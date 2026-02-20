/*
Smoke test for project-host data persistence.

How to run:
- Call runProjectHostPersistenceSmokeTest(...) from a server-side script or
  REPL with a real account_id and host create/update specs. Example:

  const { create } = await buildSmokeCreateSpecFromHost({
    host_id: "<existing-host-id>",
  });
  await runProjectHostPersistenceSmokeTest({
    account_id,
    create,
    update: { machine_type: "<new-type>" },
  });

- Or run against an existing (not-started) host directly:

  await runProjectHostPersistenceSmokeTestForHostId({
    host_id: "<existing-host-id>",
    update: { machine_type: "<new-type>" },
  });

- Or run a preset that creates a new host, exercises it, then cleans up:

  const presets = await listProjectHostSmokePresets({ provider: "gcp" });
  await runProjectHostPersistenceSmokePreset({
    provider: "gcp",
    preset: presets[0]?.id ?? "gcp-cpu",
  });

What it does:
- Creates a host and waits for it to be running.
- Creates and starts a project on that host.
- Writes a sentinel file via the file-server RPC.
- Creates a backup and verifies it becomes visible.
- Stops the host, applies a machine edit, then starts it again.
- Restarts the project and verifies the sentinel file still exists.

Notes:
- This uses real cloud resources and may take several minutes.
- It leaves host/project artifacts on failure for manual inspection.

DEVEL:

export HOST=localhost
export PORT=9001
export MASTER_CONAT_SERVER=https://dev.cocalc.ai
export DEBUG=cocalc:*
export DEBUG_CONSOLE=yes
node



a = require('../../dist/cloud/smoke-runner/project-host');  await a.listProjectHostSmokePresets({ provider: "gcp" });


a = require('../../dist/cloud/smoke-runner/project-host');  await a.runProjectHostPersistenceSmokePreset({ provider: "gcp"});

// Operator-friendly GCP flow (e2-standard-2 in us-west1), leaves resources by default:
// a = require('../../dist/cloud/smoke-runner/project-host');
// await a.runProjectHostGcpFlowSmoke({});




a = require('../../dist/cloud/smoke-runner/project-host'); await a.runProjectHostPersistenceSmokeTestForHostId({host_id:'a8ed241c-1283-4ced-a874-7af630de0897', update:{'machine_type':'n2-standard-4'}})

a = require('../../dist/cloud/smoke-runner/project-host'); await a.runProjectHostPersistenceSmokeTestForHostId({host_id:'f855962b-c50e-4bb4-9da1-84c0dfbd96f4', update:{'machine_type':'8vcpu-32gb'}})

a = require('../../dist/cloud/smoke-runner/project-host'); await a.runProjectHostPersistenceSmokeTestForHostId({host_id:'f855962b-c50e-4bb4-9da1-84c0dfbd96f4', update:{'machine_type':'4vcpu-16gb'}})

a = require('../../dist/cloud/smoke-runner/project-host'); await a.runProjectHostPersistenceSmokeTestForHostId({host_id:'2cb0a79f-387e-4e6b-a0a7-a8b96738538d', update:{'machine_type':'n1-cpu-large'}})

a = require('../../dist/cloud/smoke-runner/project-host'); await a.runProjectHostPersistenceSmokeTestForHostId({host_id:'2cb0a79f-387e-4e6b-a0a7-a8b96738538d', update:{'machine_type':'n1-cpu-medium'}})


*/
import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import {
  createProject,
  exec as execProject,
  start as startProject,
} from "@cocalc/server/conat/api/projects";
import {
  createBackup as createProjectBackup,
  getBackups as getProjectBackups,
} from "@cocalc/server/conat/api/project-backups";
import { fsClient, fsSubject } from "@cocalc/conat/files/fs";
import { terminalClient } from "@cocalc/conat/project/terminal";
import {
  createHost,
  deleteHostInternal,
  issueProjectHostAuthToken,
  startHost,
  stopHostInternal,
  updateHostMachine,
} from "@cocalc/server/conat/api/hosts";
import { conatWithProjectRouting } from "@cocalc/server/conat/route-client";
import { materializeProjectHost } from "@cocalc/server/conat/route-project";
import deleteProject from "@cocalc/server/projects/delete";
import { normalizeProviderId, type ProviderId } from "@cocalc/cloud";
import { getProviderContext } from "@cocalc/server/cloud/provider-context";
import admins from "@cocalc/server/accounts/admins";
import { getLro } from "@cocalc/server/lro/lro-db";

const logger = getLogger("server:cloud:smoke-runner:project-host");
const execFile = promisify(execFileCb);

type WaitOptions = {
  intervalMs: number;
  attempts: number;
};

type ProjectHostSmokeOptions = {
  account_id: string;
  provider?: ProviderId;
  run_tag?: string;
  create: Parameters<typeof createHost>[0];
  update?: Omit<Parameters<typeof updateHostMachine>[0], "id">;
  restart_after_stop?: boolean;
  wait?: Partial<{
    host_running: Partial<WaitOptions>;
    host_stopped: Partial<WaitOptions>;
    project_ready: Partial<WaitOptions>;
    backup_ready: Partial<WaitOptions>;
  }>;
  cleanup_on_success?: boolean;
  verify_backup?: boolean;
  verify_terminal?: boolean;
  verify_proxy?: boolean;
  verify_provider_status?: boolean;
  proxy_port?: number;
  print_debug_hints?: boolean;
  log?: (event: {
    step: string;
    status: "start" | "ok" | "failed";
    message?: string;
  }) => void;
};

type SmokeCreateSpec = Parameters<typeof createHost>[0];

type SmokePreset = {
  id: string;
  label: string;
  provider: ProviderId;
  create: Omit<SmokeCreateSpec, "account_id">;
  update?: Omit<Parameters<typeof updateHostMachine>[0], "id" | "account_id">;
  wait?: ProjectHostSmokeOptions["wait"];
  restart_after_stop?: boolean;
};

export async function buildSmokeCreateSpecFromHost({
  host_id,
  account_id,
  nameSuffix,
}: {
  account_id?: string;
  host_id: string;
  nameSuffix?: string;
}): Promise<{ create: SmokeCreateSpec }> {
  const { rows } = await getPool().query(
    "SELECT name, region, metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
    [host_id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`host ${host_id} not found`);
  }
  const metadata = row.metadata ?? {};
  const owner = metadata.owner;
  const resolvedAccountId = account_id ?? owner;
  if (!resolvedAccountId) {
    throw new Error("host has no owner; account_id is required");
  }
  if (owner && owner !== resolvedAccountId) {
    throw new Error("host does not belong to account");
  }
  const machine = metadata.machine ?? {};
  const size = metadata.size ?? machine.machine_type ?? "custom";
  const nameBase = row.name || "smoke";
  const suffix = nameSuffix ?? host_id.slice(0, 8);
  return {
    create: {
      account_id: resolvedAccountId,
      name: `${nameBase}-smoke-${suffix}`,
      region: row.region ?? "",
      size,
      gpu: !!metadata.gpu,
      machine,
    },
  };
}

type ProjectHostSmokeResult = {
  ok: boolean;
  host_id?: string;
  project_id?: string;
  debug?: {
    run_tag?: string;
    host_name?: string;
    workspace_title?: string;
    ssh_target?: string;
    ssh_tail_log?: string;
    scp_log?: string;
    host_log_path: string;
    bootstrap_log_path: string;
    host_url?: string;
  };
  steps: Array<{
    name: string;
    status: "ok" | "failed";
    started_at: string;
    finished_at: string;
    error?: string;
  }>;
};

const DEFAULT_HOST_RUNNING: WaitOptions = { intervalMs: 5000, attempts: 180 };
const DEFAULT_HOST_STOPPED: WaitOptions = { intervalMs: 5000, attempts: 120 };
const DEFAULT_PROJECT_READY: WaitOptions = { intervalMs: 3000, attempts: 60 };
const DEFAULT_BACKUP_READY: WaitOptions = { intervalMs: 5000, attempts: 180 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type CliContext = {
  nodePath: string;
  cliPath: string;
  apiUrl: string;
  hubPassword?: string;
  accountId?: string;
  timeoutMs: number;
  pollMs: number;
};

type CliEnvelope<T = any> = {
  ok?: boolean;
  data?: T;
  meta?: {
    account_id?: string;
  };
  error?: {
    code?: string;
    message?: string;
  };
};

type RunCliOptions = {
  timeoutSeconds?: number;
  pollMs?: number;
  commandTimeoutMs?: number;
};

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runCommand(
  command: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFile(command, args, {
      timeout: opts.timeoutMs,
      cwd: opts.cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      stdout: `${stdout ?? ""}`.trim(),
      stderr: `${stderr ?? ""}`.trim(),
    };
  } catch (err: any) {
    const stderr = `${err?.stderr ?? ""}`.trim();
    const stdout = `${err?.stdout ?? ""}`.trim();
    const parts = [
      `${command} ${args.join(" ")}`.trim(),
      err?.message ? `message=${err.message}` : undefined,
      stdout ? `stdout=${stdout}` : undefined,
      stderr ? `stderr=${stderr}` : undefined,
    ].filter(Boolean);
    throw new Error(parts.join(" | "));
  }
}

function normalizeApiUrl(raw: string): string {
  const value = raw.trim();
  if (!value) {
    throw new Error("empty api url");
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value.replace(/\/+$/, "");
  }
  return `http://${value.replace(/\/+$/, "")}`;
}

function resolveApiUrl(pathHint?: string): string {
  const explicit =
    pathHint?.trim() || process.env.COCALC_API_URL || process.env.BASE_URL;
  if (explicit) {
    return normalizeApiUrl(explicit);
  }
  const port = process.env.PORT || "9100";
  return `http://127.0.0.1:${port}`;
}

function resolveHubPassword(pathHint?: string): string | undefined {
  const candidates = [
    pathHint,
    process.env.COCALC_HUB_PASSWORD,
    process.env.SECRETS ? join(process.env.SECRETS, "conat-password") : undefined,
    join(process.cwd(), "src", "data", "app", "postgres", "secrets", "conat-password"),
    join(process.cwd(), "data", "app", "postgres", "secrets", "conat-password"),
  ].filter((x): x is string => !!x && !!x.trim());

  const first = candidates[0]?.trim();
  for (const value of candidates) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (existsSync(trimmed)) {
      return trimmed;
    }
    if (!trimmed.includes("/") && !trimmed.includes("\\")) {
      return trimmed;
    }
  }
  return first;
}

function resolveCliPath(pathHint?: string): string {
  const candidates = [
    pathHint,
    process.env.COCALC_CLI_PATH,
    join(process.cwd(), "src", "packages", "cli", "dist", "bin", "cocalc.js"),
    join(process.cwd(), "packages", "cli", "dist", "bin", "cocalc.js"),
    resolve(__dirname, "../../../../cli/dist/bin/cocalc.js"),
  ].filter((x): x is string => !!x && !!x.trim());

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `unable to find cocalc CLI binary; looked in: ${candidates.join(", ")}`,
  );
}

function commandTimeoutMs(cli: CliContext): number {
  return Math.max(cli.timeoutMs + 30_000, 120_000);
}

function parseCliEnvelope<T>(
  stdout: string,
  stderr: string,
  command: string,
): CliEnvelope<T> {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(
      `empty CLI output for '${command}'${stderr ? ` (stderr: ${stderr})` : ""}`,
    );
  }
  try {
    return JSON.parse(trimmed) as CliEnvelope<T>;
  } catch (err) {
    throw new Error(
      `invalid CLI JSON for '${command}': ${getErrorMessage(err)}${stderr ? ` (stderr: ${stderr})` : ""}`,
    );
  }
}

async function runCli<T>(
  cli: CliContext,
  args: string[],
  options: RunCliOptions = {},
): Promise<T> {
  const timeoutSeconds = Math.max(
    1,
    options.timeoutSeconds ?? Math.ceil(cli.timeoutMs / 1000),
  );
  const pollMs = Math.max(50, options.pollMs ?? cli.pollMs);
  const fullArgs = [
    cli.cliPath,
    "--json",
    "--no-daemon",
    "--api",
    cli.apiUrl,
    "--timeout",
    `${timeoutSeconds}s`,
    "--rpc-timeout",
    `${Math.max(30, Math.min(timeoutSeconds, 300))}s`,
    "--poll-ms",
    `${pollMs}ms`,
  ];

  if (cli.accountId) {
    fullArgs.push("--account-id", cli.accountId);
  }
  if (cli.hubPassword) {
    fullArgs.push("--hub-password", cli.hubPassword);
  }
  fullArgs.push(...args);

  const cmd = `cocalc ${args.join(" ")}`;
  const computedCommandTimeoutMs =
    options.commandTimeoutMs ??
    (options.timeoutSeconds != null
      ? Math.max((timeoutSeconds + 30) * 1000, 120_000)
      : commandTimeoutMs(cli));
  const { stdout, stderr } = await runCommand(cli.nodePath, fullArgs, {
    timeoutMs: computedCommandTimeoutMs,
  });
  const envelope = parseCliEnvelope<T>(stdout, stderr, cmd);
  const responseAccountId = envelope.meta?.account_id;
  if (
    !cli.accountId &&
    typeof responseAccountId === "string" &&
    responseAccountId.trim()
  ) {
    cli.accountId = responseAccountId;
  }
  if (!envelope.ok) {
    throw new Error(
      envelope.error?.message ||
        `command failed (${cmd})${envelope.error?.code ? ` [${envelope.error.code}]` : ""}`,
    );
  }
  return envelope.data as T;
}

async function resolveSmokeAccountId(account_id?: string): Promise<string> {
  if (account_id) return account_id;
  const ids = await admins();
  if (!ids.length) {
    throw new Error(
      "no admin account found; pass account_id explicitly or create an admin user",
    );
  }
  return ids[0];
}

function resolveWait(
  overrides: Partial<WaitOptions> | undefined,
  fallback: WaitOptions,
): WaitOptions {
  return {
    intervalMs: overrides?.intervalMs ?? fallback.intervalMs,
    attempts: overrides?.attempts ?? fallback.attempts,
  };
}

function sanitizeRunTag(raw?: string): string | undefined {
  const value = `${raw ?? ""}`.trim().toLowerCase();
  if (!value) return undefined;
  const cleaned = value.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  const trimmed = cleaned.replace(/^-+|-+$/g, "");
  return trimmed ? trimmed.slice(0, 40) : undefined;
}

function withRunTagSuffix(base: string, runTag?: string): string {
  if (!runTag) return base;
  const suffix = sanitizeRunTag(runTag);
  if (!suffix) return base;
  const maxLen = 63;
  const baseClean = `${base}`.trim().replace(/[^A-Za-z0-9-]/g, "-");
  const room = Math.max(1, maxLen - suffix.length - 1);
  const head = baseClean.slice(0, room).replace(/-+$/g, "");
  return `${head}-${suffix}`;
}

type CliHostRow = {
  host_id?: string;
  name?: string;
  status?: string;
};

type CliWorkspaceRow = {
  workspace_id?: string;
  title?: string;
  host_id?: string | null;
  last_edited?: string | null;
};

async function findHostByNameViaCli(
  cli: CliContext,
  name: string,
): Promise<string | undefined> {
  const hosts = await runCli<CliHostRow[]>(cli, [
    "host",
    "list",
    "--limit",
    "5000",
  ]);
  const match = hosts.find((h) => `${h?.name ?? ""}`.trim() === name);
  const id = `${match?.host_id ?? ""}`.trim();
  return id || undefined;
}

async function findWorkspaceByTitleViaCli({
  cli,
  title,
  host_id,
}: {
  cli: CliContext;
  title: string;
  host_id?: string;
}): Promise<string | undefined> {
  const args = ["workspace", "list", "--prefix", title, "--limit", "5000"];
  if (host_id) {
    args.push("--host", host_id);
  }
  const rows = await runCli<CliWorkspaceRow[]>(cli, args);
  const exact = rows.filter((row) => `${row?.title ?? ""}`.trim() === title);
  if (!exact.length) return undefined;
  const sorted = [...exact].sort((a, b) =>
    String(b.last_edited ?? "").localeCompare(String(a.last_edited ?? "")),
  );
  const id = `${sorted[0]?.workspace_id ?? ""}`.trim();
  return id || undefined;
}

async function listWorkspaceIdsByTitleViaCli({
  cli,
  title,
  host_id,
}: {
  cli: CliContext;
  title: string;
  host_id?: string;
}): Promise<string[]> {
  const args = ["workspace", "list", "--prefix", title, "--limit", "5000"];
  if (host_id) {
    args.push("--host", host_id);
  }
  const rows = await runCli<CliWorkspaceRow[]>(cli, args);
  const ids = new Set<string>();
  for (const row of rows) {
    if (`${row?.title ?? ""}`.trim() !== title) continue;
    const id = `${row?.workspace_id ?? ""}`.trim();
    if (id) ids.add(id);
  }
  return [...ids];
}

async function listHostIdsByNameViaCli(
  cli: CliContext,
  name: string,
): Promise<string[]> {
  const hosts = await runCli<CliHostRow[]>(cli, [
    "host",
    "list",
    "--limit",
    "5000",
  ]);
  const ids = new Set<string>();
  for (const row of hosts) {
    if (`${row?.name ?? ""}`.trim() !== name) continue;
    const id = `${row?.host_id ?? ""}`.trim();
    if (id) ids.add(id);
  }
  return [...ids];
}

type HostStatusSnapshot = {
  status: string;
  last_action_status?: string | null;
  metadata?: Record<string, any>;
};

function normalizeHostStatusForCheck(status?: string | null): string {
  if (!status) return "unknown";
  if (status === "active") return "running";
  return status;
}

function normalizeProviderStatusForCheck(status?: string | null): string {
  if (status === "stopped") return "off";
  return status ?? "unknown";
}

async function loadHostStatusSnapshot(host_id: string): Promise<HostStatusSnapshot> {
  const { rows } = await getPool().query<{
    status: string | null;
    metadata: Record<string, any> | null;
  }>(
    "SELECT status, metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
    [host_id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("host not found for provider status check");
  }
  return {
    status: row.status ?? "unknown",
    last_action_status: row.metadata?.last_action_status ?? null,
    metadata: row.metadata ?? {},
  };
}

async function checkProviderStatus({
  host_id,
  providerHint,
}: {
  host_id: string;
  providerHint?: ProviderId;
}) {
  const snapshot = await loadHostStatusSnapshot(host_id);
  if (snapshot.last_action_status === "pending") {
    logger.debug("smoke-runner provider status check skipped (pending)", {
      host_id,
    });
    return;
  }
  const normalizedStatus = normalizeHostStatusForCheck(snapshot.status);
  if (["starting", "stopping", "restarting"].includes(normalizedStatus)) {
    logger.debug("smoke-runner provider status check skipped (transition)", {
      host_id,
      status: normalizedStatus,
    });
    return;
  }
  const runtime = snapshot.metadata?.runtime ?? {};
  if (!runtime?.instance_id) {
    logger.debug("smoke-runner provider status check skipped (no instance)", {
      host_id,
      status: normalizedStatus,
    });
    return;
  }
  const providerId =
    providerHint ?? normalizeProviderId(snapshot.metadata?.machine?.cloud);
  if (!providerId) {
    logger.debug("smoke-runner provider status check skipped (no provider)", {
      host_id,
    });
    return;
  }
  const { entry, creds } = await getProviderContext(providerId, {
    region: (snapshot as any)?.region,
  });
  if (!entry.provider.getStatus) {
    logger.debug("smoke-runner provider status check skipped (no getStatus)", {
      host_id,
      provider: providerId,
    });
    return;
  }
  const providerStatus = await entry.provider.getStatus(runtime, creds);
  const normalizedProvider = normalizeProviderStatusForCheck(providerStatus);
  const normalizedHost = normalizeHostStatusForCheck(snapshot.status);
  if (
    normalizedHost !== "unknown" &&
    normalizedProvider !== normalizedHost
  ) {
    throw new Error(
      `provider status mismatch: host=${normalizedHost} provider=${normalizedProvider}`,
    );
  }
}

async function waitForHostStatus(
  host_id: string,
  target: string[],
  opts: WaitOptions,
) {
  for (let attempt = 1; attempt <= opts.attempts; attempt += 1) {
    const { rows } = await getPool().query<{
      status: string | null;
    }>("SELECT status FROM project_hosts WHERE id=$1 AND deleted IS NULL", [
      host_id,
    ]);
    const status = rows[0]?.status ?? "";
    if (target.includes(status)) {
      return status;
    }
    if (status === "error") {
      throw new Error("host status became error");
    }
    await sleep(opts.intervalMs);
  }
  throw new Error(`timeout waiting for host status ${target.join(",")}`);
}

async function waitForHostSeen(
  host_id: string,
  opts: WaitOptions,
  since?: Date,
) {
  for (let attempt = 1; attempt <= opts.attempts; attempt += 1) {
    const { rows } = await getPool().query<{
      last_seen: Date | null;
    }>("SELECT last_seen FROM project_hosts WHERE id=$1 AND deleted IS NULL", [
      host_id,
    ]);
    const lastSeen = rows[0]?.last_seen ?? null;
    if (lastSeen && (!since || lastSeen >= since)) {
      return lastSeen;
    }
    await sleep(opts.intervalMs);
  }
  throw new Error("timeout waiting for host to report last_seen");
}

async function waitForProjectFile(
  clientFactory: () => ReturnType<typeof conatWithProjectRouting>,
  project_id: string,
  path: string,
  expected: string,
  opts: WaitOptions,
) {
  await waitForProjectRouting(project_id, opts);
  const client = fsClient({
    client: clientFactory(),
    subject: fsSubject({ project_id }),
  });
  for (let attempt = 1; attempt <= opts.attempts; attempt += 1) {
    try {
      const contents = await client.readFile(path, "utf8");
      if (contents === expected) {
        return;
      }
    } catch (err) {
      logger.debug("smoke-runner readFile retry", {
        project_id,
        path,
        err: `${err}`,
        attempt,
      });
      if (String(err).includes("no subscribers matching")) {
        await sleep(Math.min(2000, opts.intervalMs));
        continue;
      }
    }
    await sleep(opts.intervalMs);
  }
  throw new Error("timeout waiting for project file");
}

async function waitForProjectRouting(project_id: string, opts: WaitOptions) {
  for (let attempt = 1; attempt <= opts.attempts; attempt += 1) {
    try {
      const address = await materializeProjectHost(project_id);
      if (address) {
        return address;
      }
    } catch (err) {
      logger.debug("smoke-runner routing retry", {
        project_id,
        err: `${err}`,
        attempt,
      });
    }
    await sleep(opts.intervalMs);
  }
  throw new Error("timeout waiting for project routing");
}

async function waitForLroTerminal(op_id: string, opts: WaitOptions) {
  let lastStatus = "missing";
  for (let attempt = 1; attempt <= opts.attempts; attempt += 1) {
    const op = await getLro(op_id);
    const status = `${op?.status ?? "missing"}`;
    lastStatus = status;
    if (status === "succeeded" || status === "failed" || status === "canceled") {
      return op;
    }
    await sleep(opts.intervalMs);
  }
  throw new Error(
    `timeout waiting for operation ${op_id} to finish (last_status=${lastStatus})`,
  );
}

function normalizeBackupTime(value: unknown): number {
  if (!value) return 0;
  if (value instanceof Date) return value.valueOf();
  const parsed = new Date(String(value));
  const ms = parsed.valueOf();
  return Number.isFinite(ms) ? ms : 0;
}

async function waitForBackupVisible({
  account_id,
  project_id,
  opts,
}: {
  account_id: string;
  project_id: string;
  opts: WaitOptions;
}): Promise<{ backup_id: string; indexed: boolean }> {
  let lastIndexedCount = 0;
  let lastAnyCount = 0;
  for (let attempt = 1; attempt <= opts.attempts; attempt += 1) {
    try {
      const indexed = await getProjectBackups({
        account_id,
        project_id,
        indexed_only: true,
      });
      lastIndexedCount = indexed.length;
      if (indexed.length > 0) {
        const sorted = [...indexed].sort(
          (a, b) => normalizeBackupTime(b?.time) - normalizeBackupTime(a?.time),
        );
        const backup_id = `${sorted[0]?.id ?? ""}`.trim();
        if (backup_id) {
          return { backup_id, indexed: true };
        }
      }
    } catch (err) {
      logger.debug("smoke-runner indexed backup list retry", {
        project_id,
        attempt,
        err: `${err}`,
      });
    }

    try {
      const backups = await getProjectBackups({
        account_id,
        project_id,
        indexed_only: false,
      });
      lastAnyCount = backups.length;
      if (backups.length > 0) {
        const sorted = [...backups].sort(
          (a, b) => normalizeBackupTime(b?.time) - normalizeBackupTime(a?.time),
        );
        const backup_id = `${sorted[0]?.id ?? ""}`.trim();
        if (backup_id) {
          return { backup_id, indexed: false };
        }
      }
    } catch (err) {
      logger.debug("smoke-runner backup list retry", {
        project_id,
        attempt,
        err: `${err}`,
      });
    }

    await sleep(opts.intervalMs);
  }
  throw new Error(
    `backup never became visible (indexed_backups=${lastIndexedCount}, total_backups=${lastAnyCount})`,
  );
}

async function waitForHostStatusViaCli({
  cli,
  host_id,
  allowed,
  wait,
}: {
  cli: CliContext;
  host_id: string;
  allowed: string[];
  wait: WaitOptions;
}): Promise<void> {
  let lastStatus = "unknown";
  for (let attempt = 1; attempt <= wait.attempts; attempt += 1) {
    try {
      const host = await runCli<{ status?: string }>(cli, ["host", "get", host_id]);
      const status = String(host?.status ?? "unknown");
      lastStatus = status;
      if (allowed.includes(status)) {
        return;
      }
      if (status === "error") {
        throw new Error("host status became error");
      }
    } catch (err) {
      logger.debug("cloud smoke host status retry", {
        host_id,
        attempt,
        err: getErrorMessage(err),
      });
    }
    await sleep(wait.intervalMs);
  }
  throw new Error(
    `timeout waiting for host status (${allowed.join(", ")}); last status=${lastStatus}`,
  );
}

async function waitForBackupIndexedViaCli({
  cli,
  project_id,
  wait,
}: {
  cli: CliContext;
  project_id: string;
  wait: WaitOptions;
}): Promise<{ id: string; indexed: boolean }> {
  let lastIndexedCount = 0;
  let lastAnyCount = 0;
  for (let attempt = 1; attempt <= wait.attempts; attempt += 1) {
    const indexedBackups = await runCli<
      Array<{ backup_id?: string; time?: string | Date | null }>
    >(cli, [
      "workspace",
      "backup",
      "list",
      "--workspace",
      project_id,
      "--indexed-only",
      "--limit",
      "100",
    ]);
    lastIndexedCount = indexedBackups.length;
    if (indexedBackups.length > 0 && indexedBackups[0]?.backup_id) {
      const sorted = [...indexedBackups].sort(
        (a, b) =>
          String(b?.time ?? "").localeCompare(String(a?.time ?? "")) ||
          String(a?.backup_id ?? "").localeCompare(String(b?.backup_id ?? "")),
      );
      return { id: String(sorted[0].backup_id), indexed: true };
    }

    const backups = await runCli<
      Array<{ backup_id?: string; time?: string | Date | null }>
    >(cli, ["workspace", "backup", "list", "--workspace", project_id, "--limit", "100"]);
    lastAnyCount = backups.length;
    if (backups.length > 0 && backups[0]?.backup_id) {
      const sorted = [...backups].sort(
        (a, b) =>
          String(b?.time ?? "").localeCompare(String(a?.time ?? "")) ||
          String(a?.backup_id ?? "").localeCompare(String(b?.backup_id ?? "")),
      );
      return { id: String(sorted[0].backup_id), indexed: false };
    }

    await sleep(wait.intervalMs);
  }
  throw new Error(
    `backup never appeared (indexed backups=${lastIndexedCount}, total backups=${lastAnyCount})`,
  );
}

async function waitForProjectFileValueViaCli({
  cli,
  project_id,
  path,
  expected,
  wait,
}: {
  cli: CliContext;
  project_id: string;
  path: string;
  expected: string;
  wait: WaitOptions;
}): Promise<void> {
  for (let attempt = 1; attempt <= wait.attempts; attempt += 1) {
    try {
      const out = await runCli<{ content?: string }>(
        cli,
        ["workspace", "file", "cat", "--workspace", project_id, path],
        { timeoutSeconds: 45, commandTimeoutMs: 120_000 },
      );
      const value = String(out?.content ?? "").replace(/\r?\n$/, "");
      if (value === expected) return;
    } catch (err) {
      logger.debug("cloud smoke project file retry", {
        project_id,
        path,
        attempt,
        err: getErrorMessage(err),
      });
    }
    await sleep(wait.intervalMs);
  }
  throw new Error(`timeout waiting for workspace file '${path}'`);
}

async function runWorkspaceExecSmokeViaCli({
  cli,
  project_id,
  wait,
}: {
  cli: CliContext;
  project_id: string;
  wait: WaitOptions;
}): Promise<void> {
  const marker = `cocalc_smoke_exec_${Date.now()}`;
  for (let attempt = 1; attempt <= wait.attempts; attempt += 1) {
    try {
      const out = await runCli<{
        stdout?: string;
        stderr?: string;
        exit_code?: number;
      }>(
        cli,
        [
          "workspace",
          "exec",
          "--workspace",
          project_id,
          "--timeout",
          "45",
          "--bash",
          `echo ${marker}`,
        ],
        { timeoutSeconds: 90, commandTimeoutMs: 180_000 },
      );
      const stdout = `${out?.stdout ?? ""}`;
      const exitCode = Number(out?.exit_code ?? 0);
      if (exitCode === 0 && stdout.includes(marker)) {
        return;
      }
      throw new Error(
        `workspace exec unexpected result (exit_code=${exitCode}, stdout='${stdout.trim()}')`,
      );
    } catch (err) {
      logger.debug("cloud smoke workspace exec retry", {
        project_id,
        attempt,
        err: getErrorMessage(err),
      });
      await sleep(wait.intervalMs);
    }
  }
  throw new Error("timeout waiting for workspace exec marker");
}

function buildHostCreateCliArgs({
  provider,
  create,
}: {
  provider: ProviderId;
  create: SmokeCreateSpec;
}): string[] {
  const region = `${create.region ?? ""}`.trim();
  const size = `${create.size ?? ""}`.trim();
  if (!region) {
    throw new Error("smoke preset create spec missing region");
  }
  if (!size) {
    throw new Error("smoke preset create spec missing size");
  }
  const args = [
    "host",
    "create",
    `${create.name}`,
    "--provider",
    provider,
    "--region",
    region,
    "--size",
    size,
  ];
  if (create.gpu) {
    args.push("--gpu");
  }
  const machine = { ...(create.machine ?? {}) } as Record<string, any>;
  const machineType = `${machine.machine_type ?? ""}`.trim();
  if (machineType) {
    args.push("--machine-type", machineType);
  }
  const zone = `${machine.zone ?? ""}`.trim();
  if (zone) {
    args.push("--zone", zone);
  }
  const diskGbRaw = Number(machine.disk_gb);
  if (Number.isFinite(diskGbRaw) && diskGbRaw > 0) {
    args.push("--disk-gb", `${Math.floor(diskGbRaw)}`);
  }
  const diskType = `${machine.disk_type ?? ""}`.trim();
  if (diskType) {
    args.push("--disk-type", diskType);
  }
  const storageMode = `${machine.storage_mode ?? ""}`.trim();
  if (storageMode) {
    args.push("--storage-mode", storageMode);
  }

  delete machine.cloud;
  delete machine.machine_type;
  delete machine.zone;
  delete machine.disk_gb;
  delete machine.disk_type;
  delete machine.storage_mode;
  const machineJson = JSON.stringify(machine);
  if (machineJson !== "{}") {
    args.push("--machine-json", machineJson);
  }
  args.push("--wait");
  return args;
}

type HostConnectionHints = {
  host_id: string;
  host_url?: string;
  ssh_target?: string;
  public_ip?: string;
  ssh_user?: string;
  host_log_path: string;
  bootstrap_log_path: string;
  ssh_tail_log?: string;
  scp_log?: string;
};

function normalizeUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const trimmed = `${url}`.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed.replace(/\/+$/, "");
  }
  return `http://${trimmed.replace(/\/+$/, "")}`;
}

async function loadHostConnectionHints(
  host_id: string,
): Promise<HostConnectionHints> {
  const { rows } = await getPool().query<{
    public_url: string | null;
    internal_url: string | null;
    metadata: Record<string, any> | null;
  }>(
    "SELECT public_url, internal_url, metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
    [host_id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`host ${host_id} not found`);
  }
  const metadata = row.metadata ?? {};
  const runtime = metadata.runtime ?? {};
  const machine = metadata.machine ?? {};
  const public_ip = runtime.public_ip ?? machine.metadata?.public_ip;
  const ssh_user =
    runtime.ssh_user ?? machine.metadata?.ssh_user ?? "ubuntu";
  const bootstrap_log_path =
    ssh_user === "root"
      ? "/root/cocalc-host/bootstrap/bootstrap.log"
      : `/home/${ssh_user}/cocalc-host/bootstrap/bootstrap.log`;
  const ssh_target =
    public_ip && ssh_user ? `${ssh_user}@${public_ip}` : undefined;
  const host_url =
    normalizeUrl(row.public_url ?? undefined) ??
    normalizeUrl(row.internal_url ?? undefined) ??
    (public_ip ? `http://${public_ip}` : undefined);
  return {
    host_id,
    host_url,
    ssh_target,
    public_ip,
    ssh_user,
    host_log_path: "/mnt/cocalc/data/log",
    bootstrap_log_path,
    ssh_tail_log: ssh_target
      ? `ssh ${ssh_target} 'tail -n 300 /mnt/cocalc/data/log'`
      : undefined,
    scp_log: ssh_target
      ? `scp ${ssh_target}:/mnt/cocalc/data/log ./host.log`
      : undefined,
  };
}

function parseCookie(setCookie: string | null, cookieName: string): string | undefined {
  if (!setCookie) return undefined;
  const escaped = cookieName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}=([^;]+)`);
  const match = setCookie.match(re);
  if (!match?.[1]) return undefined;
  return `${cookieName}=${match[1]}`;
}

async function fetchWithTimeout(
  input: string,
  opts: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 10000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { timeoutMs: _ignore, signal, ...rest } = opts;
    return await fetch(input, {
      ...rest,
      signal: signal ?? controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function waitForCondition(
  fn: () => Promise<void>,
  opts: WaitOptions,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt += 1) {
    try {
      await fn();
      return;
    } catch (err) {
      lastErr = err;
      await sleep(opts.intervalMs);
    }
  }
  throw lastErr ?? new Error("condition wait failed");
}

function narrowProxyWait(wait: WaitOptions): WaitOptions {
  return {
    // Proxy smoke should fail fast enough for CI/smoke loops.
    intervalMs: Math.max(1000, Math.min(wait.intervalMs, 2000)),
    attempts: Math.max(4, Math.min(wait.attempts, 6)),
  };
}

async function runTerminalSmoke({
  project_id,
  clientFactory,
  wait,
}: {
  project_id: string;
  clientFactory: () => ReturnType<typeof conatWithProjectRouting>;
  wait: WaitOptions;
}) {
  const marker = `cocalc_smoke_terminal_${Date.now()}`;
  const termId = `.smoke/smoke-terminal-${Date.now()}.term`;
  const term = terminalClient({
    project_id,
    client: clientFactory(),
  });
  try {
    await waitForProjectRouting(project_id, wait);
    await term.spawn("bash", ["-lc", `echo ${marker}`], {
      id: termId,
      timeout: 30000,
      rows: 24,
      cols: 80,
    });
    await waitForCondition(async () => {
      const hist = await term.history();
      if (!`${hist ?? ""}`.includes(marker)) {
        throw new Error("terminal marker not yet observed");
      }
    }, wait);
  } finally {
    try {
      await term.destroy();
    } catch {
      // ignore cleanup errors
    }
    term.close();
  }
}

async function runProxySmoke({
  account_id,
  host_id,
  project_id,
  wait,
  proxy_port,
}: {
  account_id: string;
  host_id: string;
  project_id: string;
  wait: WaitOptions;
  proxy_port: number;
}) {
  const proxyWait = narrowProxyWait(wait);
  const hints = await loadHostConnectionHints(host_id);
  if (!hints.host_url) {
    throw new Error("host has no public_url/internal_url/public_ip for proxy check");
  }

  let serverPid: number | undefined;
  const appUrl = `${hints.host_url}/${project_id}/proxy/${proxy_port}/`;
  try {
    await waitForProjectRouting(project_id, wait);
    const started = await execProject({
      account_id,
      project_id,
      execOpts: {
        command: `python3 -m http.server ${proxy_port} --bind 0.0.0.0 || python -m SimpleHTTPServer ${proxy_port}`,
        bash: true,
        timeout: 600,
        err_on_exit: false,
        async_call: true,
      },
    });
    const pid = Number((started as any)?.pid);
    if (Number.isFinite(pid) && pid > 0) {
      serverPid = Math.floor(pid);
    }

    await waitForCondition(async () => {
      const unauth = await fetchWithTimeout(appUrl, {
        redirect: "manual",
        timeoutMs: 8000,
      });
      if (unauth.status < 400 || unauth.status >= 500) {
        throw new Error(`unexpected unauth status ${unauth.status}`);
      }
    }, proxyWait);

    const issued = await issueProjectHostAuthToken({
      account_id,
      host_id,
      project_id,
      ttl_seconds: 300,
    });

    await waitForCondition(async () => {
      const bootstrap = await fetchWithTimeout(
        `${appUrl}?cocalc_project_host_token=${encodeURIComponent(issued.token)}`,
        {
          redirect: "manual",
          timeoutMs: 10000,
        },
      );

      const cookie = parseCookie(
        bootstrap.headers.get("set-cookie"),
        "cocalc_project_host_http_session",
      );
      if (!cookie) {
        throw new Error("missing cocalc_project_host_http_session cookie");
      }
      const location = bootstrap.headers.get("location");
      if (!location) {
        throw new Error("missing redirect location after token bootstrap");
      }
      const targetUrl = new URL(location, appUrl).toString();
      const auth = await fetchWithTimeout(targetUrl, {
        headers: {
          Cookie: cookie,
        },
        timeoutMs: 10000,
      });
      if (auth.status !== 200) {
        throw new Error(`unexpected authorized status ${auth.status}`);
      }
      const body = await auth.text();
      if (
        !body.includes("Directory listing for") &&
        !body.includes("<html") &&
        !body.includes("DOCTYPE")
      ) {
        throw new Error("authorized proxy response did not look like app content");
      }
    }, proxyWait);
  } finally {
    try {
      const killByPid = serverPid
        ? `kill ${serverPid} >/dev/null 2>&1 || true; `
        : "";
      await execProject({
        account_id,
        project_id,
        execOpts: {
          command: `${killByPid}pkill -f 'http.server ${proxy_port}' >/dev/null 2>&1 || true`,
          bash: true,
          timeout: 30,
          err_on_exit: false,
        },
      });
    } catch (err) {
      // ignore cleanup errors
      logger.debug("proxy smoke server cleanup warning", {
        project_id,
        proxy_port,
        serverPid,
        err: getErrorMessage(err),
      });
    }
  }
}

async function runSmokeSteps({
  account_id,
  provider,
  run_tag,
  host_id,
  createSpec,
  hostStatus,
  update,
  restart_after_stop,
  wait,
  cleanup_on_success,
  cleanup_host,
  verify_terminal,
  verify_proxy,
  verify_backup,
  verify_provider_status,
  proxy_port,
  print_debug_hints,
  log,
}: {
  account_id: string;
  provider?: ProviderId;
  run_tag?: string;
  host_id?: string;
  createSpec?: Parameters<typeof createHost>[0];
  hostStatus?: string;
  update?: ProjectHostSmokeOptions["update"];
  restart_after_stop?: boolean;
  wait?: ProjectHostSmokeOptions["wait"];
  cleanup_on_success?: ProjectHostSmokeOptions["cleanup_on_success"];
  cleanup_host?: boolean;
  verify_terminal?: boolean;
  verify_proxy?: boolean;
  verify_backup?: boolean;
  verify_provider_status?: boolean;
  proxy_port?: number;
  print_debug_hints?: boolean;
  log?: ProjectHostSmokeOptions["log"];
}): Promise<ProjectHostSmokeResult> {
  const steps: ProjectHostSmokeResult["steps"] = [];
  const waitHostRunning = resolveWait(wait?.host_running, DEFAULT_HOST_RUNNING);
  const waitHostStopped = resolveWait(wait?.host_stopped, DEFAULT_HOST_STOPPED);
  const waitProjectReady = resolveWait(
    wait?.project_ready,
    DEFAULT_PROJECT_READY,
  );
  const waitBackupReady = resolveWait(wait?.backup_ready, DEFAULT_BACKUP_READY);
  const verifyProviderStatus = verify_provider_status ?? false;
  const strictProviderStatus =
    process.env.COCALC_SMOKE_STRICT_PROVIDER_STATUS === "yes";
  const emit =
    log ??
    ((event) => {
      logger.info("smoke-runner", event);
    });

  const routedClient = conatWithProjectRouting();
  const clientFactory = () => routedClient;
  let project_id: string | undefined;
  const sentinelPath = ".smoke/persist.txt";
  const sentinelValue = `smoke:${Date.now()}`;
  const workspaceTitle = run_tag
    ? `Smoke test ${run_tag}`
    : `Smoke test ${host_id ?? "host"}`;
  const hostName = `${createSpec?.name ?? ""}`.trim() || undefined;
  let hostStartRequestedAt: Date | undefined;
  let createdHost = false;
  let debugHints: HostConnectionHints | undefined;

  const runStep = async (name: string, fn: () => Promise<void>) => {
    const startedAt = new Date();
    emit({ step: name, status: "start" });
    try {
      await fn();
      const finishedAt = new Date();
      steps.push({
        name,
        status: "ok",
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
      });
      emit({ step: name, status: "ok" });
      if (host_id && verifyProviderStatus) {
        try {
          await checkProviderStatus({ host_id, providerHint: provider });
        } catch (err) {
          if (strictProviderStatus) {
            throw err;
          }
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("smoke-runner provider status check skipped", {
            host_id,
            provider,
            step: name,
            err: message,
          });
          emit({
            step: `${name}:provider_status`,
            status: "ok",
            message: `skipped provider status check: ${message}`,
          });
        }
      }
    } catch (err) {
      const finishedAt = new Date();
      const message = err instanceof Error ? err.message : String(err);
      steps.push({
        name,
        status: "failed",
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        error: message,
      });
      emit({ step: name, status: "failed", message });
      throw err;
    }
  };

  try {
    if (!host_id && createSpec) {
      await runStep("create_host", async () => {
        try {
          const host = await createHost({
            ...createSpec,
            account_id,
          });
          host_id = host.id;
          createdHost = true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (
            message.includes("Unsupported state or unable to authenticate data")
          ) {
            throw new Error(
              "failed to decrypt server settings; source local-postgres.env (must include DATA/COCALC_DATA_DIR and secret-settings key path) before running smoke test",
            );
          }
          throw err;
        }
      });
    }

    if (host_id && !createSpec && hostStatus !== "running") {
      await runStep("start_existing_host", async () => {
        if (!host_id) throw new Error("missing host_id");
        await startHost({ account_id, id: host_id });
      });
    }

    await runStep("wait_host_running", async () => {
      if (!host_id) throw new Error("missing host_id");
      await waitForHostStatus(host_id, ["running"], waitHostRunning);
      debugHints = await loadHostConnectionHints(host_id);
      if (print_debug_hints !== false) {
        const parts = [
          `host_id=${host_id}`,
          debugHints.host_url ? `url=${debugHints.host_url}` : undefined,
          debugHints.ssh_target ? `ssh=${debugHints.ssh_target}` : undefined,
          debugHints.ssh_tail_log ? `tail='${debugHints.ssh_tail_log}'` : undefined,
          debugHints.scp_log ? `scp='${debugHints.scp_log}'` : undefined,
        ].filter(Boolean);
        emit({
          step: "debug_hints",
          status: "ok",
          message: parts.join(" "),
        });
      }
    });

    await runStep("create_project", async () => {
      if (!host_id) throw new Error("missing host_id");
      project_id = await createProject({
        account_id,
        title: workspaceTitle,
        host_id,
        start: true,
      });
    });

    await runStep("write_sentinel", async () => {
      if (!project_id) throw new Error("missing project_id");
      await waitForProjectRouting(project_id, waitProjectReady);
      let lastErr: unknown;
      for (
        let attempt = 1;
        attempt <= waitProjectReady.attempts;
        attempt += 1
      ) {
        try {
          const client = fsClient({
            client: clientFactory(),
            subject: fsSubject({ project_id }),
          });
          await client.mkdir(".smoke", { recursive: true });
          await client.writeFile(sentinelPath, sentinelValue);
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          logger.debug("smoke-runner writeFile retry", {
            project_id,
            err: `${err}`,
            attempt,
          });
          if (String(err).includes("no subscribers matching")) {
            await sleep(Math.min(2000, waitProjectReady.intervalMs));
            continue;
          }
          await sleep(waitProjectReady.intervalMs);
        }
      }
      if (lastErr) {
        throw lastErr;
      }
    });

    if ((verify_backup ?? true) && provider !== "lambda") {
      await runStep("create_backup", async () => {
        if (!project_id) throw new Error("missing project_id");
        const op = await createProjectBackup({ account_id, project_id });
        const summary = await waitForLroTerminal(op.op_id, waitBackupReady);
        const status = `${summary?.status ?? "missing"}`;
        if (status !== "succeeded") {
          const err = summary?.error ? ` error=${summary.error}` : "";
          throw new Error(
            `backup operation failed (op_id=${op.op_id}, status=${status}${err})`,
          );
        }
        const backup = await waitForBackupVisible({
          account_id,
          project_id,
          opts: waitBackupReady,
        });
        logger.info("smoke-runner backup verified", {
          project_id,
          backup_id: backup.backup_id,
          indexed: backup.indexed,
        });
      });
    }

    if ((verify_terminal ?? true) && provider !== "lambda") {
      await runStep("terminal_smoke", async () => {
        if (!project_id) throw new Error("missing project_id");
        let lastErr: unknown;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            await runTerminalSmoke({
              project_id,
              clientFactory,
              wait: waitProjectReady,
            });
            lastErr = undefined;
            break;
          } catch (err) {
            lastErr = err;
            logger.warn("smoke-runner terminal retry", {
              project_id,
              attempt,
              err: `${err}`,
            });
            await sleep(waitProjectReady.intervalMs);
          }
        }
        if (lastErr) throw lastErr;
      });
    }

    if ((verify_proxy ?? true) && provider !== "lambda") {
      await runStep("proxy_smoke", async () => {
        if (!project_id) throw new Error("missing project_id");
        if (!host_id) throw new Error("missing host_id");
        let lastErr: unknown;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            await runProxySmoke({
              account_id,
              host_id,
              project_id,
              wait: waitProjectReady,
              proxy_port: proxy_port ?? 33117,
            });
            lastErr = undefined;
            break;
          } catch (err) {
            lastErr = err;
            logger.warn("smoke-runner proxy retry", {
              project_id,
              host_id,
              attempt,
              err: `${err}`,
            });
            await sleep(waitProjectReady.intervalMs);
          }
        }
        if (lastErr) throw lastErr;
      });
    }

    await runStep("stop_host", async () => {
      if (!host_id) throw new Error("missing host_id");
      await stopHostInternal({ account_id, id: host_id });
      await waitForHostStatus(
        host_id,
        ["off", "deprovisioned"],
        waitHostStopped,
      );
    });

    const shouldRestart =
      restart_after_stop ?? (update && Object.keys(update).length > 0);
    if (shouldRestart) {
      if (update && Object.keys(update).length > 0) {
        await runStep("update_host", async () => {
          if (!host_id) throw new Error("missing host_id");
          await updateHostMachine({
            ...update,
            account_id,
            id: host_id,
          });
        });
      }

      await runStep("start_host", async () => {
        if (!host_id) throw new Error("missing host_id");
        hostStartRequestedAt = new Date();
        await startHost({ account_id, id: host_id });
        await waitForHostStatus(host_id, ["running"], waitHostRunning);
      });

      await runStep("wait_host_seen", async () => {
        if (!host_id) throw new Error("missing host_id");
        await waitForHostSeen(host_id, waitProjectReady, hostStartRequestedAt);
      });

      await runStep("start_project", async () => {
        if (!project_id) throw new Error("missing project_id");
        let lastErr: unknown;
        for (
          let attempt = 1;
          attempt <= waitProjectReady.attempts;
          attempt += 1
        ) {
          try {
            await startProject({ account_id, project_id });
            lastErr = undefined;
            break;
          } catch (err) {
            lastErr = err;
            logger.debug("smoke-runner startProject retry", {
              project_id,
              err: `${err}`,
              attempt,
            });
            if (String(err).includes("timeout")) {
              await sleep(waitProjectReady.intervalMs);
              continue;
            }
            await sleep(waitProjectReady.intervalMs);
          }
        }
        if (lastErr) {
          throw lastErr;
        }
      });

      await runStep("verify_sentinel", async () => {
        if (!project_id) throw new Error("missing project_id");
        if (provider === "lambda") {
          return;
        }
        await waitForProjectFile(
          clientFactory,
          project_id,
          sentinelPath,
          sentinelValue,
          waitProjectReady,
        );
      });
    }

    if (cleanup_on_success) {
      await runStep("cleanup", async () => {
        if (project_id) {
          await deleteProject({ project_id, skipPermissionCheck: true });
        }
        if (cleanup_host ?? createdHost) {
          if (!host_id) throw new Error("missing host_id for cleanup");
          await deleteHostInternal({ account_id, id: host_id });
        }
      });
    }

    return {
      ok: true,
      host_id,
      project_id,
      debug: debugHints
        ? {
            run_tag: run_tag ?? undefined,
            host_name: hostName,
            workspace_title: workspaceTitle,
            ssh_target: debugHints.ssh_target,
            ssh_tail_log: debugHints.ssh_tail_log,
            scp_log: debugHints.scp_log,
            host_log_path: debugHints.host_log_path,
            bootstrap_log_path: debugHints.bootstrap_log_path,
            host_url: debugHints.host_url,
          }
        : {
            run_tag: run_tag ?? undefined,
            host_name: hostName,
            workspace_title: workspaceTitle,
            host_log_path: "/mnt/cocalc/data/log",
            bootstrap_log_path: "/home/cocalc-host/cocalc-host/bootstrap/bootstrap.log",
          },
      steps,
    };
  } catch (err) {
    emit({
      step: "run",
      status: "failed",
      message: `${err}`,
    });
    return {
      ok: false,
      host_id,
      project_id,
      debug: debugHints
        ? {
            run_tag: run_tag ?? undefined,
            host_name: hostName,
            workspace_title: workspaceTitle,
            ssh_target: debugHints.ssh_target,
            ssh_tail_log: debugHints.ssh_tail_log,
            scp_log: debugHints.scp_log,
            host_log_path: debugHints.host_log_path,
            bootstrap_log_path: debugHints.bootstrap_log_path,
            host_url: debugHints.host_url,
          }
        : {
            run_tag: run_tag ?? undefined,
            host_name: hostName,
            workspace_title: workspaceTitle,
            host_log_path: "/mnt/cocalc/data/log",
            bootstrap_log_path: "/home/cocalc-host/cocalc-host/bootstrap/bootstrap.log",
          },
      steps,
    };
  }
}

async function runSmokeStepsViaCli({
  account_id,
  provider,
  run_tag,
  host_id,
  createSpec,
  hostStatus,
  update,
  restart_after_stop,
  wait,
  cleanup_on_success,
  cleanup_host,
  verify_terminal,
  verify_proxy,
  verify_backup,
  verify_provider_status,
  proxy_port,
  print_debug_hints,
  log,
}: {
  account_id: string;
  provider?: ProviderId;
  run_tag?: string;
  host_id?: string;
  createSpec?: Parameters<typeof createHost>[0];
  hostStatus?: string;
  update?: ProjectHostSmokeOptions["update"];
  restart_after_stop?: boolean;
  wait?: ProjectHostSmokeOptions["wait"];
  cleanup_on_success?: ProjectHostSmokeOptions["cleanup_on_success"];
  cleanup_host?: boolean;
  verify_terminal?: boolean;
  verify_proxy?: boolean;
  verify_backup?: boolean;
  verify_provider_status?: boolean;
  proxy_port?: number;
  print_debug_hints?: boolean;
  log?: ProjectHostSmokeOptions["log"];
}): Promise<ProjectHostSmokeResult> {
  const steps: ProjectHostSmokeResult["steps"] = [];
  const waitHostRunning = resolveWait(wait?.host_running, DEFAULT_HOST_RUNNING);
  const waitHostStopped = resolveWait(wait?.host_stopped, DEFAULT_HOST_STOPPED);
  const waitProjectReady = resolveWait(wait?.project_ready, DEFAULT_PROJECT_READY);
  const waitBackupReady = resolveWait(wait?.backup_ready, DEFAULT_BACKUP_READY);
  const verifyProviderStatus = verify_provider_status ?? false;
  const strictProviderStatus =
    process.env.COCALC_SMOKE_STRICT_PROVIDER_STATUS === "yes";
  const emit =
    log ??
    ((event) => {
      logger.info("smoke-runner", event);
    });

  const sentinelPath = ".smoke/persist.txt";
  const sentinelValue = `smoke:${Date.now()}`;
  const workspaceTitle = run_tag
    ? `Smoke test ${run_tag}`
    : `Smoke test ${host_id ?? "host"}`;
  const hostName = `${createSpec?.name ?? ""}`.trim() || undefined;
  let createdHost = false;
  let project_id: string | undefined;
  let debugHints: HostConnectionHints | undefined;

  const cli: CliContext = {
    nodePath: process.execPath,
    cliPath: resolveCliPath(),
    apiUrl: resolveApiUrl(),
    hubPassword: resolveHubPassword(),
    accountId: account_id,
    timeoutMs: Math.max(waitHostRunning.intervalMs * waitHostRunning.attempts, 600_000),
    pollMs: 1000,
  };

  const runStep = async (name: string, fn: () => Promise<void>) => {
    const startedAt = new Date();
    emit({ step: name, status: "start" });
    try {
      await fn();
      const finishedAt = new Date();
      steps.push({
        name,
        status: "ok",
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
      });
      emit({ step: name, status: "ok" });
      if (host_id && verifyProviderStatus) {
        try {
          await checkProviderStatus({ host_id, providerHint: provider });
        } catch (err) {
          if (strictProviderStatus) {
            throw err;
          }
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("smoke-runner provider status check skipped", {
            host_id,
            provider,
            step: name,
            err: message,
          });
          emit({
            step: `${name}:provider_status`,
            status: "ok",
            message: `skipped provider status check: ${message}`,
          });
        }
      }
    } catch (err) {
      const finishedAt = new Date();
      const message = err instanceof Error ? err.message : String(err);
      steps.push({
        name,
        status: "failed",
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        error: message,
      });
      emit({ step: name, status: "failed", message });
      throw err;
    }
  };

  try {
    if (!host_id && createSpec) {
      await runStep("create_host", async () => {
        const normalizedProvider =
          provider ?? normalizeProviderId(createSpec.machine?.cloud);
        if (!normalizedProvider) {
          throw new Error("unable to determine provider for smoke host create");
        }
        try {
          const host = await runCli<{ host_id?: string }>(
            cli,
            buildHostCreateCliArgs({
              provider: normalizedProvider,
              create: createSpec,
            }),
          );
          host_id = `${host.host_id ?? ""}`.trim();
          if (!host_id) {
            throw new Error("host create did not return host_id");
          }
          createdHost = true;
          return;
        } catch (err) {
          const msg = getErrorMessage(err);
          logger.warn("cloud smoke host create failed; probing by name", {
            provider: normalizedProvider,
            host_name: createSpec.name,
            err: msg,
          });
          const recoveredHostId = await findHostByNameViaCli(cli, createSpec.name);
          if (!recoveredHostId) {
            throw err;
          }
          host_id = recoveredHostId;
          createdHost = true;
          emit({
            step: "create_host:recovered",
            status: "ok",
            message: `recovered host_id=${recoveredHostId} by name=${createSpec.name}`,
          });
        }
      });
    }

    if (host_id && !createSpec && hostStatus !== "running") {
      await runStep("start_existing_host", async () => {
        if (!host_id) throw new Error("missing host_id");
        await runCli(cli, ["host", "start", host_id, "--wait"]);
      });
    }

    await runStep("wait_host_running", async () => {
      if (!host_id) throw new Error("missing host_id");
      await waitForHostStatusViaCli({
        cli,
        host_id,
        allowed: ["running", "active"],
        wait: waitHostRunning,
      });
      debugHints = await loadHostConnectionHints(host_id);
      if (print_debug_hints !== false) {
        const parts = [
          `host_id=${host_id}`,
          debugHints.host_url ? `url=${debugHints.host_url}` : undefined,
          debugHints.ssh_target ? `ssh=${debugHints.ssh_target}` : undefined,
          debugHints.ssh_tail_log ? `tail='${debugHints.ssh_tail_log}'` : undefined,
          debugHints.scp_log ? `scp='${debugHints.scp_log}'` : undefined,
        ].filter(Boolean);
        emit({
          step: "debug_hints",
          status: "ok",
          message: parts.join(" "),
        });
      }
    });

    await runStep("create_project", async () => {
      if (!host_id) throw new Error("missing host_id");
      let lastErr: unknown;
      for (
        let attempt = 1;
        attempt <= Math.max(3, Math.min(10, waitProjectReady.attempts));
        attempt += 1
      ) {
        try {
          const workspace = await runCli<{ workspace_id?: string }>(
            cli,
            ["workspace", "create", workspaceTitle, "--host", host_id],
            { timeoutSeconds: 90, commandTimeoutMs: 180_000 },
          );
          project_id = `${workspace.workspace_id ?? ""}`.trim();
          if (!project_id) {
            throw new Error("workspace create did not return workspace_id");
          }
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          const msg = getErrorMessage(err);
          logger.warn("cloud smoke workspace create retry", {
            host_id,
            attempt,
            err: msg,
          });
          try {
            const recoveredProjectId = await findWorkspaceByTitleViaCli({
              cli,
              title: workspaceTitle,
              host_id,
            });
            if (recoveredProjectId) {
              project_id = recoveredProjectId;
              lastErr = undefined;
              emit({
                step: "create_project:recovered",
                status: "ok",
                message: `recovered workspace_id=${recoveredProjectId} by title='${workspaceTitle}'`,
              });
              break;
            }
          } catch (recoverErr) {
            logger.debug("cloud smoke workspace recovery probe failed", {
              host_id,
              attempt,
              err: getErrorMessage(recoverErr),
            });
          }
          if (
            msg.includes("failed to initialize workspace on host") ||
            msg.includes("calling remote function 'createProject': timeout") ||
            msg.includes("request timed out") ||
            msg.includes("websocket error")
          ) {
            await sleep(waitProjectReady.intervalMs);
            continue;
          }
          throw err;
        }
      }
      if (lastErr) {
        throw lastErr;
      }
    });

    await runStep("start_project", async () => {
      if (!project_id) throw new Error("missing project_id");
      let lastErr: unknown;
      for (
        let attempt = 1;
        attempt <= Math.max(3, Math.min(12, waitProjectReady.attempts));
        attempt += 1
      ) {
        try {
          await runCli(cli, [
            "workspace",
            "start",
            "--workspace",
            project_id,
            "--wait",
          ]);
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          const msg = getErrorMessage(err);
          logger.warn("cloud smoke workspace start retry", {
            project_id,
            attempt,
            err: msg,
          });
          if (
            msg.includes("timeout waiting for hub response: projects.start") ||
            msg.includes("no subscribers matching") ||
            msg.includes("timeout waiting for start op")
          ) {
            await sleep(waitProjectReady.intervalMs);
            continue;
          }
          throw err;
        }
      }
      if (lastErr) {
        throw lastErr;
      }
    });

    await runStep("write_sentinel", async () => {
      if (!project_id) throw new Error("missing project_id");
      let lastErr: unknown;
      for (
        let attempt = 1;
        attempt <= Math.max(3, Math.min(10, waitProjectReady.attempts));
        attempt += 1
      ) {
        try {
          await runCli(
            cli,
            [
              "workspace",
              "exec",
              "--workspace",
              project_id,
              "--timeout",
              "45",
              "--bash",
              `mkdir -p .smoke && printf %s ${JSON.stringify(sentinelValue)} > ${sentinelPath}`,
            ],
            { timeoutSeconds: 90, commandTimeoutMs: 180_000 },
          );
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          logger.debug("cloud smoke write_sentinel retry", {
            project_id,
            attempt,
            err: getErrorMessage(err),
          });
          await sleep(waitProjectReady.intervalMs);
        }
      }
      if (lastErr) {
        throw lastErr;
      }
    });

    await runStep("verify_sentinel_before_restart", async () => {
      if (!project_id) throw new Error("missing project_id");
      if (provider === "lambda") {
        return;
      }
      await waitForProjectFileValueViaCli({
        cli,
        project_id,
        path: sentinelPath,
        expected: sentinelValue,
        wait: waitProjectReady,
      });
    });

    if ((verify_backup ?? true) && provider !== "lambda") {
      await runStep("create_backup", async () => {
        if (!project_id) throw new Error("missing project_id");
        await runCli<{ op_id?: string }>(
          cli,
          ["workspace", "backup", "create", "--workspace", project_id],
          { timeoutSeconds: 90, commandTimeoutMs: 180_000 },
        );
      });

      await runStep("wait_backup_indexed", async () => {
        if (!project_id) throw new Error("missing project_id");
        const backup = await waitForBackupIndexedViaCli({
          cli,
          project_id,
          wait: waitBackupReady,
        });
        if (!backup?.id) {
          throw new Error("backup lookup did not return backup id");
        }
      });

      await runStep("verify_backup_index_contents", async () => {
        if (!project_id) throw new Error("missing project_id");
        const backup = await waitForBackupIndexedViaCli({
          cli,
          project_id,
          wait: waitBackupReady,
        });
        if (!backup.indexed) {
          logger.warn("cloud smoke backup index check skipped: backup not indexed", {
            project_id,
            backup_id: backup.id,
          });
          return;
        }
        const children = await runCli<Array<{ name?: string }>>(cli, [
          "workspace",
          "backup",
          "files",
          "--workspace",
          project_id,
          "--backup-id",
          backup.id,
          "--path",
          ".smoke",
        ]);
        const found = children.some((entry) =>
          String(entry?.name ?? "").includes("persist.txt"),
        );
        if (!found) {
          throw new Error("backup index did not include sentinel file");
        }
      });
    }

    if ((verify_terminal ?? true) && provider !== "lambda") {
      await runStep("terminal_smoke", async () => {
        if (!project_id) throw new Error("missing project_id");
        await runWorkspaceExecSmokeViaCli({
          cli,
          project_id,
          wait: waitProjectReady,
        });
      });
    }

    if ((verify_proxy ?? true) && provider !== "lambda") {
      await runStep("proxy_smoke", async () => {
        if (!project_id) throw new Error("missing project_id");
        if (!host_id) throw new Error("missing host_id");
        let lastErr: unknown;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            await runProxySmoke({
              account_id,
              host_id,
              project_id,
              wait: waitProjectReady,
              proxy_port: proxy_port ?? 33117,
            });
            lastErr = undefined;
            break;
          } catch (err) {
            lastErr = err;
            logger.warn("cloud smoke proxy retry", {
              project_id,
              host_id,
              attempt,
              err: `${err}`,
            });
            await sleep(waitProjectReady.intervalMs);
          }
        }
        if (lastErr) throw lastErr;
      });
    }

    await runStep("stop_host", async () => {
      if (!host_id) throw new Error("missing host_id");
      await runCli(cli, ["host", "stop", host_id, "--skip-backups", "--wait"]);
      await waitForHostStatusViaCli({
        cli,
        host_id,
        allowed: ["off", "deprovisioned", "stopped"],
        wait: waitHostStopped,
      });
    });

    const shouldRestart =
      restart_after_stop ?? (update && Object.keys(update).length > 0);
    if (shouldRestart) {
      if (update && Object.keys(update).length > 0) {
        await runStep("update_host", async () => {
          if (!host_id) throw new Error("missing host_id");
          await updateHostMachine({
            ...(update as Record<string, any>),
            account_id,
            id: host_id,
          });
        });
      }

      await runStep("start_host", async () => {
        if (!host_id) throw new Error("missing host_id");
        await runCli(cli, ["host", "start", host_id, "--wait"]);
      });

      await runStep("start_project", async () => {
        if (!project_id) throw new Error("missing project_id");
        let lastErr: unknown;
        for (
          let attempt = 1;
          attempt <= Math.max(3, Math.min(12, waitProjectReady.attempts));
          attempt += 1
        ) {
          try {
            await runCli(
              cli,
              ["workspace", "start", "--workspace", project_id, "--wait"],
              { timeoutSeconds: 90, commandTimeoutMs: 180_000 },
            );
            lastErr = undefined;
            break;
          } catch (err) {
            lastErr = err;
            const msg = getErrorMessage(err);
            logger.warn("cloud smoke workspace restart retry", {
              project_id,
              attempt,
              err: msg,
            });
            if (
              msg.includes("timeout waiting for hub response: projects.start") ||
              msg.includes("no subscribers matching") ||
              msg.includes("timeout waiting for start op")
            ) {
              await sleep(waitProjectReady.intervalMs);
              continue;
            }
            throw err;
          }
        }
        if (lastErr) {
          throw lastErr;
        }
      });

      await runStep("verify_sentinel", async () => {
        if (!project_id) throw new Error("missing project_id");
        if (provider === "lambda") {
          return;
        }
        await waitForProjectFileValueViaCli({
          cli,
          project_id,
          path: sentinelPath,
          expected: sentinelValue,
          wait: waitProjectReady,
        });
      });
    }

    if (cleanup_on_success) {
      await runStep("cleanup", async () => {
        const workspaceIds = new Set<string>();
        if (project_id) {
          workspaceIds.add(project_id);
        }
        if (workspaceTitle) {
          for (const id of await listWorkspaceIdsByTitleViaCli({
            cli,
            title: workspaceTitle,
            host_id,
          })) {
            workspaceIds.add(id);
          }
        }
        for (const workspaceId of workspaceIds) {
          await runCli(cli, [
            "workspace",
            "delete",
            "--workspace",
            workspaceId,
            "--hard",
            "--purge-backups-now",
            "--yes",
            "--wait",
          ]);
        }
        if (cleanup_host ?? createdHost) {
          const hostIds = new Set<string>();
          if (host_id) {
            hostIds.add(host_id);
          }
          if (hostName) {
            for (const id of await listHostIdsByNameViaCli(cli, hostName)) {
              hostIds.add(id);
            }
          }
          if (!hostIds.size) {
            throw new Error("missing host_id for cleanup");
          }
          for (const id of hostIds) {
            await runCli(cli, ["host", "delete", id, "--skip-backups", "--wait"]);
          }
        }
      });
    }

    return {
      ok: true,
      host_id,
      project_id,
      debug: debugHints
        ? {
            run_tag: run_tag ?? undefined,
            host_name: hostName,
            workspace_title: workspaceTitle,
            ssh_target: debugHints.ssh_target,
            ssh_tail_log: debugHints.ssh_tail_log,
            scp_log: debugHints.scp_log,
            host_log_path: debugHints.host_log_path,
            bootstrap_log_path: debugHints.bootstrap_log_path,
            host_url: debugHints.host_url,
          }
        : {
            run_tag: run_tag ?? undefined,
            host_name: hostName,
            workspace_title: workspaceTitle,
            host_log_path: "/mnt/cocalc/data/log",
            bootstrap_log_path: "/home/cocalc-host/cocalc-host/bootstrap/bootstrap.log",
          },
      steps,
    };
  } catch (err) {
    emit({
      step: "run",
      status: "failed",
      message: `${err}`,
    });
    return {
      ok: false,
      host_id,
      project_id,
      debug: debugHints
        ? {
            run_tag: run_tag ?? undefined,
            host_name: hostName,
            workspace_title: workspaceTitle,
            ssh_target: debugHints.ssh_target,
            ssh_tail_log: debugHints.ssh_tail_log,
            scp_log: debugHints.scp_log,
            host_log_path: debugHints.host_log_path,
            bootstrap_log_path: debugHints.bootstrap_log_path,
            host_url: debugHints.host_url,
          }
        : {
            run_tag: run_tag ?? undefined,
            host_name: hostName,
            workspace_title: workspaceTitle,
            host_log_path: "/mnt/cocalc/data/log",
            bootstrap_log_path: "/home/cocalc-host/cocalc-host/bootstrap/bootstrap.log",
          },
      steps,
    };
  }
}

export async function runProjectHostPersistenceSmokeTest(
  opts: ProjectHostSmokeOptions,
): Promise<ProjectHostSmokeResult> {
  return await runSmokeSteps({
    account_id: opts.account_id,
    provider: opts.provider,
    run_tag: opts.run_tag,
    createSpec: opts.create,
    update: opts.update,
    restart_after_stop: opts.restart_after_stop,
    wait: opts.wait,
    cleanup_on_success: opts.cleanup_on_success,
    cleanup_host: true,
    verify_terminal: opts.verify_terminal,
    verify_proxy: opts.verify_proxy,
    verify_backup: opts.verify_backup,
    verify_provider_status: opts.verify_provider_status,
    proxy_port: opts.proxy_port,
    print_debug_hints: opts.print_debug_hints,
    log: opts.log,
  });
}

export async function runProjectHostPersistenceSmokeTestForHostId({
  host_id,
  run_tag,
  update,
  wait,
  cleanup_on_success,
  verify_terminal,
  verify_proxy,
  verify_backup,
  verify_provider_status,
  proxy_port,
  print_debug_hints,
  log,
}: {
  host_id: string;
  run_tag?: string;
  update?: ProjectHostSmokeOptions["update"];
  wait?: ProjectHostSmokeOptions["wait"];
  cleanup_on_success?: ProjectHostSmokeOptions["cleanup_on_success"];
  verify_terminal?: boolean;
  verify_proxy?: boolean;
  verify_backup?: boolean;
  verify_provider_status?: boolean;
  proxy_port?: number;
  print_debug_hints?: boolean;
  log?: ProjectHostSmokeOptions["log"];
}): Promise<ProjectHostSmokeResult> {
  const { rows } = await getPool().query(
    "SELECT name, status, metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
    [host_id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`host ${host_id} not found`);
  }
  const metadata = row.metadata ?? {};
  const account_id = metadata.owner;
  if (!account_id) {
    throw new Error("host has no owner; cannot run smoke test");
  }
  const existingStatus = row.status ?? "unknown";
  const provider = normalizeProviderId(metadata.machine?.cloud);
  if (
    !["off", "deprovisioned", "error", "starting", "running"].includes(
      existingStatus,
    )
  ) {
    log?.({
      step: "precheck",
      status: "failed",
      message: `host status is ${existingStatus}; expected off/deprovisioned`,
    });
  }

  return await runSmokeSteps({
    account_id,
    provider,
    run_tag,
    host_id,
    hostStatus: existingStatus,
    update,
    restart_after_stop: true,
    wait,
    cleanup_on_success,
    cleanup_host: false,
    verify_terminal,
    verify_proxy,
    verify_backup,
    verify_provider_status,
    proxy_port,
    print_debug_hints,
    log,
  });
}

type CatalogEntry = {
  kind: string;
  scope: string;
  payload: any;
};

async function loadCatalogEntries(
  provider: ProviderId,
): Promise<CatalogEntry[]> {
  const { rows } = await getPool().query(
    `SELECT kind, scope, payload
       FROM cloud_catalog_cache
      WHERE provider=$1`,
    [provider],
  );
  return rows as CatalogEntry[];
}

function getCatalogPayload<T>(
  entries: CatalogEntry[],
  kind: string,
  scope: string,
): T | undefined {
  return entries.find((entry) => entry.kind === kind && entry.scope === scope)
    ?.payload as T | undefined;
}

function pickDifferent<T>(
  items: T[],
  current?: T,
  predicate?: (value: T) => boolean,
): T | undefined {
  for (const item of items) {
    if (predicate && !predicate(item)) continue;
    if (current !== undefined && item === current) continue;
    return item;
  }
  return undefined;
}

async function buildPresetForGcp(): Promise<SmokePreset | undefined> {
  const entries = await loadCatalogEntries("gcp");
  const regions =
    getCatalogPayload<Array<{ name: string; zones: string[] }>>(
      entries,
      "regions",
      "global",
    ) ?? [];
  const zones =
    getCatalogPayload<Array<{ name: string }>>(entries, "zones", "global") ??
    [];
  const zoneNames = new Set(zones.map((z) => z.name));
  const regionName = "us-west1";
  const region = regions.find((r) => r.name === regionName);
  if (!region) return undefined;
  const preferredZones = ["us-west1-b", "us-west1-a", "us-west1-c"];
  const zone =
    preferredZones.find(
      (z) => (region.zones ?? []).includes(z) && zoneNames.has(z),
    ) ??
    (region.zones ?? []).find((z) => zoneNames.has(z));
  if (!zone) return undefined;

  const machineTypes =
    getCatalogPayload<any[]>(entries, "machine_types", `zone/${zone}`) ?? [];
  const hasE2Standard2 = machineTypes.some(
    (entry) => entry?.name === "e2-standard-2",
  );
  if (!hasE2Standard2) return undefined;

  return {
    id: "gcp-cpu",
    label: `GCP CPU (${regionName}/${zone}, e2-standard-2)`,
    provider: "gcp",
    create: {
      name: `smoke-gcp-e2s2-${Date.now()}`,
      region: regionName,
      size: "e2-standard-2",
      gpu: false,
      machine: {
        cloud: "gcp",
        zone,
        machine_type: "e2-standard-2",
        disk_gb: 100,
        disk_type: "balanced",
        storage_mode: "persistent",
      },
    },
    restart_after_stop: true,
    update: undefined,
  };
}

async function buildPresetForNebius(): Promise<SmokePreset | undefined> {
  const entries = await loadCatalogEntries("nebius");
  const regions =
    getCatalogPayload<Array<{ name: string }>>(entries, "regions", "global") ??
    [];
  const instanceTypes =
    getCatalogPayload<Array<{ name: string; gpus?: number; vcpus?: number }>>(
      entries,
      "instance_types",
      "global",
    ) ?? [];
  const region = regions[0]?.name;
  if (!region || !instanceTypes.length) return undefined;

  const primary =
    instanceTypes.find((entry) => (entry.gpus ?? 0) === 0) ?? instanceTypes[0];
  const updateType =
    pickDifferent(instanceTypes, primary, (entry) => entry?.name !== undefined)
      ?.name ?? undefined;

  return {
    id: "nebius-cpu",
    label: `Nebius CPU (${region})`,
    provider: "nebius",
    create: {
      name: `smoke-nebius-${Date.now()}`,
      region,
      size: primary.name,
      gpu: false,
      machine: {
        cloud: "nebius",
        machine_type: primary.name,
        disk_gb: 100,
        disk_type: "ssd_io_m3",
        storage_mode: "persistent",
      },
    },
    update: updateType ? { machine_type: updateType } : undefined,
  };
}

async function buildPresetForHyperstack(): Promise<SmokePreset | undefined> {
  const entries = await loadCatalogEntries("hyperstack");
  const flavors =
    getCatalogPayload<Array<{ region_name: string; flavors: Array<any> }>>(
      entries,
      "flavors",
      "global",
    ) ?? [];
  const region = "CANADA-1";
  const flavorList =
    flavors.find((entry) => entry.region_name === region)?.flavors ?? [];
  if (!flavorList.length) return undefined;
  const primary =
    flavorList.find((entry) => (entry.gpu_count ?? 0) === 0) ?? flavorList[0];
  const updateFlavor = pickDifferent(flavorList, primary)?.name ?? undefined;

  return {
    id: "hyperstack-cpu",
    label: `Hyperstack CPU (${region})`,
    provider: "hyperstack",
    create: {
      name: `smoke-hyperstack-${Date.now()}`,
      region,
      size: primary.name,
      gpu: (primary.gpu_count ?? 0) > 0,
      machine: {
        cloud: "hyperstack",
        machine_type: primary.name,
        disk_gb: primary.disk ?? 50,
        storage_mode: "persistent",
      },
    },
    update: updateFlavor ? { machine_type: updateFlavor } : undefined,
    wait: {
      host_running: { intervalMs: 10000, attempts: 180 },
      project_ready: { intervalMs: 5000, attempts: 120 },
    },
  };
}

async function buildPresetForLambda(): Promise<SmokePreset | undefined> {
  const entries = await loadCatalogEntries("lambda");
  const instanceTypes =
    getCatalogPayload<
      Array<{ name: string; regions: string[]; gpus?: number }>
    >(entries, "instance_types", "global") ?? [];
  if (!instanceTypes.length) return undefined;

  const gpuEntries = instanceTypes.filter((entry) => (entry.gpus ?? 0) > 0);
  if (!gpuEntries.length) return undefined;
  const pickPreferredGpu = (
    items: Array<{ name: string; regions: string[]; gpus?: number }>,
  ) => {
    const matches = (needle: string) =>
      items.filter((entry) => entry.name.toLowerCase().includes(needle));
    return (
      matches("a10").find((entry) => (entry.gpus ?? 0) === 1) ??
      matches("a100").find((entry) => (entry.gpus ?? 0) === 1) ??
      items.find((entry) => (entry.gpus ?? 0) === 1) ??
      items[0]
    );
  };
  const primary = pickPreferredGpu(gpuEntries);
  const region = primary.regions?.[0];
  if (!region) return undefined;
  const updateType = pickDifferent(gpuEntries, primary)?.name ?? undefined;

  return {
    id: "lambda-gpu",
    label: `Lambda GPU (${region})`,
    provider: "lambda",
    create: {
      name: `smoke-lambda-${Date.now()}`,
      region,
      size: primary.name,
      gpu: true,
      machine: {
        cloud: "lambda",
        machine_type: primary.name,
        storage_mode: "persistent",
        metadata: {
          instance_type_name: primary.name,
        },
      },
    },
    update: updateType ? { machine_type: updateType } : undefined,
    restart_after_stop: false,
  };
}

export async function listProjectHostSmokePresets({
  provider,
}: {
  provider: ProviderId | string;
}): Promise<SmokePreset[]> {
  const normalized = normalizeProviderId(provider);
  if (!normalized) return [];
  switch (normalized) {
    case "gcp": {
      const preset = await buildPresetForGcp();
      return preset ? [preset] : [];
    }
    case "nebius": {
      const preset = await buildPresetForNebius();
      return preset ? [preset] : [];
    }
    case "hyperstack": {
      const preset = await buildPresetForHyperstack();
      return preset ? [preset] : [];
    }
    case "lambda": {
      const preset = await buildPresetForLambda();
      return preset ? [preset] : [];
    }
    default:
      return [];
  }
}

export async function runProjectHostPersistenceSmokePreset({
  account_id,
  provider,
  run_tag,
  preset,
  cleanup_on_success = true,
  verify_backup = true,
  verify_terminal = true,
  verify_proxy = true,
  verify_provider_status = false,
  execution_mode = "cli",
  proxy_port,
  print_debug_hints = true,
  wait,
  log,
}: {
  account_id?: string;
  provider: ProviderId | string;
  run_tag?: string;
  preset?: string;
  cleanup_on_success?: boolean;
  verify_backup?: boolean;
  verify_terminal?: boolean;
  verify_proxy?: boolean;
  verify_provider_status?: boolean;
  execution_mode?: "cli" | "direct";
  proxy_port?: number;
  print_debug_hints?: boolean;
  wait?: ProjectHostSmokeOptions["wait"];
  log?: ProjectHostSmokeOptions["log"];
}): Promise<ProjectHostSmokeResult> {
  const resolvedAccountId = await resolveSmokeAccountId(account_id);
  const normalizedProvider = normalizeProviderId(provider);
  const presets = await listProjectHostSmokePresets({ provider });
  if (!presets.length) {
    throw new Error(`no smoke presets available for ${provider}`);
  }
  if (!preset) {
    preset = presets[0].id;
  }
  const selected =
    (preset && presets.find((p) => p.id === preset)) ?? presets[0];
  if (!selected) {
    throw new Error(`smoke preset ${preset} not found for ${provider}`);
  }
  const smokeInput = {
    account_id: resolvedAccountId,
    provider: normalizedProvider ?? undefined,
    run_tag: sanitizeRunTag(run_tag),
    createSpec: {
      ...selected.create,
      name: withRunTagSuffix(selected.create.name, run_tag),
      account_id: resolvedAccountId,
    },
    update: selected.update,
    restart_after_stop: selected.restart_after_stop,
    wait: wait ?? selected.wait,
    cleanup_on_success,
    cleanup_host: true,
    verify_backup,
    verify_terminal,
    verify_proxy,
    verify_provider_status,
    proxy_port,
    print_debug_hints,
    log,
  };

  if (execution_mode === "direct") {
    return await runSmokeSteps(smokeInput);
  }
  return await runSmokeStepsViaCli(smokeInput);
}

export async function runProjectHostGcpFlowSmoke({
  account_id,
  run_tag,
  cleanup_on_success = false,
  verify_backup = true,
  verify_terminal = true,
  verify_proxy = true,
  verify_provider_status = false,
  execution_mode = "cli",
  proxy_port = 33117,
  print_debug_hints = true,
  wait,
  log,
}: {
  account_id?: string;
  run_tag?: string;
  cleanup_on_success?: boolean;
  verify_backup?: boolean;
  verify_terminal?: boolean;
  verify_proxy?: boolean;
  verify_provider_status?: boolean;
  execution_mode?: "cli" | "direct";
  proxy_port?: number;
  print_debug_hints?: boolean;
  wait?: ProjectHostSmokeOptions["wait"];
  log?: ProjectHostSmokeOptions["log"];
}): Promise<ProjectHostSmokeResult> {
  return await runProjectHostPersistenceSmokePreset({
    account_id,
    run_tag,
    provider: "gcp",
    preset: "gcp-cpu",
    cleanup_on_success,
    verify_backup,
    verify_terminal,
    verify_proxy,
    verify_provider_status,
    execution_mode,
    proxy_port,
    print_debug_hints,
    wait,
    log,
  });
}
