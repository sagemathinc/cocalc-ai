import * as childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { podmanEnv } from "@cocalc/backend/podman/env";

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
const PODMAN_STALE_STATE_PATTERNS = [
  "invalid internal status",
  'try resetting the pause process with "podman system migrate"',
  "could not find any running process",
];
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

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

function envIsTrue(value: string | undefined): boolean {
  return TRUE_VALUES.has(`${value ?? ""}`.trim().toLowerCase());
}

function usesManagedLocalConatRouter(env: Record<string, string>): boolean {
  return (
    envIsTrue(env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_ROUTER) &&
    !`${env.COCALC_PROJECT_HOST_CONAT_ROUTER_URL ?? ""}`.trim()
  );
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
  if (usesManagedLocalConatRouter(env)) {
    const basePort = parsePort(env.PORT) ?? 9002 + index;
    env.COCALC_PROJECT_HOST_CONAT_ROUTER_HOST =
      env.COCALC_PROJECT_HOST_CONAT_ROUTER_HOST ?? "127.0.0.1";
    env.COCALC_PROJECT_HOST_CONAT_ROUTER_PORT =
      env.COCALC_PROJECT_HOST_CONAT_ROUTER_PORT ?? String(basePort + 100);
    env.COCALC_PROJECT_HOST_CONAT_ROUTER_URL = `http://${env.COCALC_PROJECT_HOST_CONAT_ROUTER_HOST}:${env.COCALC_PROJECT_HOST_CONAT_ROUTER_PORT}`;
  }
}

function resolveEnv(index: number): {
  env: Record<string, string>;
  dataDir: string;
  logPath: string;
  pidPath: string;
  routerEnabled: boolean;
  managedRouter: boolean;
  routerHost: string;
  routerPort?: number;
  routerUrl?: string;
  routerLogPath: string;
  routerPidPath: string;
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
  const routerEnabled = envIsTrue(
    env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_ROUTER,
  );
  const managedRouter =
    routerEnabled &&
    !`${env.COCALC_PROJECT_HOST_CONAT_ROUTER_URL ?? ""}`.trim();
  ensureDefaults(env, index);
  const logPath = path.join(dataDir, "log");
  const pidPath = path.join(dataDir, "daemon.pid");
  const routerLogPath = path.join(dataDir, "conat-router.log");
  const routerPidPath = path.join(dataDir, "conat-router.pid");
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
    routerEnabled,
    managedRouter,
    routerHost: env.COCALC_PROJECT_HOST_CONAT_ROUTER_HOST ?? "127.0.0.1",
    routerPort: parsePort(env.COCALC_PROJECT_HOST_CONAT_ROUTER_PORT),
    routerUrl:
      `${env.COCALC_PROJECT_HOST_CONAT_ROUTER_URL ?? ""}`.trim() || undefined,
    routerLogPath,
    routerPidPath,
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

function isRouterDaemonEnv(env: Record<string, string>): boolean {
  return env.COCALC_PROJECT_HOST_CONAT_ROUTER_DAEMON === "1";
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
    if (isRouterDaemonEnv(env)) continue;
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

function matchingConatRouterPids(
  dataDir: string,
  routerPort?: number,
): number[] {
  const matches: number[] = [];
  for (const pid of listProcPids()) {
    if (pid === process.pid) continue;
    const cmdline = readProcCmdline(pid);
    if (!matchesProjectHostCmdline(cmdline)) continue;
    const env = readProcEnv(pid);
    if (!isRouterDaemonEnv(env)) continue;
    const procData = env.COCALC_DATA ?? env.DATA;
    const procPort = parsePort(
      env.COCALC_PROJECT_HOST_CONAT_ROUTER_PORT ?? env.PORT,
    );
    if (
      procData === dataDir ||
      (routerPort != null && procPort === routerPort) ||
      (!procData && routerPort == null)
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

function conatRouterHealthCheckUrl(
  env: Record<string, string>,
  routerPort?: number,
): string {
  const host =
    `${env.COCALC_PROJECT_HOST_CONAT_ROUTER_HOST ?? ""}`.trim() || "127.0.0.1";
  const port =
    routerPort ??
    parsePort(env.COCALC_PROJECT_HOST_CONAT_ROUTER_PORT) ??
    parsePort(env.PORT) ??
    9102;
  return `http://${host}:${port}/healthz`;
}

function checkHealthUrlSync(url: string): boolean {
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

function checkHealthSync(
  env: Record<string, string>,
  httpPort?: number,
): boolean {
  const url = healthCheckUrl(env, httpPort);
  return checkHealthUrlSync(url);
}

function checkConatRouterHealthSync(
  env: Record<string, string>,
  routerPort?: number,
): boolean {
  return checkHealthUrlSync(conatRouterHealthCheckUrl(env, routerPort));
}

function spawnSyncText(
  command: string,
  args: string[],
  opts: {
    env?: NodeJS.ProcessEnv;
    timeout?: number;
  } = {},
): childProcess.SpawnSyncReturns<string> {
  return processRuntime.spawnSync(command, args, {
    ...opts,
    encoding: "utf8",
  });
}

function combinedSpawnOutput(
  result: childProcess.SpawnSyncReturns<string>,
): string {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

function isPodmanStalePauseState(output: string): boolean {
  const normalized = output.toLowerCase();
  return PODMAN_STALE_STATE_PATTERNS.every((pattern) =>
    normalized.includes(pattern),
  );
}

function ensurePodmanHealthy(env: Record<string, string>): void {
  const podmanRuntimeEnv = podmanEnv(env);
  const probeTimeoutMs = getPositiveIntEnv(
    "COCALC_PROJECT_HOST_PODMAN_PROBE_TIMEOUT_MS",
    15_000,
  );
  const migrateTimeoutMs = getPositiveIntEnv(
    "COCALC_PROJECT_HOST_PODMAN_MIGRATE_TIMEOUT_MS",
    120_000,
  );
  const probe = spawnSyncText("podman", ["ps", "-a"], {
    env: podmanRuntimeEnv,
    timeout: probeTimeoutMs,
  });
  if (probe.status === 0) {
    return;
  }
  const probeOutput = combinedSpawnOutput(probe);
  if (!isPodmanStalePauseState(probeOutput)) {
    return;
  }
  console.warn(
    "podman reported stale pause-process state after restart; running `podman system migrate`.",
  );
  const migrate = spawnSyncText("podman", ["system", "migrate"], {
    env: podmanRuntimeEnv,
    timeout: migrateTimeoutMs,
  });
  if (migrate.status !== 0) {
    throw new Error(
      `podman system migrate failed: ${combinedSpawnOutput(migrate) || `exit ${migrate.status ?? "unknown"}`}`,
    );
  }
  const verify = spawnSyncText("podman", ["ps", "-a"], {
    env: podmanRuntimeEnv,
    timeout: probeTimeoutMs,
  });
  if (verify.status !== 0) {
    throw new Error(
      `podman still reports invalid internal status after system migrate: ${combinedSpawnOutput(verify) || `exit ${verify.status ?? "unknown"}`}`,
    );
  }
  console.log("podman rootless state repaired with `podman system migrate`.");
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
  routerPort?: number,
  sshPort?: number,
): number {
  const projectHostPids = terminatePids(
    matchingProjectHostPids(dataDir, httpPort),
    "project-host",
  );
  const routerPids = terminatePids(
    matchingConatRouterPids(dataDir, routerPort),
    "project-host conat router",
  );
  const sshpiperdPids = terminatePids(
    matchingSshpiperdPids(sshPort),
    "sshpiperd",
  );
  return projectHostPids.length + routerPids.length + sshpiperdPids.length;
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

function startManagedConatRouter(opts: {
  env: Record<string, string>;
  routerPidPath: string;
  routerLogPath: string;
  routerHost: string;
  routerPort?: number;
}): void {
  const { env, routerPidPath, routerLogPath, routerHost, routerPort } = opts;
  if (routerPort == null) {
    throw new Error(
      "managed conat router requires COCALC_PROJECT_HOST_CONAT_ROUTER_PORT",
    );
  }
  if (fs.existsSync(routerPidPath)) {
    const pid = Number(fs.readFileSync(routerPidPath, "utf8"));
    if (pid && isRunning(pid)) {
      if (checkConatRouterHealthSync(env, routerPort)) {
        console.log(
          `project-host conat router already running and healthy (pid ${pid}); leaving it running.`,
        );
        return;
      }
      throw new Error(
        `project-host conat router already running (pid ${pid}); stop it first or remove ${routerPidPath}`,
      );
    }
    fs.rmSync(routerPidPath, { force: true });
  }
  try {
    if (fs.existsSync(routerLogPath)) {
      fs.unlinkSync(routerLogPath);
    }
  } catch (err) {
    console.error(`warning: unable to truncate log at ${routerLogPath}:`, err);
  }
  const stdout = fs.openSync(routerLogPath, "a");
  const stderr = fs.openSync(routerLogPath, "a");
  try {
    fs.chmodSync(routerLogPath, 0o600);
  } catch {
    // best effort
  }
  const root = path.join(__dirname, "..");
  const { command, args } = resolveExec(root);
  const child = processRuntime.spawn(command, args, {
    cwd: root,
    env: {
      ...env,
      HOST: routerHost,
      PORT: String(routerPort),
      DEBUG_FILE: routerLogPath,
      COCALC_PROJECT_HOST_CONAT_ROUTER_DAEMON: "1",
    },
    detached: true,
    stdio: ["ignore", stdout, stderr],
  });
  child.unref();
  fs.writeFileSync(routerPidPath, String(child.pid));
  try {
    fs.chmodSync(routerPidPath, 0o600);
  } catch {
    // best effort
  }
  console.log(
    `project-host conat router started (pid ${child.pid}); log=${routerLogPath}`,
  );
}

function ensureManagedConatRouter(opts: {
  env: Record<string, string>;
  dataDir: string;
  routerPidPath: string;
  routerLogPath: string;
  routerHost: string;
  routerPort?: number;
}): void {
  const { env, dataDir, routerPidPath, routerLogPath, routerHost, routerPort } =
    opts;
  const pid = fs.existsSync(routerPidPath)
    ? Number(fs.readFileSync(routerPidPath, "utf8"))
    : undefined;
  if (pid && isRunning(pid)) {
    if (checkConatRouterHealthSync(env, routerPort)) {
      console.log(`project-host conat router healthy (pid ${pid})`);
      return;
    }
    console.warn(
      `project-host conat router pid ${pid} is running but unhealthy; restarting.`,
    );
    stopManagedConatRouter({
      dataDir,
      routerPidPath,
      routerPort,
    });
    startManagedConatRouter({
      env,
      routerPidPath,
      routerLogPath,
      routerHost,
      routerPort,
    });
    return;
  }
  if (fs.existsSync(routerPidPath)) {
    console.warn(
      `project-host conat router pid file is stale at ${routerPidPath}; recovering.`,
    );
  } else {
    console.warn("project-host conat router is not running; starting it.");
  }
  fs.rmSync(routerPidPath, { force: true });
  terminatePids(
    matchingConatRouterPids(dataDir, routerPort),
    "project-host conat router",
  );
  startManagedConatRouter({
    env,
    routerPidPath,
    routerLogPath,
    routerHost,
    routerPort,
  });
}

function stopManagedConatRouter({
  dataDir,
  routerPidPath,
  routerPort,
}: {
  dataDir: string;
  routerPidPath: string;
  routerPort?: number;
}): void {
  if (!fs.existsSync(routerPidPath)) {
    const cleaned = terminatePids(
      matchingConatRouterPids(dataDir, routerPort),
      "project-host conat router",
    );
    if (cleaned.length > 0) {
      console.log(
        `Stopped ${cleaned.length} stray project-host conat router process(es).`,
      );
    }
    return;
  }
  const pid = Number(fs.readFileSync(routerPidPath, "utf8"));
  if (!pid || !isRunning(pid)) {
    fs.rmSync(routerPidPath, { force: true });
    const cleaned = terminatePids(
      matchingConatRouterPids(dataDir, routerPort),
      "project-host conat router",
    );
    if (cleaned.length > 0) {
      console.log(
        `Removed stale router pid file and stopped ${cleaned.length} stray project-host conat router process(es).`,
      );
    }
    return;
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
      throw new Error(
        `project-host conat router pid ${pid} did not exit after SIGKILL`,
      );
    }
    console.log(`Sent SIGKILL to project-host conat router (pid ${pid}).`);
  } else {
    console.log(`Sent SIGTERM to project-host conat router (pid ${pid}).`);
  }
  fs.rmSync(routerPidPath, { force: true });
  terminatePids(
    matchingConatRouterPids(dataDir, routerPort),
    "project-host conat router",
  );
}

export function startDaemon(index = 0): void {
  const {
    env,
    dataDir,
    logPath,
    pidPath,
    httpPort,
    managedRouter,
    routerHost,
    routerLogPath,
    routerPidPath,
    routerPort,
  } = resolveEnv(index);
  if (managedRouter) {
    ensureManagedConatRouter({
      env,
      dataDir,
      routerPidPath,
      routerLogPath,
      routerHost,
      routerPort,
    });
  }
  if (fs.existsSync(pidPath)) {
    const pid = Number(fs.readFileSync(pidPath, "utf8"));
    if (pid && isRunning(pid)) {
      if (
        checkHealthSync(env, httpPort) &&
        (!managedRouter || checkConatRouterHealthSync(env, routerPort))
      ) {
        console.log(
          `project-host already running and healthy (pid ${pid}); leaving it running.`,
        );
        return;
      }
      throw new Error(
        `project-host already running (pid ${pid}); stop it first or remove ${pidPath}`,
      );
    }
    fs.rmSync(pidPath, { force: true });
  }
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
  ensurePodmanHealthy(env);
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
  const {
    env,
    dataDir,
    pidPath,
    httpPort,
    sshPort,
    managedRouter,
    routerHost,
    routerLogPath,
    routerPidPath,
    routerPort,
  } = resolveEnv(index);
  if (managedRouter) {
    ensureManagedConatRouter({
      env,
      dataDir,
      routerPidPath,
      routerLogPath,
      routerHost,
      routerPort,
    });
  }
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
  const cleaned = cleanupStrayProcesses(dataDir, httpPort, routerPort, sshPort);
  if (cleaned > 0) {
    console.warn(
      `Stopped ${cleaned} stray project-host process(es) before restart.`,
    );
  }
  startDaemon(index);
}

export function stopDaemon(index = 0): void {
  const {
    pidPath,
    dataDir,
    httpPort,
    sshPort,
    routerEnabled,
    routerPidPath,
    routerPort,
  } = resolveEnv(index);
  if (!fs.existsSync(pidPath)) {
    const cleaned = cleanupStrayProcesses(
      dataDir,
      httpPort,
      routerPort,
      sshPort,
    );
    if (cleaned > 0) {
      console.log(`Stopped ${cleaned} stray project-host process(es).`);
      if (routerEnabled) {
        stopManagedConatRouter({
          dataDir,
          routerPidPath,
          routerPort,
        });
      }
      return;
    }
    // Nothing to stop; treat as success for idempotent callers.
    console.warn(`No pid file found at ${pidPath}; nothing to stop.`);
    return;
  }
  const pid = Number(fs.readFileSync(pidPath, "utf8"));
  if (!pid || !isRunning(pid)) {
    fs.rmSync(pidPath, { force: true });
    const cleaned = cleanupStrayProcesses(
      dataDir,
      httpPort,
      routerPort,
      sshPort,
    );
    if (cleaned > 0) {
      console.log(
        `Removed stale pid file and stopped ${cleaned} stray project-host process(es).`,
      );
      if (routerEnabled) {
        stopManagedConatRouter({
          dataDir,
          routerPidPath,
          routerPort,
        });
      }
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
  cleanupStrayProcesses(dataDir, httpPort, routerPort, sshPort);
  if (routerEnabled) {
    stopManagedConatRouter({
      dataDir,
      routerPidPath,
      routerPort,
    });
  }
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
  ensurePodmanHealthy,
  healthCheckUrl,
  isPodmanStalePauseState,
  matchingProjectHostPids,
  matchingSshpiperdPids,
  parsePort,
  processRuntime,
};
