import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import type {
  ReflectForwardRow,
  ReflectLogRow,
  ReflectSessionLogRow,
  ReflectSessionRow,
} from "@cocalc/conat/hub/api/reflect";
import type {
  ForwardRow,
  LabelSelector,
  SchedulerOptions,
  SessionRow,
} from "reflect-sync";
const requireCjs = createRequire(__filename);
type ReflectSync = typeof import("reflect-sync");

const DEFAULT_REFLECT_HOME =
  process.env.COCALC_REFLECT_HOME ??
  path.join(os.homedir(), ".local", "share", "cocalc-plus", "reflect-sync");

let reflectSyncPromise: Promise<ReflectSync> | null = null;
let sessionDbPath: string | null = null;
const schedulerChildren = new Map<number, ChildProcess>();
let exitHookInstalled = false;
let daemonLogger: { logger: any; close: () => void } | null = null;
const dynamicImport = new Function(
  "p",
  "return import(p);",
) as (p: string) => Promise<any>;

const LOG_LEVELS = ["debug", "info", "warn", "error"];

function ensureReflectEnv() {
  if (!process.env.REFLECT_HOME) {
    process.env.REFLECT_HOME = DEFAULT_REFLECT_HOME;
  }
}

async function loadReflectSync(): Promise<ReflectSync> {
  if (!reflectSyncPromise) {
    ensureReflectEnv();
    const entry = requireCjs.resolve("reflect-sync");
    const href = pathToFileURL(entry).href;
    reflectSyncPromise = dynamicImport(href) as Promise<ReflectSync>;
  }
  return reflectSyncPromise;
}

function resolveReflectDist(moduleFile: string): string {
  const entry = requireCjs.resolve("reflect-sync");
  const distDir = path.dirname(entry);
  return path.join(distDir, moduleFile);
}

async function importReflectDist<T>(moduleFile: string): Promise<T> {
  const href = pathToFileURL(resolveReflectDist(moduleFile)).href;
  return (await dynamicImport(href)) as T;
}

async function ensureSessionDb(mod: ReflectSync): Promise<string> {
  if (sessionDbPath) return sessionDbPath;
  const dbPath = mod.getSessionDbPath();
  const db = mod.ensureSessionDb(dbPath);
  db.close();
  sessionDbPath = dbPath;
  return dbPath;
}

function isPidAlive(pid?: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function getDaemonLogger(sessionDb: string) {
  if (daemonLogger) return daemonLogger;
  try {
    const mod = await importReflectDist<{
      createDaemonLogger: (
        sessionDbPath: string,
        opts?: { scope?: string; keepMs?: number; keepRows?: number },
      ) => { logger: any; close: () => void };
    }>("daemon-logs.js");
    daemonLogger = mod.createDaemonLogger(sessionDb, {
      scope: "cocalc-plus",
    });
    process.once("exit", () => {
      try {
        daemonLogger?.close();
      } catch {
        // ignore
      }
    });
    return daemonLogger;
  } catch {
    return null;
  }
}

async function logDaemon(
  sessionDb: string,
  level: "debug" | "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>,
) {
  try {
    const logger = await getDaemonLogger(sessionDb);
    const sink = logger?.logger;
    const fn = sink?.[level] ?? sink?.info;
    if (fn && sink) {
      fn.call(sink, message, meta);
      return;
    }
  } catch {
    // ignore daemon logging failures
  }
  try {
    const mod = await loadReflectSync();
    mod.ensureSessionDb(sessionDb);
    const db: any = mod.openSessionDb(sessionDb);
    try {
      const stmt = db.prepare(
        `INSERT INTO daemon_logs(ts, level, scope, message, meta)
         VALUES(?, ?, ?, ?, ?)`,
      );
      stmt.run(
        Date.now(),
        level,
        "cocalc-plus",
        message,
        meta ? JSON.stringify(meta) : null,
      );
    } finally {
      db.close();
    }
  } catch {
    // ignore fallback logging failures
  }
}

function deserializeIgnoreRules(raw?: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => String(entry).trim())
      .filter((entry) => entry.length > 0);
  } catch {
    return [];
  }
}

function parseTarget(target: string): { host: string; port?: number | null } {
  const trimmed = target.trim();
  const match = /^(?:(?<user>[^@]+)@)?(?<host>[^:]+)(?::(?<port>\d+))?$/.exec(
    trimmed,
  );
  if (!match) {
    throw new Error(`Invalid SSH target: ${target}`);
  }
  const user = match.groups?.user;
  const hostPart = match.groups?.host?.trim() ?? "";
  const port = match.groups?.port ? Number(match.groups.port) : undefined;
  if (port != null && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
    throw new Error(`Invalid SSH port in target: ${target}`);
  }
  return {
    host: user ? `${user}@${hostPart}` : hostPart,
    port: port ?? null,
  };
}

function expandLocalPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  if (!path.isAbsolute(trimmed)) {
    return path.join(os.homedir(), trimmed);
  }
  return trimmed;
}

function normalizeLocalPath(input: string): string {
  const expanded = expandLocalPath(input);
  const resolved = path.resolve(expanded);
  return resolved.replace(/\/+$/, "") || "/";
}

function toHomeRelative(absPath: string): string {
  const normalized = absPath.replace(/\/+$/, "") || "/";
  const home = os.homedir().replace(/\/+$/, "") || "/";
  if (normalized === home) {
    return "~";
  }
  if (normalized.startsWith(`${home}/`)) {
    return `~/${normalized.slice(home.length + 1)}`;
  }
  return normalized;
}

function isNestedPath(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function readGitignore(localPath: string): string[] {
  try {
    const gitignorePath = path.join(localPath, ".gitignore");
    const raw = fs.readFileSync(gitignorePath, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch {
    return [];
  }
}

function parseLogMeta(meta: any) {
  if (!meta) return null;
  if (typeof meta === "object") return meta;
  try {
    return JSON.parse(meta);
  } catch {
    return { __error: "failed to parse meta JSON" };
  }
}

function normalizeLogLevels(minLevel?: string) {
  if (!minLevel) return null;
  const idx = LOG_LEVELS.indexOf(minLevel.toLowerCase());
  if (idx === -1) return null;
  return LOG_LEVELS.slice(idx);
}

function resolveNodeBinary(): string {
  const override = process.env.COCALC_REFLECT_NODE_PATH;
  if (override && fs.existsSync(override)) {
    return override;
  }
  const execBase = path.basename(process.execPath);
  if (execBase.startsWith("cocalc-plus")) {
    const sibling = path.join(path.dirname(process.execPath), "node");
    if (fs.existsSync(sibling)) {
      return sibling;
    }
  }
  return process.execPath;
}

function createSessionLogWriter(
  mod: ReflectSync,
  sessionDb: string,
  sessionId: number,
) {
  try {
    const db: any = mod.openSessionDb(sessionDb);
    const stmt = db.prepare(`
      INSERT INTO session_logs(session_id, ts, level, scope, message, meta)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    return {
      log: (
        level: "debug" | "info" | "warn" | "error",
        message: string,
        meta?: Record<string, unknown>,
      ) => {
        stmt.run(
          sessionId,
          Date.now(),
          level,
          "cocalc-plus",
          message,
          meta ? JSON.stringify(meta) : null,
        );
      },
      close: () => {
        try {
          db.close();
        } catch {
          // ignore
        }
      },
    };
  } catch {
    return null;
  }
}

function normalizeRemoteRoot(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) return trimmed;
  return `~/${trimmed}`;
}

function shellEscape(s: string) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

async function ensureRemoteRoot(
  host: string,
  port: number | null | undefined,
  root: string,
) {
  const args = [
    "-o",
    "ConnectTimeout=5",
    "-C",
    "-T",
    "-o",
    "BatchMode=yes",
  ];
  if (port != null) {
    args.push("-p", String(port));
  }
  const target = normalizeRemoteRoot(root);
  const cmd = `mkdir -p -- ${shellEscape(target)}`;
  args.push(host, `sh -lc ${shellEscape(cmd)}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ssh mkdir failed (exit ${code})`));
      }
    });
  });
}

async function ensureRootsExist(
  sessionDb: string,
  row: SessionRow,
  logWriter?: ReturnType<typeof createSessionLogWriter>,
) {
  const tasks: Promise<void>[] = [];
  const localRoots: Array<{ side: "alpha" | "beta"; root: string }> = [];
  const remoteRoots: Array<{
    side: "alpha" | "beta";
    host: string;
    port: number | null | undefined;
    root: string;
  }> = [];

  if (row.alpha_host) {
    remoteRoots.push({
      side: "alpha",
      host: row.alpha_host,
      port: row.alpha_port,
      root: row.alpha_root,
    });
  } else {
    localRoots.push({ side: "alpha", root: row.alpha_root });
  }
  if (row.beta_host) {
    remoteRoots.push({
      side: "beta",
      host: row.beta_host,
      port: row.beta_port,
      root: row.beta_root,
    });
  } else {
    localRoots.push({ side: "beta", root: row.beta_root });
  }

  for (const local of localRoots) {
    const abs = normalizeLocalPath(local.root);
    tasks.push(
      fs.promises
        .mkdir(abs, { recursive: true })
        .then(() =>
          logWriter?.log("info", `ensured local ${local.side} root`, {
            path: abs,
          }),
        )
        .catch((err) => {
          logWriter?.log("error", `failed to create local ${local.side} root`, {
            path: abs,
            error: err?.message || String(err),
          });
          throw err;
        }),
    );
  }

  for (const remote of remoteRoots) {
    tasks.push(
      ensureRemoteRoot(remote.host, remote.port, remote.root)
        .then(() =>
          logWriter?.log("info", `ensured remote ${remote.side} root`, {
            host: remote.host,
            port: remote.port,
            path: remote.root,
          }),
        )
        .catch((err) => {
          logWriter?.log(
            "error",
            `failed to create remote ${remote.side} root`,
            {
              host: remote.host,
              port: remote.port,
              path: remote.root,
              error: err?.message || String(err),
            },
          );
          throw err;
        }),
    );
  }

  if (tasks.length > 0) {
    await Promise.all(tasks);
    await logDaemon(sessionDb, "info", "sync roots ensured", {
      sessionId: row.id,
    });
  }
}

function spawnSchedulerChild(opts: SchedulerOptions): ChildProcess {
  const nodeBin = resolveNodeBinary();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    REFLECT_HOME: process.env.REFLECT_HOME,
    REFLECT_OPTS: JSON.stringify(opts),
  };
  try {
    const entry = requireCjs.resolve("reflect-sync");
    env.REFLECT_SYNC_ENTRY = pathToFileURL(entry).href;
  } catch {
    // ignore - scheduler will try default module resolution
  }
  const execBase = path.basename(process.execPath);
  const useSelfRunner = execBase.startsWith("cocalc-plus");
  if (useSelfRunner) {
    return spawn(process.execPath, ["--run-reflect-scheduler"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  const script =
    "const entry=process.env.REFLECT_SYNC_ENTRY||'reflect-sync';import(entry).then((m)=>m.runScheduler(JSON.parse(process.env.REFLECT_OPTS||'{}'))).catch((err)=>{console.error(err);process.exit(1);});";
  return spawn(nodeBin, ["-e", script], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function buildSchedulerOptions(
  mod: ReflectSync,
  sessionDb: string,
  row: SessionRow,
): SchedulerOptions {
  const home = mod.getReflectSyncHome();
  const paths = mod.deriveSessionPaths(row.id, home);
  const alphaDb = row.alpha_db ?? paths.alpha_db;
  const betaDb = row.beta_db ?? paths.beta_db;
  const baseDb = row.base_db ?? paths.base_db;
  let remoteCommand: string | undefined;
  if (row.remote_scan_cmd) {
    const trimmed = row.remote_scan_cmd.trim();
    remoteCommand = trimmed.replace(/\s+scan\s*$/i, "");
  } else if (row.alpha_host || row.beta_host) {
    remoteCommand =
      process.env.COCALC_REFLECT_REMOTE_COMMAND ??
      "$HOME/.local/bin/cocalc-plus reflect-sync";
  }
  return {
    alphaRoot: row.alpha_root,
    betaRoot: row.beta_root,
    alphaDb,
    betaDb,
    baseDb,
    prefer: (row.prefer ?? "alpha") as "alpha" | "beta",
    dryRun: false,
    hash: row.hash_alg ?? "sha256",
    alphaHost: row.alpha_host ?? undefined,
    alphaPort: row.alpha_port ?? undefined,
    betaHost: row.beta_host ?? undefined,
    betaPort: row.beta_port ?? undefined,
    alphaRemoteDb: row.alpha_remote_db ?? "",
    betaRemoteDb: row.beta_remote_db ?? "",
    remoteCommand,
    disableHotWatch: !!row.disable_hot_sync,
    disableHotSync: !!row.disable_hot_sync,
    disableFullSync: !!row.disable_full_sync,
    enableReflink: !!row.enable_reflink,
    mergeStrategy: row.merge_strategy ?? null,
    compress: row.compress ?? "auto",
    ignoreRules: deserializeIgnoreRules(row.ignore_rules),
    sessionDb,
    sessionId: row.id,
  };
}

async function startSession(
  mod: ReflectSync,
  sessionDb: string,
  row: SessionRow,
) {
  const existing = schedulerChildren.get(row.id);
  if (existing?.pid && isPidAlive(existing.pid)) {
    return;
  }
  if (row.scheduler_pid && isPidAlive(row.scheduler_pid)) {
    return;
  }

  const opts = buildSchedulerOptions(mod, sessionDb, row);
  const logWriter = createSessionLogWriter(mod, sessionDb, row.id);
  await logDaemon(sessionDb, "info", "starting scheduler", {
    sessionId: row.id,
    target: row.name ?? null,
  });
  try {
    await ensureRootsExist(sessionDb, row, logWriter);
  } catch (err: any) {
    await logDaemon(sessionDb, "error", "failed to ensure sync roots", {
      sessionId: row.id,
      error: err?.message || String(err),
    });
    throw err;
  }
  logWriter?.log("info", "starting scheduler");
  const child = spawnSchedulerChild(opts);
  schedulerChildren.set(row.id, child);

  if (child.stdout) {
    child.stdout.on("data", (buf) => {
      const text = String(buf).trim();
      if (text) {
        logWriter?.log("info", text);
      }
    });
  }
  if (child.stderr) {
    child.stderr.on("data", (buf) => {
      const text = String(buf).trim();
      if (text) {
        const level =
          text.includes(" ℹ️ ") || text.includes(" [scheduler.")
            ? "info"
            : "error";
        logWriter?.log(level, text);
      }
    });
  }

  child.on("error", (err) => {
    logWriter?.log("error", "scheduler spawn failed", {
      error: err?.message ?? String(err),
    });
    mod.updateSession(sessionDb, row.id, { scheduler_pid: null });
    mod.setActualState(sessionDb, row.id, "error");
  });

  if (child.pid) {
    mod.updateSession(sessionDb, row.id, { scheduler_pid: child.pid });
    mod.setDesiredState(sessionDb, row.id, "running");
    mod.setActualState(sessionDb, row.id, "running");
    mod.recordHeartbeat(sessionDb, row.id, "running", child.pid);
  } else {
    mod.setActualState(sessionDb, row.id, "error");
  }

  child.once("exit", (code, signal) => {
    schedulerChildren.delete(row.id);
    mod.updateSession(sessionDb, row.id, { scheduler_pid: null });
    mod.setActualState(sessionDb, row.id, "stopped");
    logWriter?.log("warn", "scheduler exited", {
      code,
      signal,
    });
    void logDaemon(sessionDb, "warn", "scheduler exited", {
      sessionId: row.id,
      code,
      signal,
    });
    logWriter?.close();
  });
}

async function stopSession(
  mod: ReflectSync,
  sessionDb: string,
  row: SessionRow,
) {
  const logWriter = createSessionLogWriter(mod, sessionDb, row.id);
  await logDaemon(sessionDb, "info", "stopping scheduler", {
    sessionId: row.id,
  });
  const existing = schedulerChildren.get(row.id);
  if (existing?.pid) {
    existing.kill("SIGTERM");
  } else if (row.scheduler_pid) {
    mod.stopPid(row.scheduler_pid);
  }
  schedulerChildren.delete(row.id);
  mod.updateSession(sessionDb, row.id, { scheduler_pid: null });
  mod.setDesiredState(sessionDb, row.id, "stopped");
  mod.setActualState(sessionDb, row.id, "stopped");
  logWriter?.log("info", "scheduler stopped");
  logWriter?.close();
}

async function reconcileSessions(
  mod: ReflectSync,
  sessionDb: string,
  rows: SessionRow[],
) {
  for (const row of rows) {
    if (row.desired_state === "running") {
      await startSession(mod, sessionDb, row);
    } else {
      if (row.scheduler_pid && isPidAlive(row.scheduler_pid)) {
        await stopSession(mod, sessionDb, row);
      } else if (row.actual_state !== "stopped") {
        mod.updateSession(sessionDb, row.id, { scheduler_pid: null });
        mod.setActualState(sessionDb, row.id, "stopped");
      }
    }
  }
}

function parseSelectorTokens(tokens: string[]): LabelSelector[] {
  const out: LabelSelector[] = [];
  for (const raw of tokens) {
    const s = String(raw ?? "").trim();
    if (!s) continue;
    if (s.startsWith("!")) {
      const rest = s.slice(1);
      if (!rest) continue;
      if (rest.includes("=")) {
        const [k, v] = rest.split("=");
        out.push({ type: "neq", k, v } as LabelSelector);
      } else {
        out.push({ type: "notExists", k: rest } as LabelSelector);
      }
    } else if (s.includes("=")) {
      const [k, v] = s.split("=");
      out.push({ type: "eq", k, v } as LabelSelector);
    } else {
      out.push({ type: "exists", k: s } as LabelSelector);
    }
  }
  return out;
}

function buildSelectors(selectors?: string[], target?: string) {
  const tokens = Array.isArray(selectors) ? [...selectors] : [];
  if (target) {
    tokens.push(`cocalc-plus-target=${target}`);
  }
  return parseSelectorTokens(tokens);
}

function mapSessionRow(row: SessionRow): ReflectSessionRow {
  return {
    id: row.id,
    name: row.name,
    alpha_root: row.alpha_root,
    beta_root: row.beta_root,
    alpha_host: row.alpha_host,
    beta_host: row.beta_host,
    alpha_port: row.alpha_port,
    beta_port: row.beta_port,
    prefer: row.prefer,
    desired_state: row.desired_state,
    actual_state: row.actual_state,
    last_heartbeat: row.last_heartbeat,
    last_clean_sync_at: row.last_clean_sync_at,
    ignore_rules: row.ignore_rules,
    merge_strategy: row.merge_strategy,
  };
}

function mapForwardRow(row: ForwardRow): ReflectForwardRow {
  return {
    id: row.id,
    name: row.name,
    direction: row.direction,
    ssh_host: row.ssh_host,
    ssh_port: row.ssh_port,
    local_host: row.local_host,
    local_port: row.local_port,
    remote_host: row.remote_host,
    remote_port: row.remote_port,
    desired_state: row.desired_state,
    actual_state: row.actual_state,
    monitor_pid: row.monitor_pid,
    last_error: row.last_error,
    ssh_args: row.ssh_args,
  };
}

function installExitHook(mod: ReflectSync, sessionDb: string) {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const handler = () => {
    for (const [id, child] of schedulerChildren.entries()) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      mod.updateSession(sessionDb, id, { scheduler_pid: null });
      mod.setActualState(sessionDb, id, "stopped");
    }
  };
  process.once("exit", handler);
  process.once("SIGINT", () => {
    handler();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    handler();
    process.exit(0);
  });
}

export async function listSessionsUI(opts?: {
  selectors?: string[];
  target?: string;
}): Promise<ReflectSessionRow[]> {
  try {
    const mod = await loadReflectSync();
    const sessionDb = await ensureSessionDb(mod);
    installExitHook(mod, sessionDb);
    await logDaemon(sessionDb, "debug", "listSessionsUI called", {
      target: opts?.target,
    });
    const selectors = buildSelectors(opts?.selectors, opts?.target);
    let rows = mod.selectSessions(sessionDb, selectors) as SessionRow[];
    await reconcileSessions(mod, sessionDb, rows);
    rows = mod.selectSessions(sessionDb, selectors) as SessionRow[];
    return rows.map(mapSessionRow);
  } catch (err: any) {
    throw new Error(`reflect listSessionsUI failed: ${err?.message || err}`);
  }
}

export async function terminateSessionUI(opts: {
  idOrName: string;
  force?: boolean;
}): Promise<void> {
  try {
    const mod = await loadReflectSync();
    const sessionDb = await ensureSessionDb(mod);
    installExitHook(mod, sessionDb);
    const row = mod.resolveSessionRow(sessionDb, opts.idOrName);
    if (!row) {
      throw new Error(`reflect session '${opts.idOrName}' not found`);
    }
    await mod.terminateSession({
      sessionDb,
      id: row.id,
      logger: undefined,
      force: !!opts.force,
    });
  } catch (err: any) {
    throw new Error(`reflect terminateSessionUI failed: ${err?.message || err}`);
  }
}

export async function stopSessionUI(opts: {
  idOrName: string;
}): Promise<void> {
  try {
    const mod = await loadReflectSync();
    const sessionDb = await ensureSessionDb(mod);
    installExitHook(mod, sessionDb);
    await logDaemon(sessionDb, "info", "stopSessionUI", {
      idOrName: opts.idOrName,
    });
    const row = mod.resolveSessionRow(sessionDb, opts.idOrName);
    if (!row) {
      throw new Error(`reflect session '${opts.idOrName}' not found`);
    }
    mod.setDesiredState(sessionDb, row.id, "stopped");
    await stopSession(mod, sessionDb, row);
  } catch (err: any) {
    throw new Error(`reflect stopSessionUI failed: ${err?.message || err}`);
  }
}

export async function startSessionUI(opts: {
  idOrName: string;
}): Promise<void> {
  try {
    const mod = await loadReflectSync();
    const sessionDb = await ensureSessionDb(mod);
    installExitHook(mod, sessionDb);
    await logDaemon(sessionDb, "info", "startSessionUI", {
      idOrName: opts.idOrName,
    });
    const row = mod.resolveSessionRow(sessionDb, opts.idOrName);
    if (!row) {
      throw new Error(`reflect session '${opts.idOrName}' not found`);
    }
    mod.setDesiredState(sessionDb, row.id, "running");
    await startSession(mod, sessionDb, row);
  } catch (err: any) {
    throw new Error(`reflect startSessionUI failed: ${err?.message || err}`);
  }
}

export async function editSessionUI(opts: {
  idOrName: string;
  ignore?: string[];
  prefer?: "alpha" | "beta";
}): Promise<void> {
  try {
    const mod = await loadReflectSync();
    const sessionDb = await ensureSessionDb(mod);
    installExitHook(mod, sessionDb);
    await logDaemon(sessionDb, "info", "editSessionUI", {
      idOrName: opts.idOrName,
    });
    const row = mod.resolveSessionRow(sessionDb, opts.idOrName);
    if (!row) {
      throw new Error(`reflect session '${opts.idOrName}' not found`);
    }
    const restartForPrefer =
      opts.prefer != null &&
      opts.prefer !== row.prefer &&
      row.actual_state === "running";
    if (opts.prefer && opts.prefer !== row.prefer) {
      mod.updateSession(sessionDb, row.id, { prefer: opts.prefer });
    }
    if (opts.ignore) {
      await mod.editSession({
        sessionDb,
        id: row.id,
        resetIgnore: true,
        ignoreAdd: opts.ignore,
      });
    }
    if (restartForPrefer) {
      const refreshed = mod.loadSessionById(sessionDb, row.id) as
        | SessionRow
        | null;
      if (refreshed) {
        await stopSession(mod, sessionDb, refreshed);
        await startSession(mod, sessionDb, refreshed);
      }
    }
  } catch (err: any) {
    throw new Error(`reflect editSessionUI failed: ${err?.message || err}`);
  }
}

export async function listForwardsUI(): Promise<ReflectForwardRow[]> {
  try {
    const mod = await loadReflectSync();
    const sessionDb = await ensureSessionDb(mod);
    installExitHook(mod, sessionDb);
    await logDaemon(sessionDb, "debug", "listForwardsUI called");
    let rows = mod.selectForwardSessions(sessionDb) as ForwardRow[];
    const forwardRunner = await importReflectDist<{
      launchForwardProcess: (
        sessionDb: string,
        row: ForwardRow,
      ) => Promise<number | null>;
    }>("forward-runner.js");
    for (const row of rows) {
      if (row.desired_state !== "running") continue;
      if (row.monitor_pid && isPidAlive(row.monitor_pid)) {
        continue;
      }
      mod.updateForwardSession(sessionDb, row.id, {
        monitor_pid: null,
        actual_state: "stopped",
      });
      const pid = await forwardRunner.launchForwardProcess(sessionDb, row);
      if (pid) {
        await logDaemon(sessionDb, "info", "restarted forward", {
          id: row.id,
          pid,
        });
      } else {
        await logDaemon(sessionDb, "warn", "forward restart failed", {
          id: row.id,
        });
      }
    }
    rows = mod.selectForwardSessions(sessionDb) as ForwardRow[];
    return rows.map(mapForwardRow);
  } catch (err: any) {
    throw new Error(`reflect listForwardsUI failed: ${err?.message || err}`);
  }
}

export async function createSessionUI(opts: {
  alpha?: string;
  beta?: string;
  localPath?: string;
  remotePath?: string;
  name?: string;
  labels?: string[];
  prefer?: "alpha" | "beta";
  ignore?: string[];
  useGitignore?: boolean;
  target?: string;
}): Promise<void> {
  try {
    const mod = await loadReflectSync();
    const sessionDb = await ensureSessionDb(mod);
    installExitHook(mod, sessionDb);
    await logDaemon(sessionDb, "info", "createSessionUI", {
      target: opts.target,
      localPath: opts.localPath,
      remotePath: opts.remotePath,
    });
    const localPath = opts.localPath ?? opts.alpha;
    const remotePath = opts.remotePath ?? opts.beta;
    if (!localPath) {
      throw new Error("Missing local path");
    }
    const labels = Array.isArray(opts.labels) ? [...opts.labels] : [];
    if (opts.target) {
      labels.push(`cocalc-plus-target=${opts.target}`);
    }
    const normalizedLocal = normalizeLocalPath(localPath);
    const existing = mod.selectSessions(
      sessionDb,
      buildSelectors([], opts.target),
    ) as SessionRow[];
    for (const row of existing) {
      const other = normalizeLocalPath(row.alpha_root);
      if (isNestedPath(normalizedLocal, other)) {
        throw new Error(
          `Local path overlaps existing sync: ${row.alpha_root}`,
        );
      }
    }
    const ignoreRules = [
      ...(opts.useGitignore ? readGitignore(normalizedLocal) : []),
      ...(opts.ignore ?? []),
    ].filter((entry) => entry && entry.trim());
    let betaSpec =
      remotePath ??
      (opts.target ? toHomeRelative(normalizedLocal) : normalizedLocal);
    if (
      opts.target &&
      remotePath &&
      !remotePath.startsWith("/") &&
      !remotePath.startsWith("~")
    ) {
      betaSpec = `~/${remotePath}`;
    }
    if (opts.target) {
      const { host, port } = parseTarget(opts.target);
      const hostSpec = `${host}${port ? `:${port}` : ""}`;
      betaSpec = `${hostSpec}:${betaSpec}`;
    }
    const id = await mod.newSession({
      alphaSpec: normalizedLocal,
      betaSpec,
      sessionDb,
      compress: "auto",
      compressLevel: "",
      prefer: opts.prefer ?? "alpha",
      hash: "sha256",
      label: labels,
      name: opts.name,
      ignore: ignoreRules,
      logger: undefined,
    });
    if (opts.target) {
      const remoteBase =
        process.env.COCALC_REFLECT_REMOTE_COMMAND ??
        "$HOME/.local/bin/cocalc-plus reflect-sync";
      mod.updateSession(sessionDb, id, {
        remote_scan_cmd: `${remoteBase} scan`,
        remote_watch_cmd: `${remoteBase} watch`,
      });
    }
    const row = mod.loadSessionById(sessionDb, id) as SessionRow | null;
    if (row) {
      mod.setDesiredState(sessionDb, id, "running");
      await startSession(mod, sessionDb, row);
    }
  } catch (err: any) {
    throw new Error(`reflect createSessionUI failed: ${err?.message || err}`);
  }
}

export async function createForwardUI(opts: {
  target: string;
  localPort: number;
  remotePort?: number;
  direction?: "remote_to_local" | "local_to_remote";
  name?: string;
}): Promise<void> {
  try {
    const mod = await loadReflectSync();
    const sessionDb = await ensureSessionDb(mod);
    installExitHook(mod, sessionDb);
    await logDaemon(sessionDb, "info", "createForwardUI", {
      target: opts.target,
      localPort: opts.localPort,
      remotePort: opts.remotePort,
    });
    const { host, port } = parseTarget(opts.target);
    const remotePort = opts.remotePort ?? opts.localPort;
    const remoteSpec = `${host}${port ? `:${port}` : ""}:${remotePort}`;
    const localSpec = `127.0.0.1:${opts.localPort}`;
    const direction = opts.direction ?? "remote_to_local";
    const left =
      direction === "remote_to_local" ? remoteSpec : localSpec;
    const right =
      direction === "remote_to_local" ? localSpec : remoteSpec;
    await mod.createForward({
      sessionDb,
      name: opts.name,
      left,
      right,
      compress: false,
      logger: undefined,
    });
  } catch (err: any) {
    throw new Error(`reflect createForwardUI failed: ${err?.message || err}`);
  }
}

export async function terminateForwardUI(opts: {
  id: number;
}): Promise<void> {
  try {
    const mod = await loadReflectSync();
    const sessionDb = await ensureSessionDb(mod);
    installExitHook(mod, sessionDb);
    await logDaemon(sessionDb, "info", "terminateForwardUI", {
      id: opts.id,
    });
    mod.terminateForward(sessionDb, opts.id, undefined);
  } catch (err: any) {
    throw new Error(`reflect terminateForwardUI failed: ${err?.message || err}`);
  }
}

export async function reflectVersion(): Promise<string> {
  try {
    const entry = requireCjs.resolve("reflect-sync");
    const pkgPath = path.resolve(entry, "..", "..", "package.json");
    const raw = fs.readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw);
    return pkg?.version ?? "unknown";
  } catch (err: any) {
    console.warn(
      `reflectVersion: failed to resolve reflect-sync version: ${err?.message || err}`,
    );
    return "unknown";
  }
}

export async function listSessionLogsUI(opts: {
  idOrName: string;
  limit?: number;
  sinceTs?: number;
  afterId?: number;
  order?: "asc" | "desc";
  minLevel?: string;
  scope?: string;
  message?: string;
}): Promise<ReflectSessionLogRow[]> {
  const mod = await loadReflectSync();
  const sessionDb = await ensureSessionDb(mod);
  const session = mod.resolveSessionRow(sessionDb, opts.idOrName);
  if (!session) {
    throw new Error(`reflect session '${opts.idOrName}' not found`);
  }
  const db: any = mod.openSessionDb(sessionDb);
  try {
    const where: string[] = ["session_id = ?"];
    const params: any[] = [session.id];
    if (typeof opts.afterId === "number") {
      where.push("id > ?");
      params.push(opts.afterId);
    }
    if (typeof opts.sinceTs === "number") {
      where.push("ts >= ?");
      params.push(opts.sinceTs);
    }
    const levels = normalizeLogLevels(opts.minLevel);
    if (levels) {
      where.push(`level IN (${levels.map(() => "?").join(",")})`);
      params.push(...levels);
    }
    if (opts.scope) {
      where.push("scope = ?");
      params.push(opts.scope);
    }
    if (opts.message) {
      where.push("message = ?");
      params.push(opts.message);
    }
    const order = opts.order === "desc" ? "DESC" : "ASC";
    const limit = Math.max(1, opts.limit ?? 200);
    const stmt = db.prepare(`SELECT id, session_id, ts, level, scope, message, meta
       FROM session_logs
      WHERE ${where.join(" AND ")}
      ORDER BY id ${order}
      LIMIT ?`);
    const rows = stmt.all(...params, limit);
    return rows.map((row: any) => ({
      ...row,
      meta: parseLogMeta(row.meta),
    }));
  } finally {
    db.close();
  }
}

export async function listDaemonLogsUI(opts?: {
  limit?: number;
  sinceTs?: number;
  afterId?: number;
  order?: "asc" | "desc";
  minLevel?: string;
  scope?: string;
  message?: string;
}): Promise<ReflectLogRow[]> {
  const mod = await loadReflectSync();
  const sessionDb = await ensureSessionDb(mod);
  await logDaemon(sessionDb, "debug", "listDaemonLogsUI");
  const db: any = mod.openSessionDb(sessionDb);
  try {
    const where: string[] = ["1 = 1"];
    const params: any[] = [];
    if (typeof opts?.afterId === "number") {
      where.push("id > ?");
      params.push(opts.afterId);
    }
    if (typeof opts?.sinceTs === "number") {
      where.push("ts >= ?");
      params.push(opts.sinceTs);
    }
    const levels = normalizeLogLevels(opts?.minLevel);
    if (levels) {
      where.push(`level IN (${levels.map(() => "?").join(",")})`);
      params.push(...levels);
    }
    if (opts?.scope) {
      where.push("scope = ?");
      params.push(opts.scope);
    }
    if (opts?.message) {
      where.push("message = ?");
      params.push(opts.message);
    }
    const order = opts?.order === "desc" ? "DESC" : "ASC";
    const limit = Math.max(1, opts?.limit ?? 200);
    const stmt = db.prepare(`SELECT id, ts, level, scope, message, meta
       FROM daemon_logs
      WHERE ${where.join(" AND ")}
      ORDER BY id ${order}
      LIMIT ?`);
    const rows = stmt.all(...params, limit);
    return rows.map((row: any) => ({
      ...row,
      meta: parseLogMeta(row.meta),
    }));
  } finally {
    db.close();
  }
}
