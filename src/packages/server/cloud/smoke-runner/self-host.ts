/*
Smoke test for self-host project hosts via Multipass.

What it does:
1. Launches two fresh Multipass VMs (source + destination) with your local SSH
   public key when move/restore verification is enabled.
2. Creates self-host host records that point to each VM over SSH.
3. Starts the hosts and waits for running.
4. Creates/starts a project on the source host and writes a sentinel file.
5. Creates a backup and waits until an indexed snapshot is visible.
6. Moves the project to the destination host and verifies the sentinel file.
7. Optionally restores backup content on destination and verifies file content.
8. Optionally verifies cross-host copy works by copying from a project on one
   host to a project on the other host.
9. Optionally deprovisions all created hosts.

Typical usage from a node REPL:

  a = require("../../dist/cloud/smoke-runner/self-host");
  await a.runSelfHostMultipassBackupSmoke({});
*/

import { randomUUID } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { resolveOnPremHost } from "@cocalc/server/onprem";
import { isValidUUID } from "@cocalc/util/misc";

const logger = getLogger("server:cloud:smoke-runner:self-host");
const execFile = promisify(execFileCb);

type WaitOptions = {
  intervalMs: number;
  attempts: number;
};

type StepResult = {
  name: string;
  status: "ok" | "failed";
  started_at: string;
  finished_at: string;
  error?: string;
};

type LogEvent = {
  step: string;
  status: "start" | "ok" | "failed";
  message?: string;
};

export type SelfHostMultipassSmokeOptions = {
  account_id?: string;
  api_url?: string;
  hub_password?: string;
  cocalc_cli_path?: string;
  vm_name?: string;
  vm_image?: string;
  vm_user?: string;
  vm_cpus?: number;
  vm_memory_gb?: number;
  vm_disk_gb?: number;
  ssh_public_key_path?: string;
  cleanup_on_success?: boolean;
  cleanup_on_failure?: boolean;
  verify_deprovision?: boolean;
  verify_backup_index_contents?: boolean;
  verify_copy_between_projects?: boolean;
  verify_move_restore_on_second_host?: boolean;
  verify_workspace_ssh?: boolean;
  verify_workspace_proxy?: boolean;
  strict_move_file_check?: boolean;
  wait?: Partial<{
    ssh_ready: Partial<WaitOptions>;
    host_running: Partial<WaitOptions>;
    host_deprovisioned: Partial<WaitOptions>;
    backup_indexed: Partial<WaitOptions>;
    copy_completed: Partial<WaitOptions>;
    move_completed: Partial<WaitOptions>;
    restored_file: Partial<WaitOptions>;
  }>;
  log?: (event: LogEvent) => void;
};

export type SelfHostMultipassSmokeResult = {
  ok: boolean;
  account_id: string;
  vm_name: string;
  vm_ip?: string;
  ssh_target?: string;
  host_id?: string;
  second_vm_name?: string;
  second_vm_ip?: string;
  second_ssh_target?: string;
  second_host_id?: string;
  project_id?: string;
  copy_project_id?: string;
  backup_id?: string;
  backup_op_id?: string;
  copy_op_id?: string;
  copy_dest_path?: string;
  move_op_id?: string;
  restore_op_id?: string;
  sentinel_path: string;
  sentinel_value: string;
  steps: StepResult[];
  error?: string;
  debug_hints: {
    host_log: string;
    project_host_log: string;
    backup_log: string;
  };
};

const DEFAULT_SSH_READY_WAIT: WaitOptions = { intervalMs: 2000, attempts: 90 };
const DEFAULT_HOST_RUNNING_WAIT: WaitOptions = { intervalMs: 5000, attempts: 120 };
const DEFAULT_BACKUP_INDEXED_WAIT: WaitOptions = {
  intervalMs: 3000,
  attempts: 80,
};
const DEFAULT_COPY_COMPLETED_WAIT: WaitOptions = {
  intervalMs: 2000,
  attempts: 90,
};
const DEFAULT_MOVE_COMPLETED_WAIT: WaitOptions = {
  intervalMs: 3000,
  attempts: 120,
};
const DEFAULT_RESTORED_FILE_WAIT: WaitOptions = {
  intervalMs: 2000,
  attempts: 90,
};
const DEFAULT_HOST_DEPROVISIONED_WAIT: WaitOptions = {
  intervalMs: 5000,
  attempts: 120,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function resolveWait(
  override: Partial<WaitOptions> | undefined,
  fallback: WaitOptions,
): WaitOptions {
  return {
    intervalMs: override?.intervalMs ?? fallback.intervalMs,
    attempts: override?.attempts ?? fallback.attempts,
  };
}

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
  command?: string;
  data?: T;
  meta?: {
    api?: string;
    account_id?: string;
  };
  error?: {
    code?: string;
    message?: string;
  };
};

function quoteYamlSingle(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function resolveSshPublicKey(pathHint?: string): Promise<string> {
  const candidates = [
    pathHint,
    process.env.SSH_PUBLIC_KEY_PATH,
    join(homedir(), ".ssh", "id_ed25519.pub"),
    join(homedir(), ".ssh", "id_rsa.pub"),
  ].filter(Boolean) as string[];
  for (const path of candidates) {
    try {
      const key = (await readFile(path, "utf8")).trim();
      if (key) {
        return key;
      }
    } catch {}
  }
  throw new Error(
    "unable to read local SSH public key; set ssh_public_key_path or create ~/.ssh/id_ed25519.pub",
  );
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

async function requireCommand(name: string): Promise<void> {
  await runCommand("which", [name]);
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
  const explicit = pathHint?.trim() || process.env.COCALC_API_URL || process.env.BASE_URL;
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

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function quoteShellSingle(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function commandTimeoutMs(cli: CliContext): number {
  // Allow enough room for potentially long-running operations while keeping
  // child process timeouts finite to avoid hung smoke runs.
  return Math.max(cli.timeoutMs + 30_000, 120_000);
}

function parseCliEnvelope<T>(stdout: string, stderr: string, command: string): CliEnvelope<T> {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`empty CLI output for '${command}'${stderr ? ` (stderr: ${stderr})` : ""}`);
  }
  try {
    return JSON.parse(trimmed) as CliEnvelope<T>;
  } catch (err) {
    throw new Error(
      `invalid CLI JSON for '${command}': ${getErrorMessage(err)}${stderr ? ` (stderr: ${stderr})` : ""}`,
    );
  }
}

type RunCliOptions = {
  timeoutSeconds?: number;
  pollMs?: number;
  commandTimeoutMs?: number;
};

function parseSshServer(server: string): { host: string; port: number | null } {
  const value = server.trim();
  if (!value) {
    throw new Error("empty ssh_server");
  }
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) {
      throw new Error(`invalid ssh_server '${value}'`);
    }
    const host = value.slice(1, end);
    const rest = value.slice(end + 1);
    if (!rest) return { host, port: null };
    if (!rest.startsWith(":")) {
      throw new Error(`invalid ssh_server '${value}'`);
    }
    const port = Number(rest.slice(1));
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`invalid ssh_server '${value}'`);
    }
    return { host, port };
  }
  const idx = value.lastIndexOf(":");
  if (idx <= 0 || idx === value.length - 1) {
    return { host: value, port: null };
  }
  const host = value.slice(0, idx);
  const port = Number(value.slice(idx + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { host: value, port: null };
  }
  return { host, port };
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
  if (!cli.accountId && typeof responseAccountId === "string" && isValidUUID(responseAccountId)) {
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

async function assertWorkspaceSshRouteMatchesLocalTunnel({
  cli,
  workspaceId,
  hostId,
}: {
  cli: CliContext;
  workspaceId: string;
  hostId: string;
}): Promise<void> {
  const { rows } = await getPool().query<{ metadata: any }>(
    `SELECT metadata
       FROM project_hosts
      WHERE id=$1 AND deleted IS NULL
      LIMIT 1`,
    [hostId],
  );
  const metadata = rows[0]?.metadata ?? {};
  const machine = metadata?.machine ?? {};
  const rawSelfHostMode = machine?.metadata?.self_host_mode;
  const effectiveSelfHostMode =
    machine?.cloud === "self-host" && !rawSelfHostMode ? "local" : rawSelfHostMode;
  const isLocalSelfHost =
    machine?.cloud === "self-host" && effectiveSelfHostMode === "local";
  if (!isLocalSelfHost) {
    return;
  }
  const expectedPort = Number(metadata?.self_host?.ssh_tunnel_port);
  if (!Number.isInteger(expectedPort) || expectedPort <= 0 || expectedPort > 65535) {
    throw new Error(
      `self-host local tunnel is missing ssh_tunnel_port (host=${hostId})`,
    );
  }
  const route = await runCli<{
    ssh_server?: string | null;
    ssh_transport?: string;
    workspace_id?: string;
  }>(cli, ["workspace", "ssh-info", "--workspace", workspaceId]);
  const sshServer = `${route.ssh_server ?? ""}`.trim();
  if (!sshServer) {
    throw new Error("workspace ssh returned no ssh_server");
  }
  const parsed = parseSshServer(sshServer);
  const expectedHost = resolveOnPremHost();
  if (parsed.host !== expectedHost || parsed.port !== expectedPort) {
    throw new Error(
      `workspace ssh route mismatch: got ${sshServer}, expected ${expectedHost}:${expectedPort}`,
    );
  }
}

async function resolveSmokeAccountId(
  cli: CliContext,
  requested?: string,
): Promise<string> {
  if (requested) {
    return requested;
  }
  const rows = await runCli<Array<{ workspace_id: string }>>(cli, [
    "workspace",
    "list",
    "--limit",
    "1",
  ]);
  if (rows.length === 0 && !cli.accountId) {
    throw new Error(
      "unable to determine account_id from CLI session; pass account_id explicitly",
    );
  }
  if (!cli.accountId) {
    throw new Error(
      "CLI did not report account_id metadata; pass account_id explicitly",
    );
  }
  return cli.accountId;
}

async function getMultipassIp(vmName: string): Promise<string> {
  const { stdout } = await runCommand("multipass", [
    "info",
    vmName,
    "--format",
    "json",
  ]);
  const parsed = JSON.parse(stdout);
  const info = parsed?.info?.[vmName];
  const ips = Array.isArray(info?.ipv4) ? info.ipv4 : [];
  const ip = ips.find((x: any) => typeof x === "string" && x.trim());
  if (!ip) {
    throw new Error(`could not determine ipv4 for multipass vm '${vmName}'`);
  }
  return ip;
}

async function waitForSshReady({
  sshTarget,
  wait,
}: {
  sshTarget: string;
  wait: WaitOptions;
}): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= wait.attempts; attempt += 1) {
    try {
      await runCommand(
        "ssh",
        [
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=accept-new",
          "-o",
          "ConnectTimeout=5",
          sshTarget,
          "true",
        ],
        { timeoutMs: 15_000 },
      );
      return;
    } catch (err) {
      lastErr = err;
      logger.debug("self-host smoke ssh wait retry", {
        sshTarget,
        attempt,
        err: `${err}`,
      });
      await sleep(wait.intervalMs);
    }
  }
  throw new Error(`ssh did not become ready: ${lastErr ?? "unknown error"}`);
}

async function waitForHostStatus({
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
      logger.debug("self-host smoke host status retry", {
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

async function waitForBackupIndexed({
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
      const sorted = [...indexedBackups].sort((a, b) =>
        String(b?.time ?? "").localeCompare(String(a?.time ?? "")) ||
        String(a?.backup_id ?? "").localeCompare(String(b?.backup_id ?? "")),
      );
      return { id: String(sorted[0].backup_id), indexed: true };
    }

    // Some local/self-host dev setups produce usable backups but don't always
    // surface indexed snapshots promptly. Use the newest available backup so
    // smoke can continue to restore/copy validation.
    const backups = await runCli<Array<{ backup_id?: string; time?: string | Date | null }>>(
      cli,
      ["workspace", "backup", "list", "--workspace", project_id, "--limit", "100"],
    );
    lastAnyCount = backups.length;
    if (backups.length > 0 && backups[0]?.backup_id) {
      const sorted = [...backups].sort((a, b) =>
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

async function waitForProjectPlacement({
  cli,
  project_id,
  host_id,
  wait,
}: {
  cli: CliContext;
  project_id: string;
  host_id: string;
  wait: WaitOptions;
}): Promise<void> {
  let lastHost = "unknown";
  for (let attempt = 1; attempt <= wait.attempts; attempt += 1) {
    const workspace = await runCli<{ host_id?: string | null }>(cli, [
      "workspace",
      "get",
      "--workspace",
      project_id,
    ]);
    const current = String(workspace?.host_id ?? "");
    lastHost = current || "none";
    if (current === host_id) return;
    await sleep(wait.intervalMs);
  }
  throw new Error(
    `project placement did not update to destination host; last host_id=${lastHost}`,
  );
}

async function waitForProjectFileValue({
  cli,
  project_id,
  path,
  expected,
  wait,
  execTimeoutSeconds = 30,
  commandTimeoutMs = 120_000,
}: {
  cli: CliContext;
  project_id: string;
  path: string;
  expected: string;
  wait: WaitOptions;
  execTimeoutSeconds?: number;
  commandTimeoutMs?: number;
}): Promise<void> {
  for (let attempt = 1; attempt <= wait.attempts; attempt += 1) {
    try {
      const out = await runCli<{
        content?: string;
      }>(
        cli,
        ["workspace", "file", "cat", "--workspace", project_id, path],
        {
        timeoutSeconds: Math.max(execTimeoutSeconds + 15, 20),
        commandTimeoutMs,
      },
      );
      const value = String(out?.content ?? "").replace(/\r?\n$/, "");
      if (value === expected) return;
    } catch (err) {
      logger.debug("self-host smoke readFile retry", {
        project_id,
        path,
        attempt,
        err: getErrorMessage(err),
      });
    }
    await sleep(wait.intervalMs);
  }
  throw new Error(`timeout waiting for restored file '${path}'`);
}

async function launchMultipassVm({
  vmName,
  vmImage,
  vmUser,
  vmCpus,
  vmMemoryGb,
  vmDiskGb,
  sshPublicKey,
  tempRoot,
  tempDirs,
}: {
  vmName: string;
  vmImage: string;
  vmUser: string;
  vmCpus: number;
  vmMemoryGb: number;
  vmDiskGb: number;
  sshPublicKey: string;
  tempRoot: string;
  tempDirs: string[];
}): Promise<{ vmIp: string; sshTarget: string }> {
  await mkdir(tempRoot, { recursive: true });
  const tempDir = await mkdtemp(join(tempRoot, "cocalc-self-host-smoke-"));
  tempDirs.push(tempDir);
  const cloudInitPath = join(tempDir, "cloud-init.yaml");
  const cloudInit = `#cloud-config
users:
  - name: ${vmUser}
    ssh_authorized_keys:
      - ${quoteYamlSingle(sshPublicKey)}
`;
  await writeFile(cloudInitPath, cloudInit, "utf8");
  const args = [
    "launch",
    vmImage,
    "--name",
    vmName,
    "--cpus",
    String(vmCpus),
    "--memory",
    `${vmMemoryGb}G`,
    "--disk",
    `${vmDiskGb}G`,
    "--cloud-init",
    cloudInitPath,
  ];
  await runCommand("multipass", args, { timeoutMs: 8 * 60 * 1000 });
  const vmIp = await getMultipassIp(vmName);
  return { vmIp, sshTarget: `${vmUser}@${vmIp}` };
}

async function cleanupMultipassVm(vmName: string): Promise<void> {
  try {
    await runCommand("multipass", ["delete", vmName], { timeoutMs: 120_000 });
  } catch (err) {
    logger.warn("self-host smoke multipass delete failed", {
      vm_name: vmName,
      err: `${err}`,
    });
  }
  try {
    await runCommand("multipass", ["purge"], { timeoutMs: 120_000 });
  } catch (err) {
    logger.warn("self-host smoke multipass purge failed", {
      vm_name: vmName,
      err: `${err}`,
    });
  }
}

async function listMultipassVmNames(): Promise<string[]> {
  try {
    const { stdout } = await runCommand("multipass", ["list", "--format", "json"]);
    const parsed = JSON.parse(stdout);
    const list = Array.isArray(parsed?.list) ? parsed.list : [];
    return list
      .map((x: any) => `${x?.name ?? ""}`.trim())
      .filter((name: string) => !!name);
  } catch {
    const { stdout } = await runCommand("multipass", ["list"]);
    const lines = stdout.split("\n").map((s) => s.trim());
    const names: string[] = [];
    for (const line of lines) {
      if (!line || line.startsWith("Name")) continue;
      const name = line.split(/\s+/)[0];
      if (name) names.push(name);
    }
    return names;
  }
}

async function cleanupExistingSmokeVms(): Promise<void> {
  const all = await listMultipassVmNames();
  const smokeVms = all.filter((name) => name.startsWith("cocalc-smoke-"));
  if (!smokeVms.length) return;
  logger.info("self-host smoke cleanup existing multipass VMs", {
    count: smokeVms.length,
    names: smokeVms,
  });
  for (const name of smokeVms) {
    await cleanupMultipassVm(name);
  }
}

export async function runSelfHostMultipassBackupSmoke(
  opts: SelfHostMultipassSmokeOptions = {},
): Promise<SelfHostMultipassSmokeResult> {
  const steps: StepResult[] = [];
  const emit =
    opts.log ??
    ((event: LogEvent) => {
      logger.info("self-host smoke", event);
    });
  let account_id = opts.account_id ?? "";
  const vmName = opts.vm_name ?? `cocalc-smoke-${Date.now().toString(36)}`;
  const vmImage = opts.vm_image ?? "24.04";
  const vmUser = opts.vm_user ?? "ubuntu";
  const vmCpus = opts.vm_cpus ?? 2;
  const vmMemoryGb = opts.vm_memory_gb ?? 8;
  const vmDiskGb = opts.vm_disk_gb ?? 40;
  const cleanupOnSuccess = opts.cleanup_on_success ?? true;
  const cleanupOnFailure = opts.cleanup_on_failure ?? false;
  const verifyDeprovision = opts.verify_deprovision ?? true;
  const verifyBackupIndexContents = opts.verify_backup_index_contents ?? true;
  const verifyCopyBetweenProjects = opts.verify_copy_between_projects ?? true;
  const verifyMoveRestoreOnSecondHost =
    opts.verify_move_restore_on_second_host ?? true;
  const verifyWorkspaceSsh = opts.verify_workspace_ssh ?? true;
  const verifyWorkspaceProxy = opts.verify_workspace_proxy ?? true;
  const strictMoveFileCheck = opts.strict_move_file_check ?? false;
  const proxyPort = 8765;
  const proxyTestDir = "smoke-self-host-proxy";
  const secondVmName = verifyMoveRestoreOnSecondHost
    ? `${vmName}-dest`
    : undefined;
  const waitSshReady = resolveWait(opts.wait?.ssh_ready, DEFAULT_SSH_READY_WAIT);
  const waitHostRunning = resolveWait(
    opts.wait?.host_running,
    DEFAULT_HOST_RUNNING_WAIT,
  );
  const waitBackupIndexed = resolveWait(
    opts.wait?.backup_indexed,
    DEFAULT_BACKUP_INDEXED_WAIT,
  );
  const waitCopyCompleted = resolveWait(
    opts.wait?.copy_completed,
    DEFAULT_COPY_COMPLETED_WAIT,
  );
  const waitHostDeprovisioned = resolveWait(
    opts.wait?.host_deprovisioned,
    DEFAULT_HOST_DEPROVISIONED_WAIT,
  );
  const waitMoveCompleted = resolveWait(
    opts.wait?.move_completed,
    DEFAULT_MOVE_COMPLETED_WAIT,
  );
  const waitRestoredFile = resolveWait(
    opts.wait?.restored_file,
    DEFAULT_RESTORED_FILE_WAIT,
  );
  const waitWindowMs = (w: WaitOptions) => w.attempts * w.intervalMs;
  const maxWaitCandidates = [
    waitWindowMs(waitSshReady),
    waitWindowMs(waitHostRunning),
    waitWindowMs(waitBackupIndexed),
  ];
  if (verifyCopyBetweenProjects || verifyMoveRestoreOnSecondHost) {
    maxWaitCandidates.push(waitWindowMs(waitRestoredFile));
  }
  if (verifyCopyBetweenProjects) {
    maxWaitCandidates.push(waitWindowMs(waitCopyCompleted));
  }
  if (verifyDeprovision) {
    maxWaitCandidates.push(waitWindowMs(waitHostDeprovisioned));
  }
  if (verifyMoveRestoreOnSecondHost) {
    maxWaitCandidates.push(waitWindowMs(waitMoveCompleted));
  }
  const maxWaitMs = Math.max(...maxWaitCandidates);
  const cli: CliContext = {
    nodePath: process.execPath,
    cliPath: resolveCliPath(opts.cocalc_cli_path),
    apiUrl: resolveApiUrl(opts.api_url),
    hubPassword: resolveHubPassword(opts.hub_password),
    accountId: account_id || undefined,
    timeoutMs: Math.max(maxWaitMs + 60_000, 180_000),
    pollMs: 1_000,
  };

  const tempDirs: string[] = [];
  const createdVmNames: string[] = [];
  const cleanupHostIds = new Set<string>();
  const cleanupProjectIds = new Set<string>();
  const smokeTmpBase = join(homedir(), "cocalc-smoke-runner");
  let vmIp: string | undefined;
  let sshTarget: string | undefined;
  let secondVmIp: string | undefined;
  let secondSshTarget: string | undefined;
  let host_id: string | undefined;
  let second_host_id: string | undefined;
  let project_id: string | undefined;
  let copy_project_id: string | undefined;
  let backup_id: string | undefined;
  let backup_indexed = false;
  let backup_op_id: string | undefined;
  let copy_op_id: string | undefined;
  let move_op_id: string | undefined;
  let restore_op_id: string | undefined;
  let proxy_token: string | undefined;
  let proxy_api_key_id: number | undefined;
  let proxy_api_key_secret: string | undefined;
  let workspaceFileTempDir: string | undefined;
  const sentinelPath = "smoke-self-host-backup/self-host-backup.txt";
  const sentinelValue = `self-host-smoke:${Date.now()}:${randomUUID()}`;
  const copyDestPath = "copied-from-project-1.txt";
  const proxyExpectedBody = `proxy-self-host-smoke:${randomUUID()}`;
  const debug_hints = {
    host_log: "/mnt/cocalc/data/log",
    project_host_log: "/home/cocalc-host/cocalc-host/bootstrap/bootstrap.log",
    backup_log: "/mnt/cocalc/data/log",
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

  const runWorkspaceExec = async (
    workspaceId: string,
    args: string[],
    opts: { timeoutSeconds?: number; bash?: boolean } = {},
  ): Promise<{ stdout?: string; stderr?: string; exit_code?: number }> => {
    const execTimeoutSeconds = opts.timeoutSeconds ?? 60;
    const cmd = [
      "workspace",
      "exec",
      "--workspace",
      workspaceId,
      "--timeout",
      String(execTimeoutSeconds),
    ];
    if (opts.bash) {
      cmd.push("--bash");
    }
    cmd.push("--", ...args);
    return await runCli<{ stdout?: string; stderr?: string; exit_code?: number }>(
      cli,
      cmd,
      {
        timeoutSeconds: execTimeoutSeconds + 15,
        commandTimeoutMs: Math.max((execTimeoutSeconds + 45) * 1000, 120_000),
      },
    );
  };

  const runWorkspaceSshCheck = async (
    workspaceId: string,
    opts: { attempts?: number; intervalMs?: number } = {},
  ): Promise<void> => {
    const attempts = Math.max(1, opts.attempts ?? 20);
    const intervalMs = Math.max(250, opts.intervalMs ?? 2000);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await runCli<{ checked?: boolean; exit_code?: number }>(
          cli,
          [
            "workspace",
            "ssh",
            "--workspace",
            workspaceId,
            "--check",
            "--require-auth",
          ],
          {
            timeoutSeconds: 30,
            commandTimeoutMs: 45_000,
          },
        );
        return;
      } catch (err) {
        lastErr = err;
        if (attempt >= attempts) {
          throw err;
        }
        logger.debug("self-host smoke workspace ssh check retry", {
          workspace_id: workspaceId,
          attempt,
          attempts,
          err: getErrorMessage(err),
        });
        await sleep(intervalMs);
      }
    }
    throw new Error(
      `workspace ssh check did not succeed: ${getErrorMessage(lastErr ?? "unknown error")}`,
    );
  };

  const runWorkspaceSshExecCheck = async (
    workspaceId: string,
    opts: { attempts?: number; intervalMs?: number } = {},
  ): Promise<void> => {
    const attempts = Math.max(1, opts.attempts ?? 20);
    const intervalMs = Math.max(250, opts.intervalMs ?? 2000);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await runCli<{ exit_code?: number }>(
          cli,
          ["workspace", "ssh", "--workspace", workspaceId, "--", "true"],
          {
            timeoutSeconds: 45,
            commandTimeoutMs: 60_000,
          },
        );
        return;
      } catch (err) {
        lastErr = err;
        if (attempt >= attempts) {
          throw err;
        }
        logger.debug("self-host smoke workspace ssh exec retry", {
          workspace_id: workspaceId,
          attempt,
          attempts,
          err: getErrorMessage(err),
        });
        await sleep(intervalMs);
      }
    }
    throw new Error(
      `workspace ssh command did not succeed: ${getErrorMessage(lastErr ?? "unknown error")}`,
    );
  };

  const runWorkspaceProxyCurlWithRetry = async (
    workspaceId: string,
    opts: {
      expect: "ok" | "denied" | "any";
      token?: string;
      apiKey?: string;
      attempts?: number;
      intervalMs?: number;
    },
  ): Promise<{ status: number; body_preview?: string; url?: string }> => {
    const attempts = Math.max(1, opts.attempts ?? 20);
    const intervalMs = Math.max(250, opts.intervalMs ?? 2000);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const args: string[] = [];
        if (opts.apiKey) {
          args.push("--api-key", opts.apiKey);
        }
        args.push(
          "workspace",
          "proxy",
          "curl",
          "--workspace",
          workspaceId,
          "--port",
          String(proxyPort),
          "--path",
          "index.html",
          "--expect",
          opts.expect,
        );
        if (opts.token) {
          args.push("--token", opts.token);
        }
        return await runCli<{ status: number; body_preview?: string; url?: string }>(cli, args, {
          timeoutSeconds: 30,
          commandTimeoutMs: 60_000,
        });
      } catch (err) {
        lastErr = err;
        if (attempt >= attempts) {
          throw err;
        }
        logger.debug("self-host smoke workspace proxy curl retry", {
          workspace_id: workspaceId,
          expect: opts.expect,
          attempt,
          attempts,
          err: getErrorMessage(err),
        });
        await sleep(intervalMs);
      }
    }
    throw new Error(
      `workspace proxy curl did not succeed: ${getErrorMessage(lastErr ?? "unknown error")}`,
    );
  };

  const runWorkspaceExecWithRetry = async (
    workspaceId: string,
    args: string[],
    opts: { timeoutSeconds?: number; bash?: boolean; attempts?: number; intervalMs?: number } = {},
  ): Promise<{ stdout?: string; stderr?: string; exit_code?: number }> => {
    const attempts = Math.max(1, opts.attempts ?? 20);
    const intervalMs = Math.max(250, opts.intervalMs ?? 2000);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await runWorkspaceExec(workspaceId, args, opts);
      } catch (err) {
        lastErr = err;
        const message = getErrorMessage(err);
        const retryable =
          message.includes("subject:project.") ||
          message.includes("timeout - Error: operation has timed out");
        if (!retryable || attempt >= attempts) {
          throw err;
        }
        logger.debug("self-host smoke workspace exec retry", {
          workspace_id: workspaceId,
          attempt,
          attempts,
          err: message,
        });
        await sleep(intervalMs);
      }
    }
    throw new Error(
      `workspace exec did not become ready: ${getErrorMessage(lastErr ?? "unknown error")}`,
    );
  };

  const runWorkspaceFileCommandWithRetry = async <T>(
    args: string[],
    opts: { timeoutSeconds?: number; attempts?: number; intervalMs?: number; commandTimeoutMs?: number } = {},
  ): Promise<T> => {
    const attempts = Math.max(1, opts.attempts ?? 20);
    const intervalMs = Math.max(250, opts.intervalMs ?? 2000);
    const timeoutSeconds = Math.max(1, opts.timeoutSeconds ?? 60);
    const commandTimeoutMs =
      opts.commandTimeoutMs ??
      Math.max((timeoutSeconds + 45) * 1000, 120_000);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await runCli<T>(cli, ["workspace", "file", ...args], {
          timeoutSeconds,
          commandTimeoutMs,
        });
      } catch (err) {
        lastErr = err;
        const message = getErrorMessage(err);
        const retryable =
          message.includes("subject:project.") ||
          message.includes("timeout - Error: operation has timed out");
        if (!retryable || attempt >= attempts) {
          throw err;
        }
        logger.debug("self-host smoke workspace file retry", {
          args,
          attempt,
          attempts,
          err: message,
        });
        await sleep(intervalMs);
      }
    }
    throw new Error(
      `workspace file command did not become ready: ${getErrorMessage(lastErr ?? "unknown error")}`,
    );
  };

  const ensureWorkspaceFileTempDir = async (): Promise<string> => {
    if (workspaceFileTempDir) {
      return workspaceFileTempDir;
    }
    await mkdir(smokeTmpBase, { recursive: true });
    workspaceFileTempDir = await mkdtemp(join(smokeTmpBase, "cocalc-smoke-workspace-file-"));
    tempDirs.push(workspaceFileTempDir);
    return workspaceFileTempDir;
  };

  const writeWorkspaceFile = async (
    workspaceId: string,
    path: string,
    value: string,
  ): Promise<void> => {
    const tempDir = await ensureWorkspaceFileTempDir();
    const localPath = join(tempDir, `${Date.now()}-${randomUUID()}.txt`);
    await writeFile(localPath, value, "utf8");
    try {
      await runWorkspaceFileCommandWithRetry(
        ["put", "--workspace", workspaceId, localPath, path],
        {
          timeoutSeconds: 120,
          attempts: 30,
          intervalMs: 2000,
          commandTimeoutMs: 180_000,
        },
      );
    } finally {
      try {
        await rm(localPath, { force: true });
      } catch {
        // ignore cleanup errors for temp files
      }
    }
  };

  const cleanup = async () => {
    if (proxy_api_key_id != null) {
      try {
        await runCli(cli, ["account", "api-key", "delete", String(proxy_api_key_id)]);
      } catch (err) {
        logger.warn("self-host smoke cleanup api key failed", {
          api_key_id: proxy_api_key_id,
          err: getErrorMessage(err),
        });
      }
    }
    for (const cleanupProjectId of cleanupProjectIds) {
      try {
        await runCli(cli, [
          "workspace",
          "delete",
          "--workspace",
          cleanupProjectId,
          "--hard",
          "--purge-backups-now",
          "--yes",
          "--wait",
        ]);
      } catch (err) {
        logger.warn("self-host smoke cleanup project failed", {
          project_id: cleanupProjectId,
          err: getErrorMessage(err),
        });
      }
    }
    for (const cleanupHostId of cleanupHostIds) {
      try {
        await runCli(cli, ["host", "delete", cleanupHostId, "--skip-backups"]);
      } catch (err) {
        logger.warn("self-host smoke cleanup host failed", {
          host_id: cleanupHostId,
          err: getErrorMessage(err),
        });
      }
    }
    for (const name of createdVmNames) {
      await cleanupMultipassVm(name);
    }
  };

  try {
    let sshPublicKey = "";
    await runStep("preflight", async () => {
      await requireCommand("multipass");
      await requireCommand("ssh");
      await requireCommand("node");
      await cleanupExistingSmokeVms();
      sshPublicKey = await resolveSshPublicKey(opts.ssh_public_key_path);
      account_id = await resolveSmokeAccountId(cli, opts.account_id);
      cli.accountId = account_id;
    });

    await runStep("launch_multipass_vm", async () => {
      const launched = await launchMultipassVm({
        vmName,
        vmImage,
        vmUser,
        vmCpus,
        vmMemoryGb,
        vmDiskGb,
        sshPublicKey,
        tempRoot: smokeTmpBase,
        tempDirs,
      });
      vmIp = launched.vmIp;
      sshTarget = launched.sshTarget;
      createdVmNames.push(vmName);
    });

    await runStep("wait_ssh_ready", async () => {
      if (!sshTarget) throw new Error("missing ssh target");
      await waitForSshReady({ sshTarget, wait: waitSshReady });
    });

    await runStep("create_self_host_record", async () => {
      if (!sshTarget) throw new Error("missing ssh target");
      const host = await runCli<{ host_id: string }>(cli, [
        "host",
        "create-self",
        `Self-host smoke ${vmName}`,
        "--ssh-target",
        sshTarget,
        "--region",
        "pending",
        "--size",
        "custom",
        "--cpu",
        String(vmCpus),
        "--ram-gb",
        String(vmMemoryGb),
        "--disk-gb",
        String(vmDiskGb),
      ]);
      host_id = host.host_id;
      cleanupHostIds.add(host.host_id);
    });

    await runStep("start_host", async () => {
      if (!host_id) throw new Error("missing host_id");
      await runCli(cli, ["host", "start", host_id, "--wait"]);
      await waitForHostStatus({
        cli,
        host_id,
        allowed: ["running", "active"],
        wait: waitHostRunning,
      });
    });

    if (verifyMoveRestoreOnSecondHost) {
      await runStep("launch_second_multipass_vm", async () => {
        if (!secondVmName) throw new Error("missing second vm name");
        const launched = await launchMultipassVm({
          vmName: secondVmName,
          vmImage,
          vmUser,
          vmCpus,
          vmMemoryGb,
          vmDiskGb,
          sshPublicKey,
          tempRoot: smokeTmpBase,
          tempDirs,
        });
        secondVmIp = launched.vmIp;
        secondSshTarget = launched.sshTarget;
        createdVmNames.push(secondVmName);
      });

      await runStep("wait_second_ssh_ready", async () => {
        if (!secondSshTarget) throw new Error("missing second ssh target");
        await waitForSshReady({ sshTarget: secondSshTarget, wait: waitSshReady });
      });

      await runStep("create_second_self_host_record", async () => {
        if (!secondSshTarget || !secondVmName) {
          throw new Error("missing second host context");
        }
        const host = await runCli<{ host_id: string }>(cli, [
          "host",
          "create-self",
          `Self-host smoke ${secondVmName}`,
          "--ssh-target",
          secondSshTarget,
          "--region",
          "pending",
          "--size",
          "custom",
          "--cpu",
          String(vmCpus),
          "--ram-gb",
          String(vmMemoryGb),
          "--disk-gb",
          String(vmDiskGb),
        ]);
        second_host_id = host.host_id;
        cleanupHostIds.add(host.host_id);
      });

      await runStep("start_second_host", async () => {
        if (!second_host_id) throw new Error("missing second_host_id");
        await runCli(cli, ["host", "start", second_host_id, "--wait"]);
        await waitForHostStatus({
          cli,
          host_id: second_host_id,
          allowed: ["running", "active"],
          wait: waitHostRunning,
        });
      });
    }

    await runStep("create_project", async () => {
      if (!host_id) throw new Error("missing host_id");
      const workspace = await runCli<{ workspace_id: string }>(cli, [
        "workspace",
        "create",
        `self-host backup smoke ${vmName}`,
        "--host",
        host_id,
      ]);
      project_id = workspace.workspace_id;
      if (!project_id) throw new Error("failed to create project");
      cleanupProjectIds.add(project_id);
    });

    await runStep("start_project", async () => {
      if (!project_id) throw new Error("missing project_id");
      await runCli(cli, ["workspace", "start", "--workspace", project_id, "--wait"]);
    });

    await runStep("write_sentinel_file", async () => {
      if (!project_id) throw new Error("missing project_id");
      await writeWorkspaceFile(project_id, sentinelPath, sentinelValue);
    });

    if (verifyWorkspaceSsh) {
      await runStep("verify_workspace_ssh_check", async () => {
        if (!project_id) throw new Error("missing project_id");
        await runWorkspaceSshCheck(project_id, { attempts: 30, intervalMs: 2000 });
      });
      await runStep("verify_workspace_ssh_exec", async () => {
        if (!project_id) throw new Error("missing project_id");
        await runWorkspaceSshExecCheck(project_id, { attempts: 20, intervalMs: 2000 });
      });
      await runStep("verify_workspace_ssh_route", async () => {
        if (!project_id || !host_id) {
          throw new Error("missing workspace ssh route context");
        }
        await assertWorkspaceSshRouteMatchesLocalTunnel({
          cli,
          workspaceId: project_id,
          hostId: host_id,
        });
      });
    }

    if (verifyWorkspaceProxy) {
      await runStep("create_account_api_key_for_proxy", async () => {
        const key = await runCli<{
          id?: number;
          secret?: string;
        }>(cli, [
          "account",
          "api-key",
          "create",
          "--name",
          `smoke-proxy-${vmName}`,
          "--expire-seconds",
          "1800",
        ]);
        const id = Number(key.id);
        const secret = `${key.secret ?? ""}`.trim();
        if (!Number.isInteger(id) || id <= 0 || !secret) {
          throw new Error("proxy api key creation did not return id+secret");
        }
        proxy_api_key_id = id;
        proxy_api_key_secret = secret;
      });

      await runStep("start_workspace_proxy_server", async () => {
        if (!project_id) throw new Error("missing project_id");
        const command = `
set -e
dir=${quoteShellSingle(proxyTestDir)}
mkdir -p "$dir"
printf %s ${quoteShellSingle(proxyExpectedBody)} > "$dir/index.html"
if [ -f "$dir/server.pid" ]; then
  kill "$(cat "$dir/server.pid")" >/dev/null 2>&1 || true
fi
if command -v python3 >/dev/null 2>&1; then
  nohup python3 -m http.server ${proxyPort} --bind 127.0.0.1 --directory "$dir" >/tmp/cocalc-smoke-proxy.log 2>&1 < /dev/null &
elif command -v node >/dev/null 2>&1; then
  nohup node -e "require('http').createServer((req,res)=>res.end(${JSON.stringify(
    proxyExpectedBody,
  )})).listen(${proxyPort}, '127.0.0.1')" >/tmp/cocalc-smoke-proxy.log 2>&1 < /dev/null &
else
  echo "no runtime available for proxy smoke server" >&2
  exit 1
fi
echo $! > "$dir/server.pid"
`;
        const result = await runWorkspaceExecWithRetry(project_id, [command], {
          timeoutSeconds: 120,
          bash: true,
          attempts: 30,
          intervalMs: 2000,
        });
        const exitCode = Number(result?.exit_code ?? 1);
        if (exitCode !== 0) {
          throw new Error(`failed to start proxy server in workspace: exit_code=${exitCode}`);
        }
      });

      await runStep("verify_workspace_proxy_denied_without_token", async () => {
        if (!project_id || !proxy_api_key_secret) throw new Error("missing project_id");
        await runWorkspaceProxyCurlWithRetry(project_id, {
          expect: "denied",
          apiKey: proxy_api_key_secret,
          attempts: 25,
          intervalMs: 2000,
        });
      });

      await runStep("issue_workspace_proxy_token", async () => {
        if (!project_id || !host_id) {
          throw new Error("missing proxy token context");
        }
        const token = await runCli<{
          token: string;
          host_id: string;
          workspace_id?: string | null;
          expires_at?: number;
        }>(cli, [
          "host",
          "issue-http-token",
          "--host",
          host_id,
          "--workspace",
          project_id,
          "--ttl",
          "600",
        ]);
        proxy_token = token.token;
      });

      await runStep("verify_workspace_proxy_ok_with_token", async () => {
        if (!project_id || !proxy_token || !proxy_api_key_secret) {
          throw new Error("missing proxy verification context");
        }
        const result = await runWorkspaceProxyCurlWithRetry(project_id, {
          expect: "any",
          token: proxy_token,
          apiKey: proxy_api_key_secret,
          attempts: 25,
          intervalMs: 2000,
        });
        if (result.status >= 200 && result.status < 300) {
          if (!String(result.body_preview ?? "").includes(proxyExpectedBody)) {
            throw new Error("proxy response did not include expected smoke body");
          }
          return;
        }
        if (result.status === 502) {
          // Token auth was accepted and request reached upstream proxying; this
          // environment can still produce 502 when no long-lived app is bound.
          return;
        }
        throw new Error(`unexpected proxy status with token: ${result.status}`);
      });
    }

    if (verifyCopyBetweenProjects) {
      await runStep("create_second_project_for_copy", async () => {
        if (!host_id) throw new Error("missing host_id");
        const workspace = await runCli<{ workspace_id: string }>(cli, [
          "workspace",
          "create",
          `self-host copy smoke ${vmName}`,
          "--host",
          host_id,
        ]);
        copy_project_id = workspace.workspace_id;
        if (!copy_project_id) {
          throw new Error("failed to create copy destination project");
        }
        cleanupProjectIds.add(copy_project_id);
      });

      await runStep("start_second_project_for_copy", async () => {
        if (!copy_project_id) throw new Error("missing copy_project_id");
        await runCli(cli, [
          "workspace",
          "start",
          "--workspace",
          copy_project_id,
          "--wait",
        ]);
      });
      if (!verifyMoveRestoreOnSecondHost) {
        await runStep("copy_file_between_projects", async () => {
          if (!project_id || !copy_project_id) {
            throw new Error("missing cross-project copy context");
          }
          const op = await runCli<{ op_id?: string }>(cli, [
            "workspace",
            "copy-path",
            "--src-workspace",
            project_id,
            "--src",
            sentinelPath,
            "--dest-workspace",
            copy_project_id,
            "--dest",
            copyDestPath,
            "--wait",
          ]);
          copy_op_id = op.op_id;
        });

        await runStep("verify_copied_file_in_second_project", async () => {
          if (!copy_project_id) throw new Error("missing copy_project_id");
          await waitForProjectFileValue({
            cli,
            project_id: copy_project_id,
            path: copyDestPath,
            expected: sentinelValue,
            wait: waitRestoredFile,
          });
        });

        await runStep("delete_second_project_for_copy", async () => {
          if (!copy_project_id) return;
          await runCli(cli, [
            "workspace",
            "delete",
            "--workspace",
            copy_project_id,
            "--hard",
            "--purge-backups-now",
            "--yes",
            "--wait",
          ]);
          cleanupProjectIds.delete(copy_project_id);
        });
      }
    }

    await runStep("create_backup", async () => {
      if (!project_id) throw new Error("missing project_id");
      const op = await runCli<{ op_id?: string }>(cli, [
        "workspace",
        "backup",
        "create",
        "--workspace",
        project_id,
      ]);
      backup_op_id = op.op_id;
    });

    await runStep("wait_backup_indexed", async () => {
      if (!project_id) throw new Error("missing project_id");
      const backup = await waitForBackupIndexed({
        cli,
        project_id,
        wait: waitBackupIndexed,
      });
      backup_id = backup.id;
      backup_indexed = backup.indexed;
    });

    if (verifyBackupIndexContents) {
      await runStep("verify_backup_index_contents", async () => {
        if (!project_id || !backup_id) {
          throw new Error("missing backup context");
        }
        if (!backup_indexed) {
          logger.warn(
            "self-host smoke backup index check skipped because indexed snapshot is unavailable",
            { project_id, backup_id },
          );
          return;
        }
        const children = await runCli<Array<{ name?: string }>>(cli, [
          "workspace",
          "backup",
          "files",
          "--workspace",
          project_id,
          "--backup-id",
          backup_id,
          "--path",
          dirname(sentinelPath),
        ]);
        const found = children.some((entry) =>
          String(entry?.name ?? "").includes("self-host-backup.txt"),
        );
        if (!found) {
          throw new Error("backup index did not include sentinel file");
        }
      });
    }

    if (verifyMoveRestoreOnSecondHost) {
      await runStep("move_project_to_second_host", async () => {
        if (!project_id || !second_host_id) {
          throw new Error("missing move context");
        }
        const op = await runCli<{ op_id?: string }>(cli, [
          "workspace",
          "move",
          "--workspace",
          project_id,
          "--host",
          second_host_id,
          "--wait",
        ]);
        move_op_id = op.op_id;
        await waitForProjectPlacement({
          cli,
          project_id,
          host_id: second_host_id,
          wait: waitMoveCompleted,
        });
      });

    await runStep("verify_project_file_after_move", async () => {
      if (!project_id) throw new Error("missing project_id");
      const moveFileWait = strictMoveFileCheck
        ? waitRestoredFile
        : { intervalMs: 2000, attempts: 12 };
      try {
        await waitForProjectFileValue({
          cli,
          project_id,
          path: sentinelPath,
          expected: sentinelValue,
          wait: moveFileWait,
          execTimeoutSeconds: strictMoveFileCheck ? 30 : 10,
          commandTimeoutMs: strictMoveFileCheck ? 120_000 : 30_000,
        });
      } catch (err) {
        if (strictMoveFileCheck) {
          throw err;
          }
          logger.warn(
            "self-host smoke move file check failed; continuing with backup restore verification",
            {
              project_id,
              path: sentinelPath,
              err: getErrorMessage(err),
            },
          );
        }
      });

      await runStep("restore_backup_on_second_host", async () => {
        if (!project_id || !backup_id) {
          throw new Error("missing restore context");
        }
        const op = await runCli<{ op_id?: string }>(cli, [
          "workspace",
          "backup",
          "restore",
          "--workspace",
          project_id,
          "--backup-id",
          backup_id,
          "--wait",
        ]);
        restore_op_id = op.op_id;
      });

      await runStep("verify_restored_file_on_second_host", async () => {
        if (!project_id) throw new Error("missing project_id");
        await waitForProjectFileValue({
          cli,
          project_id,
          path: sentinelPath,
          expected: sentinelValue,
          wait: waitRestoredFile,
        });
      });

      await runStep("create_backup_for_copy_source", async () => {
        if (!project_id) throw new Error("missing project_id");
        await runCli(cli, [
          "workspace",
          "backup",
          "create",
          "--workspace",
          project_id,
          "--wait",
        ]);
      });

      await runStep("wait_backup_indexed_for_copy_source", async () => {
        if (!project_id) throw new Error("missing project_id");
        await waitForBackupIndexed({
          cli,
          project_id,
          wait: waitBackupIndexed,
        });
      });

      if (verifyCopyBetweenProjects) {
        await runStep("copy_file_between_projects", async () => {
          if (!project_id || !copy_project_id) {
            throw new Error("missing cross-host copy context");
          }
          const op = await runCli<{ op_id?: string }>(cli, [
            "workspace",
            "copy-path",
            "--src-workspace",
            project_id,
            "--src",
            sentinelPath,
            "--dest-workspace",
            copy_project_id,
            "--dest",
            copyDestPath,
            "--wait",
          ]);
          copy_op_id = op.op_id;
        });

        await runStep("verify_copied_file_in_second_project", async () => {
          if (!copy_project_id) throw new Error("missing copy_project_id");
          await waitForProjectFileValue({
            cli,
            project_id: copy_project_id,
            path: copyDestPath,
            expected: sentinelValue,
            wait: waitRestoredFile,
          });
        });

        await runStep("delete_second_project_for_copy", async () => {
          if (!copy_project_id) return;
          await runCli(cli, [
            "workspace",
            "delete",
            "--workspace",
            copy_project_id,
            "--hard",
            "--purge-backups-now",
            "--yes",
            "--wait",
          ]);
          cleanupProjectIds.delete(copy_project_id);
        });
      }
    }

    if (verifyDeprovision) {
      await runStep("deprovision_hosts", async () => {
        const hostIds = [second_host_id, host_id].filter(Boolean) as string[];
        for (const id of hostIds) {
          await runCli(cli, ["host", "delete", id, "--skip-backups", "--wait"]);
          cleanupHostIds.delete(id);
        }
      });
    }

    if (cleanupOnSuccess) {
      await runStep("cleanup", async () => {
        await cleanup();
      });
    }

    return {
      ok: true,
      account_id,
      vm_name: vmName,
      vm_ip: vmIp,
      ssh_target: sshTarget,
      host_id,
      second_vm_name: secondVmName,
      second_vm_ip: secondVmIp,
      second_ssh_target: secondSshTarget,
      second_host_id,
      project_id,
      copy_project_id,
      backup_id,
      backup_op_id,
      copy_op_id,
      copy_dest_path: copyDestPath,
      move_op_id,
      restore_op_id,
      sentinel_path: sentinelPath,
      sentinel_value: sentinelValue,
      steps,
      debug_hints,
    };
  } catch (err) {
    const message = getErrorMessage(err);
    if (cleanupOnFailure) {
      await cleanup();
    }
    return {
      ok: false,
      account_id,
      vm_name: vmName,
      vm_ip: vmIp,
      ssh_target: sshTarget,
      host_id,
      second_vm_name: secondVmName,
      second_vm_ip: secondVmIp,
      second_ssh_target: secondSshTarget,
      second_host_id,
      project_id,
      copy_project_id,
      backup_id,
      backup_op_id,
      copy_op_id,
      copy_dest_path: copyDestPath,
      move_op_id,
      restore_op_id,
      sentinel_path: sentinelPath,
      sentinel_value: sentinelValue,
      steps,
      error: message,
      debug_hints,
    };
  } finally {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
