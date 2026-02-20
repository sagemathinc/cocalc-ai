/**
 * Workspace SSH/sync backend primitives.
 *
 * This module provides sync-key lifecycle, workspace SSH route resolution, and
 * reflect-sync forward helpers shared by host/workspace command handlers.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

import type { WorkspaceSshConnectionInfo } from "@cocalc/conat/hub/api/projects";

export type CommandCaptureResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type SyncKeyInfo = {
  private_key_path: string;
  public_key_path: string;
  public_key: string;
  created: boolean;
};

type WorkspaceLike = {
  project_id: string;
  title: string;
  host_id: string | null;
};

export type WorkspaceSshTarget<Workspace extends WorkspaceLike = WorkspaceLike> = {
  workspace: Workspace;
  ssh_server: string;
  ssh_host: string;
  ssh_port: number | null;
  ssh_target: string;
};

export type WorkspaceSshRoute<Workspace extends WorkspaceLike = WorkspaceLike> = {
  workspace: Workspace;
  host_id: string;
  transport: "cloudflare-access-tcp" | "direct";
  ssh_username: string;
  ssh_server: string | null;
  cloudflare_hostname: string | null;
  ssh_host: string | null;
  ssh_port: number | null;
};

export type ReflectForwardRecord = {
  id: number;
  name?: string | null;
  direction?: "local_to_remote" | "remote_to_local";
  ssh_host: string;
  ssh_port?: number | null;
  local_host: string;
  local_port: number;
  remote_host: string;
  remote_port: number;
  desired_state?: string;
  actual_state?: string;
  monitor_pid?: number | null;
  last_error?: string | null;
  ssh_args?: string | null;
};

type WorkspaceSyncOpsDeps<Ctx, Workspace extends WorkspaceLike> = {
  resolveWorkspaceFilesystem: (
    ctx: Ctx,
    workspaceIdentifier?: string,
    cwd?: string,
  ) => Promise<{ workspace: Workspace; fs: any }>;
  resolveWorkspaceFromArgOrContext: (
    ctx: Ctx,
    workspaceIdentifier?: string,
    cwd?: string,
  ) => Promise<Workspace>;
  parseSshServer: (value: string) => { host: string; port?: number | null };
  authConfigPath: () => string;
  resolveModule: (specifier: string) => string;
};

function expandUserPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed === "~") {
    return homedir();
  }
  if (trimmed.startsWith("~/")) {
    return join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function defaultSyncKeyBasePath(): string {
  return join(homedir(), ".ssh", "id_ed25519");
}

function normalizeSyncKeyBasePath(input?: string): string {
  const raw = `${input ?? ""}`.trim();
  if (!raw) {
    return defaultSyncKeyBasePath();
  }
  const expanded = expandUserPath(raw);
  if (expanded.endsWith(".pub")) {
    return expanded.slice(0, -4);
  }
  return expanded;
}

function syncKeyPublicPath(basePath: string): string {
  return `${basePath}.pub`;
}

function defaultWorkspaceSshConfigPath(): string {
  return join(homedir(), ".ssh", "config");
}

function normalizeWorkspaceSshConfigPath(input?: string): string {
  const raw = `${input ?? ""}`.trim();
  if (!raw) {
    return defaultWorkspaceSshConfigPath();
  }
  return expandUserPath(raw);
}

function normalizeWorkspaceSshHostAlias(input: string): string {
  const alias = input.trim();
  if (!alias) {
    throw new Error("ssh config host alias cannot be empty");
  }
  if (alias.includes("@")) {
    throw new Error(
      `ssh config host alias '${alias}' cannot contain '@' (ssh parses user@host); use a host-only alias, e.g. '${alias.replace(/@/g, "-")}'`,
    );
  }
  if (/\s/.test(alias)) {
    throw new Error(`ssh config host alias '${alias}' cannot contain whitespace`);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(alias)) {
    throw new Error(`ssh config host alias '${alias}' must match [a-zA-Z0-9._-]+`);
  }
  return alias;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function workspaceSshConfigBlockMarkers(alias: string): {
  start: string;
  end: string;
} {
  return {
    start: `# >>> cocalc ws ssh ${alias} >>>`,
    end: `# <<< cocalc ws ssh ${alias} <<<`,
  };
}

function removeWorkspaceSshConfigBlock(
  content: string,
  alias: string,
): { content: string; removed: boolean } {
  const { start, end } = workspaceSshConfigBlockMarkers(alias);
  const pattern = new RegExp(
    `(?:^|\\n)${escapeRegExp(start)}\\n[\\s\\S]*?\\n${escapeRegExp(end)}(?:\\n|$)`,
    "g",
  );
  const next = content.replace(pattern, "\n").replace(/\n{3,}/g, "\n\n");
  return {
    content: next,
    removed: next !== content,
  };
}

function readSyncPublicKey(basePath: string): string {
  const pubPath = syncKeyPublicPath(basePath);
  const publicKey = readFileSync(pubPath, "utf8").trim();
  if (!publicKey) {
    throw new Error(`ssh public key is empty: ${pubPath}`);
  }
  return publicKey;
}

function isNotFoundLikeError(err: unknown): boolean {
  const message = `${(err as any)?.message ?? err ?? ""}`.toLowerCase();
  return (
    message.includes("enoent") ||
    message.includes("not found") ||
    message.includes("no such file") ||
    message.includes("does not exist")
  );
}

function reflectSyncHomeDir(authConfigPathValue: string): string {
  return process.env.COCALC_REFLECT_HOME ?? join(dirname(authConfigPathValue), "reflect-sync");
}

function reflectSyncSessionDbPath(authConfigPathValue: string): string {
  return join(reflectSyncHomeDir(authConfigPathValue), "sessions.db");
}

function parseReflectForwardRows(raw: string): ReflectForwardRecord[] {
  const text = raw.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `unable to parse reflect-sync forward list JSON: ${err instanceof Error ? err.message : `${err}`}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("reflect-sync forward list did not return an array");
  }
  return parsed as ReflectForwardRecord[];
}

function parseCreatedForwardId(output: string): number | null {
  const match = output.match(/created forward\s+(\d+)/i);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

function forwardsForWorkspace(
  rows: ReflectForwardRecord[],
  workspaceId: string,
): ReflectForwardRecord[] {
  const prefix = `${workspaceId}@`;
  return rows.filter((row) => `${row.ssh_host ?? ""}`.startsWith(prefix));
}

function formatReflectForwardRow(row: ReflectForwardRecord): Record<string, unknown> {
  const sshHost = `${row.ssh_host ?? ""}`;
  const workspaceId = sshHost.includes("@") ? sshHost.split("@")[0] : null;
  const target = row.ssh_port ? `${sshHost}:${row.ssh_port}` : sshHost;
  return {
    id: row.id,
    name: row.name ?? null,
    workspace_id: workspaceId,
    direction: row.direction ?? null,
    target,
    local: `${row.local_host}:${row.local_port}`,
    remote_port: row.remote_port,
    state: row.actual_state ?? null,
    desired_state: row.desired_state ?? null,
    monitor_pid: row.monitor_pid ?? null,
    last_error: row.last_error ?? null,
  };
}

export function createWorkspaceSyncOps<Ctx, Workspace extends WorkspaceLike>(
  deps: WorkspaceSyncOpsDeps<Ctx, Workspace>,
) {
  const {
    resolveWorkspaceFilesystem,
    resolveWorkspaceFromArgOrContext,
    parseSshServer,
    authConfigPath,
    resolveModule,
  } = deps;

  async function ensureSyncKeyPair(keyPathInput?: string): Promise<SyncKeyInfo> {
    const privateKeyPath = normalizeSyncKeyBasePath(keyPathInput);
    const publicKeyPath = syncKeyPublicPath(privateKeyPath);
    const privateExists = existsSync(privateKeyPath);
    const publicExists = existsSync(publicKeyPath);
    if (privateExists && publicExists) {
      return {
        private_key_path: privateKeyPath,
        public_key_path: publicKeyPath,
        public_key: readSyncPublicKey(privateKeyPath),
        created: false,
      };
    }
    if (privateExists !== publicExists) {
      throw new Error(
        `incomplete ssh keypair: expected both '${privateKeyPath}' and '${publicKeyPath}'`,
      );
    }

    mkdirSync(dirname(privateKeyPath), { recursive: true, mode: 0o700 });
    const comment = `cocalc-cli-sync-${hostname()}`;
    const created = spawnSync(
      "ssh-keygen",
      ["-t", "ed25519", "-f", privateKeyPath, "-N", "", "-C", comment],
      {
        encoding: "utf8",
      },
    );
    if (created.error) {
      const message = (created.error as Error).message ?? `${created.error}`;
      throw new Error(`failed to run ssh-keygen: ${message}`);
    }
    if (created.status !== 0) {
      const stderr = `${created.stderr ?? ""}`.trim();
      throw new Error(stderr || `ssh-keygen failed with exit code ${created.status}`);
    }
    if (!existsSync(privateKeyPath) || !existsSync(publicKeyPath)) {
      throw new Error("ssh-keygen completed, but key files were not created");
    }
    return {
      private_key_path: privateKeyPath,
      public_key_path: publicKeyPath,
      public_key: readSyncPublicKey(privateKeyPath),
      created: true,
    };
  }

  async function installSyncPublicKey({
    ctx,
    workspaceIdentifier,
    publicKey,
    cwd,
  }: {
    ctx: Ctx;
    workspaceIdentifier?: string;
    publicKey: string;
    cwd?: string;
  }): Promise<Record<string, unknown>> {
    const trimmedKey = publicKey.trim();
    if (!trimmedKey) {
      throw new Error("public key is empty");
    }

    const { workspace, fs } = await resolveWorkspaceFilesystem(ctx, workspaceIdentifier, cwd);
    const sshDir = ".ssh";
    const authorizedKeysPath = ".ssh/authorized_keys";
    await fs.mkdir(sshDir, { recursive: true });

    let existing = "";
    try {
      existing = String(await fs.readFile(authorizedKeysPath, "utf8"));
    } catch (err) {
      if (!isNotFoundLikeError(err)) {
        throw err;
      }
    }

    const existingKeys = existing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (existingKeys.includes(trimmedKey)) {
      return {
        workspace_id: workspace.project_id,
        workspace_title: workspace.title,
        path: authorizedKeysPath,
        installed: false,
        already_present: true,
      };
    }

    const prefix =
      existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
    const next = `${prefix}${trimmedKey}\n`;
    await fs.writeFile(authorizedKeysPath, Buffer.from(next, "utf8"));
    return {
      workspace_id: workspace.project_id,
      workspace_title: workspace.title,
      path: authorizedKeysPath,
      installed: true,
      already_present: false,
    };
  }

  async function resolveWorkspaceSshTarget(
    ctx: Ctx,
    workspaceIdentifier?: string,
    cwd = process.cwd(),
  ): Promise<WorkspaceSshTarget<Workspace>> {
    const workspace = await resolveWorkspaceFromArgOrContext(ctx, workspaceIdentifier, cwd);
    if (!workspace.host_id) {
      throw new Error("workspace has no assigned host");
    }
    const connection = await (ctx as any).hub.hosts.resolveHostConnection({
      host_id: workspace.host_id,
    });
    if (!connection.ssh_server) {
      throw new Error("host has no ssh server endpoint");
    }
    const parsed = parseSshServer(connection.ssh_server);
    const sshHost = `${workspace.project_id}@${parsed.host}`;
    const sshTarget = parsed.port != null ? `${sshHost}:${parsed.port}` : sshHost;
    return {
      workspace,
      ssh_server: connection.ssh_server,
      ssh_host: sshHost,
      ssh_port: parsed.port ?? null,
      ssh_target: sshTarget,
    };
  }

  async function resolveWorkspaceSshConnection(
    ctx: Ctx,
    workspaceIdentifier?: string,
    {
      cwd = process.cwd(),
      direct = false,
    }: {
      cwd?: string;
      direct?: boolean;
    } = {},
  ): Promise<WorkspaceSshRoute<Workspace>> {
    const workspace = await resolveWorkspaceFromArgOrContext(ctx, workspaceIdentifier, cwd);
    if (!workspace.host_id) {
      throw new Error("workspace has no assigned host");
    }
    const connection = (await (ctx as any).hub.projects.resolveWorkspaceSshConnection({
      project_id: workspace.project_id,
      direct,
    })) as WorkspaceSshConnectionInfo;
    const sshUsername =
      `${connection.ssh_username ?? workspace.project_id}`.trim() || workspace.project_id;
    if (connection.transport === "cloudflare-access-tcp") {
      const hostname = `${connection.cloudflare_hostname ?? ""}`.trim();
      if (!hostname) {
        throw new Error("workspace ssh route returned no cloudflare hostname");
      }
      return {
        workspace,
        host_id: connection.host_id,
        transport: "cloudflare-access-tcp",
        ssh_username: sshUsername,
        ssh_server: connection.ssh_server ?? null,
        cloudflare_hostname: hostname,
        ssh_host: hostname,
        ssh_port: null,
      };
    }
    const sshServer = `${connection.ssh_server ?? ""}`.trim();
    if (!sshServer) {
      throw new Error("host has no ssh server endpoint");
    }
    const parsed = parseSshServer(sshServer);
    return {
      workspace,
      host_id: connection.host_id,
      transport: "direct",
      ssh_username: sshUsername,
      ssh_server: sshServer,
      cloudflare_hostname: `${connection.cloudflare_hostname ?? ""}`.trim() || null,
      ssh_host: parsed.host,
      ssh_port: parsed.port ?? null,
    };
  }

  async function runCommandCapture(
    command: string,
    args: string[],
    {
      env,
    }: {
      env?: NodeJS.ProcessEnv;
    } = {},
  ): Promise<CommandCaptureResult> {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: env ?? process.env,
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({
          code: code ?? 1,
          stdout,
          stderr,
        });
      });
    });
  }

  function resolveReflectSyncCliEntry(): string {
    try {
      return resolveModule("reflect-sync/cli");
    } catch {
      throw new Error(
        "reflect-sync is not installed in @cocalc/cli (add it to dependencies and run pnpm install)",
      );
    }
  }

  async function runReflectSyncCli(args: string[]): Promise<CommandCaptureResult> {
    const authConfigPathValue = authConfigPath();
    const reflectHome = reflectSyncHomeDir(authConfigPathValue);
    mkdirSync(reflectHome, { recursive: true, mode: 0o700 });
    const cliEntry = resolveReflectSyncCliEntry();
    const result = await runCommandCapture(
      process.execPath,
      [
        cliEntry,
        "--log-level",
        "error",
        "--session-db",
        reflectSyncSessionDbPath(authConfigPathValue),
        ...args,
      ],
      {
        env: {
          ...process.env,
          REFLECT_HOME: reflectHome,
        },
      },
    );
    if (result.code !== 0) {
      const message = result.stderr.trim() || result.stdout.trim();
      throw new Error(message || `reflect-sync exited with code ${result.code}`);
    }
    return result;
  }

  async function listReflectForwards(): Promise<ReflectForwardRecord[]> {
    const result = await runReflectSyncCli(["forward", "list", "--json"]);
    return parseReflectForwardRows(result.stdout);
  }

  async function terminateReflectForwards(forwardRefs: string[]): Promise<void> {
    if (!forwardRefs.length) return;
    await runReflectSyncCli(["forward", "terminate", ...forwardRefs]);
  }

  return {
    expandUserPath,
    normalizeSyncKeyBasePath,
    syncKeyPublicPath,
    normalizeWorkspaceSshConfigPath,
    normalizeWorkspaceSshHostAlias,
    workspaceSshConfigBlockMarkers,
    removeWorkspaceSshConfigBlock,
    readSyncPublicKey,
    ensureSyncKeyPair,
    installSyncPublicKey,
    resolveWorkspaceSshTarget,
    resolveWorkspaceSshConnection,
    runCommandCapture,
    runReflectSyncCli,
    listReflectForwards,
    parseCreatedForwardId,
    forwardsForWorkspace,
    formatReflectForwardRow,
    terminateReflectForwards,
    reflectSyncHomeDir: () => reflectSyncHomeDir(authConfigPath()),
    reflectSyncSessionDbPath: () => reflectSyncSessionDbPath(authConfigPath()),
  };
}
