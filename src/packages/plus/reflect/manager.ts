import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type {
  ReflectForwardRow,
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

function ensureReflectEnv() {
  if (!process.env.REFLECT_HOME) {
    process.env.REFLECT_HOME = DEFAULT_REFLECT_HOME;
  }
}

async function loadReflectSync(): Promise<ReflectSync> {
  if (!reflectSyncPromise) {
    ensureReflectEnv();
    reflectSyncPromise = import("reflect-sync") as Promise<ReflectSync>;
  }
  return reflectSyncPromise;
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

function spawnSchedulerChild(opts: SchedulerOptions): ChildProcess {
  const nodeBin = resolveNodeBinary();
  const env = {
    ...process.env,
    REFLECT_HOME: process.env.REFLECT_HOME,
    REFLECT_OPTS: JSON.stringify(opts),
  };
  const execBase = path.basename(process.execPath);
  const useSelfRunner = execBase.startsWith("cocalc-plus");
  if (useSelfRunner) {
    return spawn(process.execPath, ["--run-reflect-scheduler"], {
      env,
      stdio: ["ignore", "ignore", "ignore"],
    });
  }
  const script =
    "import('reflect-sync').then((m)=>m.runScheduler(JSON.parse(process.env.REFLECT_OPTS||'{}'))).catch((err)=>{console.error(err);process.exit(1);});";
  return spawn(nodeBin, ["-e", script], {
    env,
    stdio: ["ignore", "ignore", "ignore"],
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
    remoteCommand: row.remote_scan_cmd ?? undefined,
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
  const child = spawnSchedulerChild(opts);
  schedulerChildren.set(row.id, child);

  if (child.pid) {
    mod.updateSession(sessionDb, row.id, { scheduler_pid: child.pid });
    mod.setDesiredState(sessionDb, row.id, "running");
    mod.setActualState(sessionDb, row.id, "running");
    mod.recordHeartbeat(sessionDb, row.id, "running", child.pid);
  } else {
    mod.setActualState(sessionDb, row.id, "error");
  }

  child.once("exit", () => {
    schedulerChildren.delete(row.id);
    mod.updateSession(sessionDb, row.id, { scheduler_pid: null });
    mod.setActualState(sessionDb, row.id, "stopped");
  });
}

async function stopSession(
  mod: ReflectSync,
  sessionDb: string,
  row: SessionRow,
) {
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
  const mod = await loadReflectSync();
  const sessionDb = await ensureSessionDb(mod);
  installExitHook(mod, sessionDb);
  const selectors = buildSelectors(opts?.selectors, opts?.target);
  let rows = mod.selectSessions(sessionDb, selectors) as SessionRow[];
  await reconcileSessions(mod, sessionDb, rows);
  rows = mod.selectSessions(sessionDb, selectors) as SessionRow[];
  return rows.map(mapSessionRow);
}

export async function listForwardsUI(): Promise<ReflectForwardRow[]> {
  const mod = await loadReflectSync();
  const sessionDb = await ensureSessionDb(mod);
  installExitHook(mod, sessionDb);
  const rows = mod.selectForwardSessions(sessionDb) as ForwardRow[];
  return rows.map(mapForwardRow);
}

export async function createSessionUI(opts: {
  alpha: string;
  beta: string;
  name?: string;
  labels?: string[];
  target?: string;
}): Promise<void> {
  const mod = await loadReflectSync();
  const sessionDb = await ensureSessionDb(mod);
  installExitHook(mod, sessionDb);
  const labels = Array.isArray(opts.labels) ? [...opts.labels] : [];
  if (opts.target) {
    labels.push(`cocalc-plus-target=${opts.target}`);
  }
  const id = await mod.newSession({
    alphaSpec: opts.alpha,
    betaSpec: opts.beta,
    sessionDb,
    compress: "auto",
    compressLevel: "",
    prefer: "alpha",
    hash: "sha256",
    label: labels,
    name: opts.name,
    ignore: [],
    logger: undefined,
  });
  const row = mod.loadSessionById(sessionDb, id) as SessionRow | null;
  if (row) {
    mod.setDesiredState(sessionDb, id, "running");
    await startSession(mod, sessionDb, row);
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
