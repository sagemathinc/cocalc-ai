import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";

type SshExecOptions = {
  inherit?: boolean;
  timeoutMs?: number;
  extraArgs?: string[];
};

export type SshOptions = {
  host: string;
  port: number | null;
  identity?: string;
  proxyJump?: string;
  sshArgs: string[];
};

export type RegistryEntry = {
  target: string;
  host?: string;
  port?: number | null;
  localPort?: number;
  lastUsed?: string;
  lastStopped?: string;
  identity?: string;
  proxyJump?: string;
  sshArgs?: string[];
};

export type ConnectionInfo = {
  port: number;
  token?: string;
  [key: string]: unknown;
};

export type ConnectOptions = {
  localPort?: string;
  remotePort?: string;
  noOpen?: boolean;
  noInstall?: boolean;
  upgrade?: boolean;
  forwardOnly?: boolean;
  identity?: string;
  proxyJump?: string;
  logLevel?: string;
  sshArg?: string[];
  localUrl?: string;
  waitForReady?: boolean;
  readyTimeoutMs?: number;
};

export type ConnectResult = {
  url: string;
  localPort: number;
  remotePort: number;
  info: ConnectionInfo;
  tunnel: ChildProcess;
};

export function parseTarget(raw: string) {
  const m = raw.match(/^(.*?)(?::(\d+))?$/);
  if (!m) throw new Error(`Invalid target: ${raw}`);
  return { host: m[1], port: m[2] ? parseInt(m[2], 10) : null };
}

export function infoPathFor(target: string) {
  const hash = crypto.createHash("sha1").update(target).digest("hex");
  const baseDir = path.join(
    os.homedir(),
    ".local",
    "share",
    "cocalc-plus",
    "ssh",
  );
  return {
    hash,
    baseDir,
    localDir: path.join(baseDir, hash),
    remoteDir: `$HOME/.local/share/cocalc-plus/ssh/${hash}`,
  };
}

export function registryPath() {
  return path.join(
    os.homedir(),
    ".local",
    "share",
    "cocalc-plus",
    "ssh",
    "registry.json",
  );
}

export function loadRegistry(): Record<string, RegistryEntry> {
  const file = registryPath();
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const obj: Record<string, RegistryEntry> = {};
      for (const entry of parsed) {
        if (entry?.target) obj[entry.target] = entry;
      }
      return obj;
    }
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // ignore
  }
  return {};
}

export function saveRegistry(registry: Record<string, RegistryEntry>) {
  const file = registryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(registry, null, 2));
}

export function updateRegistry(target: string, data: Partial<RegistryEntry>) {
  const registry = loadRegistry();
  registry[target] = { ...(registry[target] || {}), ...data, target };
  saveRegistry(registry);
}

export function listSessions(): RegistryEntry[] {
  return Object.values(loadRegistry());
}

export function deleteSession(target: string) {
  const registry = loadRegistry();
  if (registry[target]) {
    delete registry[target];
    saveRegistry(registry);
  }
  const { localDir } = infoPathFor(target);
  try {
    fs.rmSync(localDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

export function pickFreePort(): Promise<number> {
  const net = require("node:net");
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export function canBindPort(port: number): Promise<boolean> {
  const net = require("node:net");
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(true));
    });
  });
}

export function buildSshArgs(opts: SshOptions): string[] {
  const args: string[] = [];
  if (opts.port) {
    args.push("-p", String(opts.port));
  }
  if (opts.identity) {
    args.push("-i", opts.identity);
  }
  if (opts.proxyJump) {
    args.push("-J", opts.proxyJump);
  }
  for (const arg of opts.sshArgs) {
    args.push(arg);
  }
  return args;
}

export function sshRun(opts: SshOptions, cmd: string, execOpts: SshExecOptions = {}) {
  const sshArgs = buildSshArgs(opts);
  const finalArgs = sshArgs.concat(execOpts.extraArgs || [], [opts.host, cmd]);
  return spawnSync("ssh", finalArgs, {
    encoding: "utf8",
    stdio: execOpts.inherit ? "inherit" : "pipe",
    timeout: execOpts.timeoutMs,
  });
}

export function sshExec(opts: SshOptions, cmd: string, inherit = false): string {
  const res = sshRun(opts, cmd, { inherit });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const stderr = res.stderr?.toString() ?? "";
    throw new Error(`ssh failed: ${stderr || res.status}`);
  }
  return (res.stdout || "").toString().trim();
}

async function waitForLocalUrl(
  url: string,
  timeoutMs = 8000,
  intervalMs = 250,
): Promise<boolean> {
  const parsed = new URL(url);
  const client = parsed.protocol === "https:" ? https : http;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = client.request(
        {
          method: "GET",
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname + parsed.search,
          timeout: 2000,
        },
        (res) => {
          res.resume();
          resolve(true);
        },
      );
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.on("error", () => resolve(false));
      req.end();
    });
    if (ok) return true;
    await sleep(intervalMs);
  }
  return false;
}

export type ProbeResult = {
  status: "found" | "missing" | "unreachable";
  path: string;
};

export function probeRemoteBin(opts: SshOptions, extraArgs: string[] = []): ProbeResult {
  const which = sshRun(opts, "command -v cocalc-plus", {
    timeoutMs: 5000,
    extraArgs,
  });
  if (which.error || which.status === 255) {
    return { status: "unreachable", path: "" };
  }
  if (which.status === 0) {
    return { status: "found", path: (which.stdout || "").toString().trim() };
  }
  const test = sshRun(opts, 'test -x "$HOME/.local/bin/cocalc-plus"', {
    timeoutMs: 5000,
    extraArgs,
  });
  if (test.error || test.status === 255) {
    return { status: "unreachable", path: "" };
  }
  if (test.status === 0) {
    return { status: "found", path: "$HOME/.local/bin/cocalc-plus" };
  }
  return { status: "missing", path: "$HOME/.local/bin/cocalc-plus" };
}

export function openUrl(url: string) {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitRemoteFile(
  opts: SshOptions,
  remotePath: string,
  timeoutMs = 10000,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const content = sshExec(opts, `cat ${remotePath}`);
      if (content) return content;
    } catch {
      // ignore and retry
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${remotePath}`);
}

export async function resolveRemoteBin(opts: SshOptions): Promise<string> {
  const probe = probeRemoteBin(opts);
  if (probe.status === "found" && probe.path) return probe.path;
  return "$HOME/.local/bin/cocalc-plus";
}

export async function getRemoteStatus(entry: RegistryEntry): Promise<string> {
  const target = entry.target;
  const { host, port } = parseTarget(target);
  const sshOpts: SshOptions = {
    host,
    port,
    identity: entry.identity,
    proxyJump: entry.proxyJump,
    sshArgs: entry.sshArgs || [],
  };
  const { remoteDir } = infoPathFor(target);
  const remotePidPath = `${remoteDir}/daemon.pid`;
  const extraArgs = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"];
  const probe = probeRemoteBin(sshOpts, extraArgs);
  if (probe.status === "unreachable") return "unreachable";
  if (probe.status === "missing") return "missing";
  const remoteBin = probe.path || "$HOME/.local/bin/cocalc-plus";
  const res = sshRun(
    sshOpts,
    `${remoteBin} --daemon-status --pidfile ${remotePidPath}`,
    { timeoutMs: 5000, extraArgs },
  );
  if (res.error) return "unreachable";
  if (res.status === 0) return "running";
  if (res.status === 1) return "stopped";
  return "error";
}

export async function ensureRemoteReady(
  opts: SshOptions,
  install: boolean,
  upgrade: boolean,
) {
  const probe = probeRemoteBin(opts);
  if (probe.status === "found" && !upgrade) return;
  if (probe.status === "unreachable") {
    throw new Error("ssh unreachable");
  }
  if (probe.status === "missing" && !install) {
    throw new Error("cocalc-plus not installed on remote");
  }
  if (!install && !upgrade) return;
  sshExec(
    opts,
    "curl -fsSL https://software.cocalc.ai/software/cocalc-plus/install.sh | bash",
    true,
  );
}

async function stopRemoteDaemonBestEffort(
  opts: SshOptions,
  target: string,
): Promise<void> {
  const { remoteDir } = infoPathFor(target);
  const remotePidPath = `${remoteDir}/daemon.pid`;
  const remoteBin = await resolveRemoteBin(opts);
  const cmd = `if [ -f ${remotePidPath} ]; then ${remoteBin} --daemon-stop --pidfile ${remotePidPath} >/dev/null 2>&1 || true; fi`;
  sshExec(opts, cmd, true);
}

export async function startRemote(
  opts: SshOptions,
  target: string,
  remoteInfoPath: string,
  remotePidPath: string,
  remoteLogPath: string,
  options?: {
    authToken?: string;
    localUrl?: string;
  },
): Promise<ConnectionInfo> {
  const remoteBin = await resolveRemoteBin(opts);
  const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const safeTarget = shellQuote(target);
  const authToken = options?.authToken;
  const localUrl = options?.localUrl;
  const env = [
    "HOST=127.0.0.1",
    "PORT=0",
    authToken ? `AUTH_TOKEN=${shellQuote(authToken)}` : "AUTH_TOKEN=short",
    "COCALC_ENABLE_SSH_UI=0",
    "COCALC_DATA_DIR=$HOME/.local/share/cocalc-plus/data",
    `COCALC_REMOTE_SSH_TARGET=${safeTarget}`,
    `COCALC_WRITE_CONNECTION_INFO=${remoteInfoPath}`,
    `COCALC_DAEMON_PIDFILE=${remotePidPath}`,
    `COCALC_DAEMON_LOG=${remoteLogPath}`,
    localUrl ? `COCALC_REMOTE_SSH_LOCAL_URL=${shellQuote(localUrl)}` : "",
  ].join(" ");
  const cmd = `mkdir -p ${path.dirname(remoteInfoPath)} && ${env} ${remoteBin} --daemon --write-connection-info ${remoteInfoPath} --pidfile ${remotePidPath} --log ${remoteLogPath}`;
  sshExec(opts, cmd, true);
  const info = await waitRemoteFile(opts, remoteInfoPath, 20000);
  return JSON.parse(info) as ConnectionInfo;
}

export async function statusSession(
  mode: "status" | "stop",
  target: string,
  opts: { identity?: string; proxyJump?: string; sshArg?: string[] },
) {
  const { host, port } = parseTarget(target);
  const sshOpts: SshOptions = {
    host,
    port,
    identity: opts.identity,
    proxyJump: opts.proxyJump,
    sshArgs: opts.sshArg || [],
  };
  const { remoteDir } = infoPathFor(target);
  const remotePidPath = `${remoteDir}/daemon.pid`;
  await ensureRemoteReady(sshOpts, false, false);
  const remoteBin = await resolveRemoteBin(sshOpts);
  const cmd = `${remoteBin} --daemon-${mode} --pidfile ${remotePidPath}`;
  sshExec(sshOpts, cmd, true);
  if (mode === "stop") {
    updateRegistry(target, { lastStopped: new Date().toISOString() });
  }
}

export async function connectSession(
  target: string,
  options: ConnectOptions,
): Promise<ConnectResult> {
  const { host, port } = parseTarget(target);
  const sshArgs = options.sshArg || [];
  const sshOpts: SshOptions = {
    host,
    port,
    identity: options.identity,
    proxyJump: options.proxyJump,
    sshArgs,
  };
  const label = target;
  const { localDir, remoteDir } = infoPathFor(label);
  fs.mkdirSync(localDir, { recursive: true });
  const localPortPath = path.join(localDir, "local-port");

  const remoteInfoPath = `${remoteDir}/connection.json`;
  const remotePidPath = `${remoteDir}/daemon.pid`;
  const remoteLogPath = `${remoteDir}/daemon.log`;
  let localPort: number | undefined;
  if (options.localPort && options.localPort !== "auto") {
    localPort = parseInt(options.localPort, 10);
  } else if (fs.existsSync(localPortPath)) {
    const saved = parseInt(fs.readFileSync(localPortPath, "utf8").trim(), 10);
    if (saved && (await canBindPort(saved))) {
      localPort = saved;
    }
  }
  if (!localPort) {
    localPort = await pickFreePort();
    fs.writeFileSync(localPortPath, String(localPort));
  }

  if (options.logLevel === "debug") {
    console.log("Target:", sshOpts);
    console.log("Remote state:", remoteDir);
  }

  if (options.upgrade) {
    await stopRemoteDaemonBestEffort(sshOpts, target);
  }
  await ensureRemoteReady(sshOpts, !options.noInstall, !!options.upgrade);

  let info: ConnectionInfo | null = null;
  if (options.forwardOnly) {
    const content = sshExec(sshOpts, `cat ${remoteInfoPath}`);
    info = JSON.parse(content) as ConnectionInfo;
  } else {
    let reused = false;
    if (!options.upgrade) {
      const status = await getRemoteStatus({
        target,
        identity: options.identity,
        proxyJump: options.proxyJump,
        sshArgs,
      });
      if (status === "running") {
        try {
          const content = sshExec(sshOpts, `cat ${remoteInfoPath}`);
          info = JSON.parse(content) as ConnectionInfo;
          reused = true;
        } catch {
          reused = false;
          info = null;
        }
      }
    }
    if (!reused) {
      const authToken = crypto.randomBytes(16).toString("hex");
      const localUrlForRemote =
        options.localUrl ??
        `http://localhost:${localPort}?auth_token=${encodeURIComponent(
          authToken,
        )}`;
      info = await startRemote(
        sshOpts,
        target,
        remoteInfoPath,
        remotePidPath,
        remoteLogPath,
        { authToken, localUrl: localUrlForRemote },
      );
    }
  }

  if (!info) {
    throw new Error("Failed to retrieve remote connection info");
  }

  const remotePort = options.remotePort && options.remotePort !== "auto"
    ? parseInt(options.remotePort, 10)
    : info.port;

  const url = `http://localhost:${localPort}?auth_token=${encodeURIComponent(
    info.token || "",
  )}`;

  updateRegistry(label, {
    host,
    port,
    localPort,
    lastUsed: new Date().toISOString(),
    identity: options.identity || undefined,
    proxyJump: options.proxyJump || undefined,
    sshArgs: sshArgs.length > 0 ? sshArgs : undefined,
  });

  const tunnelArgs = buildSshArgs(sshOpts).concat([
    "-N",
    "-L",
    `${localPort}:127.0.0.1:${remotePort}`,
    host,
  ]);

  console.log(`Forwarding localhost:${localPort} -> ${host}:${remotePort}`);
  console.log(url);
  if (!options.noOpen) {
    openUrl(url);
  }

  const tunnel = spawn("ssh", tunnelArgs, { stdio: "inherit" });
  if (options.waitForReady) {
    const ready = await waitForLocalUrl(
      url,
      options.readyTimeoutMs ?? 8000,
    );
    if (!ready) {
      tunnel.kill();
      throw new Error("Remote server did not respond in time");
    }
  }
  return {
    url,
    localPort,
    remotePort,
    info,
    tunnel,
  };
}

export function collectRepeatable(value: string, previous: string[]) {
  previous.push(value);
  return previous;
}
