import * as childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { podmanEnv } from "@cocalc/backend/podman/env";

type DaemonAction = "start" | "stop" | "ensure";

type DaemonCommand = {
  action: DaemonAction;
  index: number;
};

type EnsureOptions = {
  quietHealthy?: boolean;
  preserveManagedAuxiliaryDaemons?: boolean;
};

type StopOptions = {
  preserveManagedAuxiliaryDaemons?: boolean;
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
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

function packageRoot(): string {
  const direct = path.join(__dirname, "package.json");
  if (fs.existsSync(direct)) {
    return __dirname;
  }
  return path.join(__dirname, "..");
}

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

function envIsFalse(value: string | undefined): boolean {
  return FALSE_VALUES.has(`${value ?? ""}`.trim().toLowerCase());
}

function isProjectHostExternalConatRouterEnabled(
  env: Record<string, string>,
): boolean {
  const value = `${env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_ROUTER ?? ""}`.trim();
  if (!value) {
    return true;
  }
  return envIsTrue(value);
}

function isProjectHostExternalConatPersistEnabled(
  env: Record<string, string>,
): boolean {
  return envIsTrue(env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_PERSIST);
}

function usesManagedLocalConatRouter(env: Record<string, string>): boolean {
  return (
    isProjectHostExternalConatRouterEnabled(env) &&
    !`${env.COCALC_PROJECT_HOST_CONAT_ROUTER_URL ?? ""}`.trim()
  );
}

function usesManagedLocalConatPersist(env: Record<string, string>): boolean {
  if (!isProjectHostExternalConatPersistEnabled(env)) {
    return false;
  }
  return !envIsFalse(env.COCALC_PROJECT_HOST_MANAGE_CONAT_PERSIST);
}

function ensureDefaults(env: Record<string, string>, index: number): void {
  if (!`${env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_ROUTER ?? ""}`.trim()) {
    env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_ROUTER = "1";
  }
  if (
    !`${env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_PERSIST ?? ""}`.trim() &&
    isProjectHostExternalConatRouterEnabled(env)
  ) {
    env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_PERSIST = "1";
  }
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
  if (usesManagedLocalConatPersist(env)) {
    const basePort = parsePort(env.PORT) ?? 9002 + index;
    env.COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_HOST =
      env.COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_HOST ?? "127.0.0.1";
    env.COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_PORT =
      env.COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_PORT ??
      String(basePort + 200);
  }
}

function resolveEnv(index: number): {
  env: Record<string, string>;
  dataDir: string;
  agentLogPath: string;
  agentPidPath: string;
  logPath: string;
  pidPath: string;
  persistEnabled: boolean;
  managedPersist: boolean;
  persistHealthHost: string;
  persistHealthPort?: number;
  persistLogPath: string;
  persistPidPath: string;
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
  const explicitRouterUrl =
    `${env.COCALC_PROJECT_HOST_CONAT_ROUTER_URL ?? ""}`.trim().length
      ? env.COCALC_PROJECT_HOST_CONAT_ROUTER_URL
      : "";
  ensureDefaults(env, index);
  const routerEnabled = isProjectHostExternalConatRouterEnabled(env);
  const managedRouter = routerEnabled && !`${explicitRouterUrl}`.trim();
  const persistEnabled = isProjectHostExternalConatPersistEnabled(env);
  const managedPersist = usesManagedLocalConatPersist(env);
  if (persistEnabled && !routerEnabled) {
    throw new Error(
      "external conat persist mode requires external conat router mode",
    );
  }
  const logPath = path.join(dataDir, "log");
  const pidPath = path.join(dataDir, "daemon.pid");
  const agentLogPath = path.join(dataDir, "host-agent.log");
  const agentPidPath = path.join(dataDir, "host-agent.pid");
  const persistLogPath = path.join(dataDir, "conat-persist.log");
  const persistPidPath = path.join(dataDir, "conat-persist.pid");
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
    agentLogPath,
    agentPidPath,
    logPath,
    pidPath,
    persistEnabled,
    managedPersist,
    persistHealthHost:
      env.COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_HOST ?? "127.0.0.1",
    persistHealthPort: parsePort(
      env.COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_PORT,
    ),
    persistLogPath,
    persistPidPath,
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
    if (process.platform === "linux") {
      const status = readProcFile(`/proc/${pid}/status`)?.toString("utf8");
      const state = status?.match(/^State:\s+([A-Z])/m)?.[1];
      if (state === "Z") {
        return false;
      }
    }
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

function matchesHostAgentCmdline(cmdline: string[]): boolean {
  return (
    matchesProjectHostCmdline(cmdline) ||
    cmdline.some((arg) => arg.endsWith("/dist/host-agent.js"))
  );
}

function isRouterDaemonEnv(env: Record<string, string>): boolean {
  return env.COCALC_PROJECT_HOST_CONAT_ROUTER_DAEMON === "1";
}

function isPersistDaemonEnv(env: Record<string, string>): boolean {
  return env.COCALC_PROJECT_HOST_CONAT_PERSIST_DAEMON === "1";
}

function isHostAgentEnv(env: Record<string, string>): boolean {
  return env.COCALC_PROJECT_HOST_AGENT === "1";
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
    if (
      isRouterDaemonEnv(env) ||
      isPersistDaemonEnv(env) ||
      isHostAgentEnv(env)
    ) {
      continue;
    }
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

function matchingHostAgentPids(dataDir: string): number[] {
  const matches: number[] = [];
  for (const pid of listProcPids()) {
    if (pid === process.pid) continue;
    const cmdline = readProcCmdline(pid);
    if (!matchesHostAgentCmdline(cmdline)) continue;
    const env = readProcEnv(pid);
    if (!isHostAgentEnv(env)) continue;
    const procData = env.COCALC_DATA ?? env.DATA;
    if (procData === dataDir || !procData) {
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

function matchingConatPersistPids(
  dataDir: string,
  persistHealthPort?: number,
): number[] {
  const matches: number[] = [];
  for (const pid of listProcPids()) {
    if (pid === process.pid) continue;
    const cmdline = readProcCmdline(pid);
    if (!matchesProjectHostCmdline(cmdline)) continue;
    const env = readProcEnv(pid);
    if (!isPersistDaemonEnv(env)) continue;
    const procData = env.COCALC_DATA ?? env.DATA;
    const procPort = parsePort(
      env.COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_PORT ?? env.PORT,
    );
    if (
      procData === dataDir ||
      (persistHealthPort != null && procPort === persistHealthPort) ||
      (!procData && persistHealthPort == null)
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

function waitForHealthCheckSync(
  check: () => boolean,
  opts: {
    timeoutMs: number;
    pollMs: number;
    pid?: number;
    label: string;
  },
): void {
  const { timeoutMs, pollMs, pid, label } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    if (pid != null && !isRunning(pid)) {
      throw new Error(`${label} exited before becoming healthy`);
    }
    sleepMs(pollMs);
  }
  throw new Error(`${label} did not become healthy within ${timeoutMs}ms`);
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

function conatPersistHealthCheckUrl(
  env: Record<string, string>,
  persistHealthPort?: number,
): string {
  const host =
    `${env.COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_HOST ?? ""}`.trim() ||
    "127.0.0.1";
  const port =
    persistHealthPort ??
    parsePort(env.COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_PORT) ??
    9202;
  return `http://${host}:${port}/healthz`;
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

function checkConatPersistHealthSync(
  env: Record<string, string>,
  persistHealthPort?: number,
): boolean {
  return checkHealthUrlSync(conatPersistHealthCheckUrl(env, persistHealthPort));
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
    (pid) => Number.isInteger(pid) && pid > 0 && isRunning(pid),
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
  persistHealthPort?: number,
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
  const persistPids = terminatePids(
    matchingConatPersistPids(dataDir, persistHealthPort),
    "project-host conat persist",
  );
  const sshpiperdPids = terminatePids(
    matchingSshpiperdPids(sshPort),
    "sshpiperd",
  );
  return (
    projectHostPids.length +
    routerPids.length +
    persistPids.length +
    sshpiperdPids.length
  );
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

function withoutHostAgentEnv(
  env: Record<string, string>,
): Record<string, string> {
  const next = { ...env };
  delete next.COCALC_PROJECT_HOST_AGENT;
  delete next.COCALC_PROJECT_HOST_AGENT_INDEX;
  delete next.COCALC_PROJECT_HOST_AGENT_POLL_MS;
  return next;
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
  const root = packageRoot();
  const { command, args } = resolveExec(root);
  const childEnv = withoutHostAgentEnv(env);
  const child = processRuntime.spawn(command, args, {
    cwd: root,
    env: {
      ...childEnv,
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
  try {
    waitForHealthCheckSync(() => checkConatRouterHealthSync(env, routerPort), {
      timeoutMs: getPositiveIntEnv(
        "COCALC_PROJECT_HOST_CONAT_ROUTER_STARTUP_TIMEOUT_MS",
        30_000,
      ),
      pollMs: getPositiveIntEnv(
        "COCALC_PROJECT_HOST_CONAT_ROUTER_STARTUP_POLL_MS",
        250,
      ),
      pid: child.pid,
      label: "project-host conat router",
    });
  } catch (err) {
    fs.rmSync(routerPidPath, { force: true });
    try {
      if (child.pid && isRunning(child.pid)) {
        process.kill(child.pid, "SIGTERM");
      }
    } catch {
      // ignore best-effort cleanup failures
    }
    throw err;
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
  options?: EnsureOptions;
}): void {
  const { env, dataDir, routerPidPath, routerLogPath, routerHost, routerPort } =
    opts;
  const pid = fs.existsSync(routerPidPath)
    ? Number(fs.readFileSync(routerPidPath, "utf8"))
    : undefined;
  if (pid && isRunning(pid)) {
    if (checkConatRouterHealthSync(env, routerPort)) {
      if (!opts.options?.quietHealthy) {
        console.log(`project-host conat router healthy (pid ${pid})`);
      }
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

function startManagedConatPersist(opts: {
  env: Record<string, string>;
  persistPidPath: string;
  persistLogPath: string;
  persistHealthHost: string;
  persistHealthPort?: number;
}): void {
  const {
    env,
    persistPidPath,
    persistLogPath,
    persistHealthHost,
    persistHealthPort,
  } = opts;
  if (persistHealthPort == null) {
    throw new Error(
      "managed conat persist requires COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_PORT",
    );
  }
  if (fs.existsSync(persistPidPath)) {
    const pid = Number(fs.readFileSync(persistPidPath, "utf8"));
    if (pid && isRunning(pid)) {
      if (checkConatPersistHealthSync(env, persistHealthPort)) {
        console.log(
          `project-host conat persist already running and healthy (pid ${pid}); leaving it running.`,
        );
        return;
      }
      throw new Error(
        `project-host conat persist already running (pid ${pid}); stop it first or remove ${persistPidPath}`,
      );
    }
    fs.rmSync(persistPidPath, { force: true });
  }
  try {
    if (fs.existsSync(persistLogPath)) {
      fs.unlinkSync(persistLogPath);
    }
  } catch (err) {
    console.error(`warning: unable to truncate log at ${persistLogPath}:`, err);
  }
  const stdout = fs.openSync(persistLogPath, "a");
  const stderr = fs.openSync(persistLogPath, "a");
  try {
    fs.chmodSync(persistLogPath, 0o600);
  } catch {
    // best effort
  }
  const root = packageRoot();
  const { command, args } = resolveExec(root);
  const childEnv = withoutHostAgentEnv(env);
  const child = processRuntime.spawn(command, args, {
    cwd: root,
    env: {
      ...childEnv,
      HOST: persistHealthHost,
      PORT: String(persistHealthPort),
      DEBUG_FILE: persistLogPath,
      COCALC_PROJECT_HOST_CONAT_PERSIST_DAEMON: "1",
    },
    detached: true,
    stdio: ["ignore", stdout, stderr],
  });
  child.unref();
  fs.writeFileSync(persistPidPath, String(child.pid));
  try {
    fs.chmodSync(persistPidPath, 0o600);
  } catch {
    // best effort
  }
  try {
    waitForHealthCheckSync(
      () => checkConatPersistHealthSync(env, persistHealthPort),
      {
        timeoutMs: getPositiveIntEnv(
          "COCALC_PROJECT_HOST_CONAT_PERSIST_STARTUP_TIMEOUT_MS",
          30_000,
        ),
        pollMs: getPositiveIntEnv(
          "COCALC_PROJECT_HOST_CONAT_PERSIST_STARTUP_POLL_MS",
          250,
        ),
        pid: child.pid,
        label: "project-host conat persist",
      },
    );
  } catch (err) {
    fs.rmSync(persistPidPath, { force: true });
    try {
      if (child.pid && isRunning(child.pid)) {
        process.kill(child.pid, "SIGTERM");
      }
    } catch {
      // ignore best-effort cleanup failures
    }
    throw err;
  }
  console.log(
    `project-host conat persist started (pid ${child.pid}); log=${persistLogPath}`,
  );
}

function ensureManagedConatPersist(opts: {
  env: Record<string, string>;
  dataDir: string;
  persistPidPath: string;
  persistLogPath: string;
  persistHealthHost: string;
  persistHealthPort?: number;
  options?: EnsureOptions;
}): void {
  const {
    env,
    dataDir,
    persistPidPath,
    persistLogPath,
    persistHealthHost,
    persistHealthPort,
  } = opts;
  const pid = fs.existsSync(persistPidPath)
    ? Number(fs.readFileSync(persistPidPath, "utf8"))
    : undefined;
  if (pid && isRunning(pid)) {
    if (checkConatPersistHealthSync(env, persistHealthPort)) {
      if (!opts.options?.quietHealthy) {
        console.log(`project-host conat persist healthy (pid ${pid})`);
      }
      return;
    }
    console.warn(
      `project-host conat persist pid ${pid} is running but unhealthy; restarting.`,
    );
    stopManagedConatPersist({
      dataDir,
      persistPidPath,
      persistHealthPort,
    });
    startManagedConatPersist({
      env,
      persistPidPath,
      persistLogPath,
      persistHealthHost,
      persistHealthPort,
    });
    return;
  }
  if (fs.existsSync(persistPidPath)) {
    console.warn(
      `project-host conat persist pid file is stale at ${persistPidPath}; recovering.`,
    );
  } else {
    console.warn("project-host conat persist is not running; starting it.");
  }
  fs.rmSync(persistPidPath, { force: true });
  terminatePids(
    matchingConatPersistPids(dataDir, persistHealthPort),
    "project-host conat persist",
  );
  startManagedConatPersist({
    env,
    persistPidPath,
    persistLogPath,
    persistHealthHost,
    persistHealthPort,
  });
}

function stopManagedConatPersist({
  dataDir,
  persistPidPath,
  persistHealthPort,
}: {
  dataDir: string;
  persistPidPath: string;
  persistHealthPort?: number;
}): void {
  if (!fs.existsSync(persistPidPath)) {
    const cleaned = terminatePids(
      matchingConatPersistPids(dataDir, persistHealthPort),
      "project-host conat persist",
    );
    if (cleaned.length > 0) {
      console.log(
        `Stopped ${cleaned.length} stray project-host conat persist process(es).`,
      );
    }
    return;
  }
  const pid = Number(fs.readFileSync(persistPidPath, "utf8"));
  if (!pid || !isRunning(pid)) {
    fs.rmSync(persistPidPath, { force: true });
    const cleaned = terminatePids(
      matchingConatPersistPids(dataDir, persistHealthPort),
      "project-host conat persist",
    );
    if (cleaned.length > 0) {
      console.log(
        `Removed stale persist pid file and stopped ${cleaned.length} stray project-host conat persist process(es).`,
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
        `project-host conat persist pid ${pid} did not exit after SIGKILL`,
      );
    }
    console.log(`Sent SIGKILL to project-host conat persist (pid ${pid}).`);
  } else {
    console.log(`Sent SIGTERM to project-host conat persist (pid ${pid}).`);
  }
  fs.rmSync(persistPidPath, { force: true });
  terminatePids(
    matchingConatPersistPids(dataDir, persistHealthPort),
    "project-host conat persist",
  );
}

export function restartManagedLocalConatRouter(index = 0): void {
  const {
    env,
    dataDir,
    managedRouter,
    routerHost,
    routerLogPath,
    routerPidPath,
    routerPort,
  } = resolveEnv(index);
  if (!managedRouter) {
    throw new Error(
      "project-host conat router is not using managed local mode",
    );
  }
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
}

export function restartManagedLocalConatPersist(index = 0): void {
  const {
    env,
    dataDir,
    managedPersist,
    persistHealthHost,
    persistHealthPort,
    persistLogPath,
    persistPidPath,
  } = resolveEnv(index);
  if (!managedPersist) {
    throw new Error(
      "project-host conat persist is not using managed local mode",
    );
  }
  stopManagedConatPersist({
    dataDir,
    persistPidPath,
    persistHealthPort,
  });
  startManagedConatPersist({
    env,
    persistPidPath,
    persistLogPath,
    persistHealthHost,
    persistHealthPort,
  });
}

export function startDaemon(index = 0): void {
  const {
    env,
    dataDir,
    logPath,
    pidPath,
    httpPort,
    managedPersist,
    persistHealthHost,
    persistHealthPort,
    persistLogPath,
    persistPidPath,
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
  if (managedPersist) {
    ensureManagedConatPersist({
      env,
      dataDir,
      persistPidPath,
      persistLogPath,
      persistHealthHost,
      persistHealthPort,
    });
  }
  if (fs.existsSync(pidPath)) {
    const pid = Number(fs.readFileSync(pidPath, "utf8"));
    if (pid && isRunning(pid)) {
      if (
        checkHealthSync(env, httpPort) &&
        (!managedRouter || checkConatRouterHealthSync(env, routerPort)) &&
        (!managedPersist || checkConatPersistHealthSync(env, persistHealthPort))
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
  const root = packageRoot();
  const { command, args } = resolveExec(root);
  const childEnv = withoutHostAgentEnv(env);
  const child = processRuntime.spawn(command, args, {
    cwd: root,
    env: childEnv,
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

export function ensureDaemon(index = 0, options?: EnsureOptions): void {
  ensureDaemonWithOptions(index, options);
}

function ensureDaemonWithOptions(index = 0, options?: EnsureOptions): void {
  const {
    env,
    dataDir,
    pidPath,
    httpPort,
    persistHealthHost,
    persistHealthPort,
    persistLogPath,
    persistPidPath,
    sshPort,
    managedPersist,
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
      options,
    });
  }
  if (managedPersist) {
    ensureManagedConatPersist({
      env,
      dataDir,
      persistPidPath,
      persistLogPath,
      persistHealthHost,
      persistHealthPort,
      options,
    });
  }
  const pid = fs.existsSync(pidPath)
    ? Number(fs.readFileSync(pidPath, "utf8"))
    : undefined;
  if (pid && isRunning(pid)) {
    if (checkHealthSync(env, httpPort)) {
      if (!options?.quietHealthy) {
        console.log(`project-host healthy (pid ${pid})`);
      }
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
    stopDaemonWithOptions(index, {
      preserveManagedAuxiliaryDaemons: options?.preserveManagedAuxiliaryDaemons,
    });
    startDaemon(index);
    return;
  }
  if (fs.existsSync(pidPath)) {
    console.warn(`project-host pid file is stale at ${pidPath}; recovering.`);
  } else {
    console.warn("project-host is not running; starting it.");
  }
  fs.rmSync(pidPath, { force: true });
  const cleaned = cleanupStrayProcesses(
    dataDir,
    httpPort,
    managedRouter && !options?.preserveManagedAuxiliaryDaemons
      ? routerPort
      : undefined,
    managedPersist && !options?.preserveManagedAuxiliaryDaemons
      ? persistHealthPort
      : undefined,
    sshPort,
  );
  if (cleaned > 0) {
    console.warn(
      `Stopped ${cleaned} stray project-host process(es) before restart.`,
    );
  }
  startDaemon(index);
}

function stopHostAgentProcess({
  dataDir,
  agentPidPath,
}: {
  dataDir: string;
  agentPidPath: string;
}): void {
  if (!fs.existsSync(agentPidPath)) {
    const cleaned = terminatePids(
      matchingHostAgentPids(dataDir),
      "project-host host-agent",
    );
    if (cleaned.length > 0) {
      console.log(
        `Stopped ${cleaned.length} stray project-host host-agent process(es).`,
      );
    }
    return;
  }
  const pid = Number(fs.readFileSync(agentPidPath, "utf8"));
  if (!pid || !isRunning(pid)) {
    fs.rmSync(agentPidPath, { force: true });
    const cleaned = terminatePids(
      matchingHostAgentPids(dataDir),
      "project-host host-agent",
    );
    if (cleaned.length > 0) {
      console.log(
        `Removed stale host-agent pid file and stopped ${cleaned.length} stray project-host host-agent process(es).`,
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
        `project-host host-agent pid ${pid} did not exit after SIGKILL`,
      );
    }
    console.log(`Sent SIGKILL to project-host host-agent (pid ${pid}).`);
  } else {
    console.log(`Sent SIGTERM to project-host host-agent (pid ${pid}).`);
  }
  fs.rmSync(agentPidPath, { force: true });
  terminatePids(matchingHostAgentPids(dataDir), "project-host host-agent");
}

export function startHostAgent(index = 0): void {
  const { env, dataDir, agentLogPath, agentPidPath, managedRouter } =
    resolveEnv(index);
  if (fs.existsSync(agentPidPath)) {
    const pid = Number(fs.readFileSync(agentPidPath, "utf8"));
    if (pid && isRunning(pid)) {
      console.log(
        `project-host host-agent already running (pid ${pid}); leaving it running.`,
      );
      return;
    }
    fs.rmSync(agentPidPath, { force: true });
  }
  const cleaned = terminatePids(
    matchingHostAgentPids(dataDir),
    "project-host host-agent",
  );
  if (cleaned.length > 0) {
    console.warn(
      `Stopped ${cleaned.length} stray project-host host-agent process(es) before start.`,
    );
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    if (fs.existsSync(agentLogPath)) {
      fs.unlinkSync(agentLogPath);
    }
  } catch (err) {
    console.error(`warning: unable to truncate log at ${agentLogPath}:`, err);
  }
  const stdout = fs.openSync(agentLogPath, "a");
  const stderr = fs.openSync(agentLogPath, "a");
  try {
    fs.chmodSync(agentLogPath, 0o600);
  } catch {
    // best effort
  }
  const root = packageRoot();
  const { command, args } = resolveExec(root);
  const agentEnv: Record<string, string> = {
    ...env,
    COCALC_PROJECT_HOST_AGENT: "1",
    COCALC_PROJECT_HOST_AGENT_INDEX: String(index),
  };
  // The host-agent must see the original router-management intent, not the
  // derived local router URL that resolveEnv synthesizes for project-host
  // children. Otherwise it misclassifies the router as externally managed and
  // never supervises it.
  if (managedRouter) {
    delete agentEnv.COCALC_PROJECT_HOST_CONAT_ROUTER_URL;
  }
  const child = processRuntime.spawn(
    command,
    [...args, "--index", String(index)],
    {
      cwd: root,
      env: agentEnv,
      detached: true,
      stdio: ["ignore", stdout, stderr],
    },
  );
  child.unref();
  fs.writeFileSync(agentPidPath, String(child.pid));
  try {
    fs.chmodSync(agentPidPath, 0o600);
  } catch {
    // best effort
  }
  console.log(
    `project-host host-agent started (pid ${child.pid}); log=${agentLogPath}`,
  );
}

export function ensureHostAgent(index = 0): void {
  const { dataDir, agentPidPath } = resolveEnv(index);
  const pid = fs.existsSync(agentPidPath)
    ? Number(fs.readFileSync(agentPidPath, "utf8"))
    : undefined;
  if (pid && isRunning(pid)) {
    console.log(`project-host host-agent healthy (pid ${pid})`);
    return;
  }
  if (fs.existsSync(agentPidPath)) {
    console.warn(
      `project-host host-agent pid file is stale at ${agentPidPath}; recovering.`,
    );
    fs.rmSync(agentPidPath, { force: true });
  }
  const cleaned = terminatePids(
    matchingHostAgentPids(dataDir),
    "project-host host-agent",
  );
  if (cleaned.length > 0) {
    console.warn(
      `Stopped ${cleaned.length} stray project-host host-agent process(es) before restart.`,
    );
  }
  startHostAgent(index);
}

export function stopHostAgent(index = 0): void {
  const { dataDir, agentPidPath } = resolveEnv(index);
  stopHostAgentProcess({ dataDir, agentPidPath });
  stopDaemon(index);
}

export function stopDaemon(index = 0): void {
  stopDaemonWithOptions(index);
}

function stopDaemonWithOptions(index = 0, options?: StopOptions): void {
  const {
    pidPath,
    dataDir,
    httpPort,
    managedPersist,
    persistPidPath,
    persistHealthPort,
    sshPort,
    managedRouter,
    routerPidPath,
    routerPort,
  } = resolveEnv(index);
  if (!fs.existsSync(pidPath)) {
    const cleaned = cleanupStrayProcesses(
      dataDir,
      httpPort,
      managedRouter && !options?.preserveManagedAuxiliaryDaemons
        ? routerPort
        : undefined,
      managedPersist && !options?.preserveManagedAuxiliaryDaemons
        ? persistHealthPort
        : undefined,
      sshPort,
    );
    if (cleaned > 0) {
      console.log(`Stopped ${cleaned} stray project-host process(es).`);
      if (managedPersist && !options?.preserveManagedAuxiliaryDaemons) {
        stopManagedConatPersist({
          dataDir,
          persistPidPath,
          persistHealthPort,
        });
      }
      if (managedRouter && !options?.preserveManagedAuxiliaryDaemons) {
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
      managedRouter && !options?.preserveManagedAuxiliaryDaemons
        ? routerPort
        : undefined,
      managedPersist && !options?.preserveManagedAuxiliaryDaemons
        ? persistHealthPort
        : undefined,
      sshPort,
    );
    if (cleaned > 0) {
      console.log(
        `Removed stale pid file and stopped ${cleaned} stray project-host process(es).`,
      );
      if (managedPersist && !options?.preserveManagedAuxiliaryDaemons) {
        stopManagedConatPersist({
          dataDir,
          persistPidPath,
          persistHealthPort,
        });
      }
      if (managedRouter && !options?.preserveManagedAuxiliaryDaemons) {
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
  cleanupStrayProcesses(
    dataDir,
    httpPort,
    managedRouter && !options?.preserveManagedAuxiliaryDaemons
      ? routerPort
      : undefined,
    managedPersist && !options?.preserveManagedAuxiliaryDaemons
      ? persistHealthPort
      : undefined,
    sshPort,
  );
  if (managedPersist && !options?.preserveManagedAuxiliaryDaemons) {
    stopManagedConatPersist({
      dataDir,
      persistPidPath,
      persistHealthPort,
    });
  }
  if (managedRouter && !options?.preserveManagedAuxiliaryDaemons) {
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
    startHostAgent(cmd.index);
  } else if (cmd.action === "stop") {
    stopHostAgent(cmd.index);
  } else {
    ensureHostAgent(cmd.index);
  }
  return true;
}

export const __test__ = {
  checkHealthSync,
  cleanupStrayProcesses,
  ensurePodmanHealthy,
  healthCheckUrl,
  isPodmanStalePauseState,
  isRunning,
  matchingHostAgentPids,
  matchingProjectHostPids,
  matchingSshpiperdPids,
  parsePort,
  processRuntime,
};
