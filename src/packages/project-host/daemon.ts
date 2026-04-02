import * as childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

type DaemonAction = "start" | "stop" | "ensure";

type DaemonCommand = {
  action: DaemonAction;
  index: number;
};

const DEFAULT_ENV_FILE = "/etc/cocalc/project-host.env";
const processRuntime = {
  spawn: childProcess.spawn,
  spawnSync: childProcess.spawnSync,
};

function parseIndex(arg: string | undefined): number {
  if (arg == null) {
    return 0;
  }
  const index = Number(arg);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(
      `Invalid instance index "${arg}". Provide a non-negative integer (e.g., 0, 1, 2).`,
    );
  }
  return index;
}

function parseDaemonArgs(args: string[]): DaemonCommand | null {
  if (args.length === 0) {
    return null;
  }
  const [first, second, third] = args;
  if (first === "start" || first === "stop" || first === "ensure") {
    return { action: first, index: parseIndex(second) };
  }
  const daemonIndex = args.indexOf("daemon");
  if (daemonIndex >= 0) {
    const action = args[daemonIndex + 1];
    const indexArg = args[daemonIndex + 2];
    if (action === "start" || action === "stop" || action === "ensure") {
      return { action, index: parseIndex(indexArg) };
    }
    if (action != null) {
      return { action: "start", index: parseIndex(action) };
    }
    return { action: "start", index: 0 };
  }
  if (first === "daemon") {
    if (second == null) {
      return { action: "start", index: 0 };
    }
    if (second === "start" || second === "stop" || second === "ensure") {
      return { action: second, index: parseIndex(third) };
    }
    return { action: "start", index: parseIndex(second) };
  }
  if (first === "--daemon" || first === "--daemon-start") {
    return { action: "start", index: parseIndex(second) };
  }
  if (first === "--daemon-stop") {
    return { action: "stop", index: parseIndex(second) };
  }
  return null;
}

function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function loadEnvFromFile(envFile: string): Record<string, string> {
  if (!fs.existsSync(envFile)) {
    return {};
  }
  try {
    const content = fs.readFileSync(envFile, "utf8");
    return parseEnvFile(content);
  } catch {
    return {};
  }
}

function normalizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      normalized[key] = value;
    }
  }
  return normalized;
}

function ensureDefaults(env: Record<string, string>, index: number): void {
  if (!env.COCALC_DISABLE_BEES) {
    env.COCALC_DISABLE_BEES = "no";
  }
  if (!env.MASTER_CONAT_SERVER) {
    env.MASTER_CONAT_SERVER = "http://localhost:9001";
  }
  if (!env.PROJECT_HOST_NAME) {
    env.PROJECT_HOST_NAME = `host-${index}`;
  }
  if (!env.PROJECT_HOST_REGION) {
    env.PROJECT_HOST_REGION = "west";
  }
  if (!env.PROJECT_HOST_PUBLIC_URL) {
    env.PROJECT_HOST_PUBLIC_URL = `http://localhost:${9002 + index}`;
  }
  if (!env.PROJECT_HOST_INTERNAL_URL) {
    env.PROJECT_HOST_INTERNAL_URL = `http://localhost:${9002 + index}`;
  }
  if (!env.PROJECT_HOST_SSH_SERVER) {
    env.PROJECT_HOST_SSH_SERVER = `localhost:${2222 + index}`;
  }
  if (!env.COCALC_FILE_SERVER_MOUNTPOINT) {
    env.COCALC_FILE_SERVER_MOUNTPOINT = "/mnt/cocalc";
  }
  if (!env.PROJECT_RUNNER_NAME) {
    env.PROJECT_RUNNER_NAME = String(index);
  }
  if (!env.HOST) {
    env.HOST = "127.0.0.1";
  }
  if (!env.PORT) {
    env.PORT = String(9002 + index);
  }
  if (!env.COCALC_SSH_SERVER) {
    env.COCALC_SSH_SERVER = `localhost:${2222 + index}`;
  }
}

function resolveEnv(index: number): {
  env: Record<string, string>;
  dataDir: string;
  logPath: string;
  pidPath: string;
  httpPort?: number;
  sshPort?: number;
} {
  const fileEnv = loadEnvFromFile(DEFAULT_ENV_FILE);
  const env = { ...fileEnv, ...normalizeEnv(process.env) };
  const dataDir = env.COCALC_DATA ?? env.DATA;
  if (!dataDir) {
    throw new Error(
      "COCALC_DATA (or DATA) must be set, or provide /etc/cocalc/project-host.env",
    );
  }
  env.COCALC_DATA = env.COCALC_DATA ?? dataDir;
  env.DATA = env.DATA ?? dataDir;
  if (!env.COCALC_BIN_PATH && env.COCALC_PROJECT_TOOLS) {
    env.COCALC_BIN_PATH = env.COCALC_PROJECT_TOOLS;
  }
  if (env.COCALC_RUSTIC && !env.COCALC_RUSTIC_REPO) {
    env.COCALC_RUSTIC_REPO = path.join(env.COCALC_RUSTIC, "rustic");
  }
  ensureDefaults(env, index);
  const logPath = path.join(dataDir, "log");
  const pidPath = path.join(dataDir, "daemon.pid");
  if (!env.DEBUG_FILE) {
    env.DEBUG_FILE = logPath;
  }
  if (!env.DEBUG_CONSOLE) {
    env.DEBUG_CONSOLE = "no";
  }
  return {
    env,
    dataDir,
    logPath,
    pidPath,
    httpPort: parsePort(env.PORT),
    sshPort: parsePort(env.PROJECT_HOST_SSH_SERVER ?? env.COCALC_SSH_SERVER),
  };
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const idx = trimmed.lastIndexOf(":");
  const raw = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

function readProcFile(file: string): Buffer | undefined {
  try {
    return fs.readFileSync(file);
  } catch {
    return undefined;
  }
}

function readProcCmdline(pid: number): string[] {
  const data = readProcFile(`/proc/${pid}/cmdline`);
  if (!data?.length) return [];
  return data
    .toString("utf8")
    .split("\u0000")
    .map((x) => x.trim())
    .filter(Boolean);
}

function readProcEnv(pid: number): Record<string, string> {
  const data = readProcFile(`/proc/${pid}/environ`);
  const env: Record<string, string> = {};
  if (!data?.length) return env;
  for (const entry of data.toString("utf8").split("\u0000")) {
    const idx = entry.indexOf("=");
    if (idx <= 0) continue;
    env[entry.slice(0, idx)] = entry.slice(idx + 1);
  }
  return env;
}

function listProcPids(): number[] {
  if (process.platform !== "linux") return [];
  try {
    return fs
      .readdirSync("/proc", { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => Number(entry.name))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function matchesProjectHostCmdline(cmdline: string[]): boolean {
  return cmdline.some(
    (arg) =>
      arg.includes("/project-host/bundles/") &&
      (arg.endsWith("/main/index.js") || arg.endsWith("/dist/main.js")),
  );
}

function matchesSshpiperdCmdline(cmdline: string[], port: number): boolean {
  return (
    cmdline.some((arg) => /(?:^|\/)sshpiperd$/.test(arg)) &&
    cmdline.includes(`--port=${port}`)
  );
}

function matchingProjectHostPids(dataDir: string, httpPort?: number): number[] {
  const matches: number[] = [];
  for (const pid of listProcPids()) {
    if (pid === process.pid) continue;
    const cmdline = readProcCmdline(pid);
    if (!matchesProjectHostCmdline(cmdline)) continue;
    const env = readProcEnv(pid);
    const procData = env.COCALC_DATA ?? env.DATA;
    const procPort = Number(env.PORT);
    if (
      procData === dataDir ||
      (httpPort != null && procPort === httpPort) ||
      (!procData && !Number.isFinite(procPort))
    ) {
      matches.push(pid);
    }
  }
  return matches;
}

function matchingSshpiperdPids(sshPort?: number): number[] {
  if (sshPort == null) return [];
  const matches: number[] = [];
  for (const pid of listProcPids()) {
    if (pid === process.pid) continue;
    if (matchesSshpiperdCmdline(readProcCmdline(pid), sshPort)) {
      matches.push(pid);
    }
  }
  return matches;
}

function ensureNotAlreadyRunning(pidPath: string): void {
  if (!fs.existsSync(pidPath)) {
    return;
  }
  const pid = Number(fs.readFileSync(pidPath, "utf8"));
  if (pid && isRunning(pid)) {
    throw new Error(
      `project-host already running (pid ${pid}); stop it first or remove ${pidPath}`,
    );
  }
  fs.rmSync(pidPath, { force: true });
}

function getPositiveIntEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidFileAgeMs(pidPath: string): number | undefined {
  try {
    const stats = fs.statSync(pidPath);
    if (!Number.isFinite(stats.mtimeMs)) {
      return;
    }
    return Math.max(0, Date.now() - stats.mtimeMs);
  } catch {
    return;
  }
}

function waitForExit(pid: number, timeoutMs: number, pollMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) {
      return true;
    }
    sleepMs(pollMs);
  }
  return !isRunning(pid);
}

function healthCheckUrl(
  env: Record<string, string>,
  httpPort?: number,
): string {
  const explicit = `${env.COCALC_PROJECT_HOST_DAEMON_HEALTH_URL ?? ""}`.trim();
  if (explicit) {
    return explicit.endsWith("/healthz")
      ? explicit
      : `${explicit.replace(/\/+$/, "")}/healthz`;
  }
  // The daemon watchdog runs on the host itself, so it must not depend on the
  // externally routed project-host URL. Fresh hosts can legitimately serve
  // /healthz on localhost before Cloudflare/DNS/public routing settles.
  const host = `${env.HOST ?? ""}`.trim() || "127.0.0.1";
  const localHost =
    host === "0.0.0.0" || host === "::" || host === "[::]" ? "127.0.0.1" : host;
  const port = httpPort ?? parsePort(env.PORT) ?? 9002;
  return `http://${localHost}:${port}/healthz`;
}

function checkHealthSync(
  env: Record<string, string>,
  httpPort?: number,
): boolean {
  const url = healthCheckUrl(env, httpPort);
  const timeoutSeconds = String(
    getPositiveIntEnv("COCALC_PROJECT_HOST_DAEMON_HEALTH_TIMEOUT_SEC", 5),
  );
  const script = [
    "import json, sys, urllib.request",
    "url = sys.argv[1]",
    "timeout = float(sys.argv[2])",
    "with urllib.request.urlopen(url, timeout=timeout) as response:",
    "    body = response.read().decode('utf-8', 'replace').strip()",
    "    if response.status != 200:",
    "        raise SystemExit(1)",
    "    try:",
    "        payload = json.loads(body) if body else {}",
    "    except Exception:",
    "        payload = {}",
    "    if payload.get('ok') is False:",
    "        raise SystemExit(1)",
  ].join("\n");
  const result = processRuntime.spawnSync(
    "python3",
    ["-c", script, url, timeoutSeconds],
    {
      stdio: "ignore",
    },
  );
  return result.status === 0;
}

function terminatePids(pids: number[], label: string): number[] {
  const unique = [...new Set(pids)].filter(
    (pid) => Number.isInteger(pid) && pid > 0,
  );
  if (!unique.length) return [];
  for (const pid of unique) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore already-dead processes
    }
  }
  const timeoutMs = getPositiveIntEnv(
    "COCALC_PROJECT_HOST_DAEMON_STOP_TIMEOUT_MS",
    15_000,
  );
  const pollMs = getPositiveIntEnv(
    "COCALC_PROJECT_HOST_DAEMON_STOP_POLL_MS",
    100,
  );
  const killTimeoutMs = getPositiveIntEnv(
    "COCALC_PROJECT_HOST_DAEMON_KILL_TIMEOUT_MS",
    5_000,
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = unique.filter(isRunning);
    if (!alive.length) {
      return unique;
    }
    sleepMs(pollMs);
  }
  for (const pid of unique.filter(isRunning)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore already-dead processes
    }
  }
  const killDeadline = Date.now() + killTimeoutMs;
  while (Date.now() < killDeadline) {
    const alive = unique.filter(isRunning);
    if (!alive.length) {
      return unique;
    }
    sleepMs(pollMs);
  }
  throw new Error(
    `failed to stop stray ${label} process(es): ${unique.filter(isRunning).join(", ")}`,
  );
}

function cleanupStrayProcesses(
  dataDir: string,
  httpPort?: number,
  sshPort?: number,
): number {
  const projectHostPids = terminatePids(
    matchingProjectHostPids(dataDir, httpPort),
    "project-host",
  );
  const sshpiperdPids = terminatePids(
    matchingSshpiperdPids(sshPort),
    "sshpiperd",
  );
  return projectHostPids.length + sshpiperdPids.length;
}

function resolveExec(root: string): { command: string; args: string[] } {
  const command =
    process.env.COCALC_PROJECT_HOST_DAEMON_EXEC ?? process.execPath;
  const args: string[] = [];
  if (path.basename(command) === "node") {
    const bundledMain = path.join(root, "main", "index.js");
    if (fs.existsSync(bundledMain)) {
      args.push(bundledMain);
    } else {
      args.push(path.join(root, "dist/main.js"));
    }
  }
  return { command, args };
}

export function startDaemon(index = 0): void {
  const { env, dataDir, logPath, pidPath } = resolveEnv(index);
  ensureNotAlreadyRunning(pidPath);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dataDir, 0o700);
  } catch {
    // best effort
  }
  try {
    if (fs.existsSync(logPath)) {
      fs.unlinkSync(logPath);
    }
  } catch (err) {
    console.error(`warning: unable to truncate log at ${logPath}:`, err);
  }
  const stdout = fs.openSync(logPath, "a");
  const stderr = fs.openSync(logPath, "a");
  try {
    fs.chmodSync(logPath, 0o600);
  } catch {
    // best effort
  }
  const root = path.join(__dirname, "..");
  const { command, args } = resolveExec(root);
  const child = processRuntime.spawn(command, args, {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", stdout, stderr],
  });
  child.unref();
  fs.writeFileSync(pidPath, String(child.pid));
  try {
    fs.chmodSync(pidPath, 0o600);
  } catch {
    // best effort
  }
  console.log(`project-host started (pid ${child.pid}); log=${logPath}`);
}

export function ensureDaemon(index = 0): void {
  const { env, dataDir, pidPath, httpPort, sshPort } = resolveEnv(index);
  const pid = fs.existsSync(pidPath)
    ? Number(fs.readFileSync(pidPath, "utf8"))
    : undefined;
  if (pid && isRunning(pid)) {
    if (checkHealthSync(env, httpPort)) {
      console.log(`project-host healthy (pid ${pid})`);
      return;
    }
    const warmupMs = getPositiveIntEnv(
      "COCALC_PROJECT_HOST_DAEMON_STARTUP_GRACE_MS",
      30_000,
    );
    const ageMs = pidFileAgeMs(pidPath);
    if (ageMs != null && ageMs < warmupMs) {
      console.warn(
        `project-host pid ${pid} is still warming up (${Math.floor(ageMs / 1000)}s < ${Math.floor(warmupMs / 1000)}s); deferring restart.`,
      );
      return;
    }
    console.warn(
      `project-host pid ${pid} is running but unhealthy; restarting.`,
    );
    stopDaemon(index);
    startDaemon(index);
    return;
  }
  if (fs.existsSync(pidPath)) {
    console.warn(`project-host pid file is stale at ${pidPath}; recovering.`);
  } else {
    console.warn("project-host is not running; starting it.");
  }
  fs.rmSync(pidPath, { force: true });
  const cleaned = cleanupStrayProcesses(dataDir, httpPort, sshPort);
  if (cleaned > 0) {
    console.warn(
      `Stopped ${cleaned} stray project-host process(es) before restart.`,
    );
  }
  startDaemon(index);
}

export function stopDaemon(index = 0): void {
  const { pidPath, dataDir, httpPort, sshPort } = resolveEnv(index);
  if (!fs.existsSync(pidPath)) {
    const cleaned = cleanupStrayProcesses(dataDir, httpPort, sshPort);
    if (cleaned > 0) {
      console.log(`Stopped ${cleaned} stray project-host process(es).`);
      return;
    }
    // Nothing to stop; treat as success for idempotent callers.
    console.warn(`No pid file found at ${pidPath}; nothing to stop.`);
    return;
  }
  const pid = Number(fs.readFileSync(pidPath, "utf8"));
  if (!pid || !isRunning(pid)) {
    fs.rmSync(pidPath, { force: true });
    const cleaned = cleanupStrayProcesses(dataDir, httpPort, sshPort);
    if (cleaned > 0) {
      console.log(
        `Removed stale pid file and stopped ${cleaned} stray project-host process(es).`,
      );
      return;
    }
    throw new Error(`No running process for pid ${pid}; removed ${pidPath}`);
  }
  const stopTimeoutMs = getPositiveIntEnv(
    "COCALC_PROJECT_HOST_DAEMON_STOP_TIMEOUT_MS",
    15_000,
  );
  const killTimeoutMs = getPositiveIntEnv(
    "COCALC_PROJECT_HOST_DAEMON_KILL_TIMEOUT_MS",
    5_000,
  );
  const pollMs = getPositiveIntEnv(
    "COCALC_PROJECT_HOST_DAEMON_STOP_POLL_MS",
    100,
  );
  process.kill(pid, "SIGTERM");
  if (!waitForExit(pid, stopTimeoutMs, pollMs)) {
    process.kill(pid, "SIGKILL");
    if (!waitForExit(pid, killTimeoutMs, pollMs)) {
      throw new Error(`project-host pid ${pid} did not exit after SIGKILL`);
    }
    console.log(`Sent SIGKILL to project-host (pid ${pid}).`);
  } else {
    console.log(`Sent SIGTERM to project-host (pid ${pid}).`);
  }
  fs.rmSync(pidPath, { force: true });
  cleanupStrayProcesses(dataDir, httpPort, sshPort);
}

export function handleDaemonCli(argv: string[]): boolean {
  const cmd = parseDaemonArgs(argv);
  if (!cmd) {
    return false;
  }
  if (cmd.action === "start") {
    startDaemon(cmd.index);
  } else if (cmd.action === "stop") {
    stopDaemon(cmd.index);
  } else {
    ensureDaemon(cmd.index);
  }
  return true;
}

export const __test__ = {
  checkHealthSync,
  cleanupStrayProcesses,
  healthCheckUrl,
  matchingProjectHostPids,
  matchingSshpiperdPids,
  parsePort,
  processRuntime,
};
