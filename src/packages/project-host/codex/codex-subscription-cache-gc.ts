import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import getLogger from "@cocalc/backend/logger";
import { codexSubscriptionsPath } from "@cocalc/backend/data";

const logger = getLogger("project-host:codex-subscription-cache-gc");

const LAST_USED_MARKER = ".last_used";
const DEFAULT_TTL_MS = 72 * 60 * 60 * 1000;
const DEFAULT_SWEEP_MS = 60 * 60 * 1000;
const MIN_SWEEP_MS = 60 * 1000;

function resolveRoot(): string {
  return (
    process.env.COCALC_CODEX_AUTH_SUBSCRIPTION_HOME_ROOT ??
    codexSubscriptionsPath
  );
}

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
): number {
  if (!raw?.trim()) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function execPodman(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("podman", args, { encoding: "utf8" }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout ?? "");
    });
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function normalizePath(path: string): Promise<string> {
  try {
    return await fs.realpath(path);
  } catch {
    return path;
  }
}

async function getActiveSubscriptionHomes(): Promise<Set<string> | undefined> {
  try {
    const psRaw = await execPodman([
      "ps",
      "--filter",
      "name=codex-",
      "--format",
      "json",
    ]);
    const parsed = psRaw.trim() ? JSON.parse(psRaw) : [];
    const ids = (Array.isArray(parsed) ? parsed : [])
      .map((x: any) => x?.Id ?? x?.ID)
      .filter((x: any) => typeof x === "string" && x.length > 0);
    if (!ids.length) return new Set();

    const inspectRaw = await execPodman(["inspect", ...ids, "--format", "json"]);
    const inspect = inspectRaw.trim() ? JSON.parse(inspectRaw) : [];
    const active = new Set<string>();
    for (const container of Array.isArray(inspect) ? inspect : []) {
      const mounts = container?.Mounts;
      if (!Array.isArray(mounts)) continue;
      for (const mount of mounts) {
        if (mount?.Destination !== "/root/.codex") continue;
        if (typeof mount?.Source === "string" && mount.Source) {
          active.add(await normalizePath(mount.Source));
        }
      }
    }
    return active;
  } catch (err) {
    logger.warn("failed to inspect active codex containers; skipping GC tick", {
      err: `${err}`,
    });
    return undefined;
  }
}

async function lastUsedMs(homePath: string): Promise<number> {
  const candidates = [
    join(homePath, LAST_USED_MARKER),
    join(homePath, "auth.json"),
    join(homePath, "config.toml"),
    homePath,
  ];
  for (const path of candidates) {
    try {
      const stat = await fs.stat(path);
      return stat.mtimeMs;
    } catch {
      // continue
    }
  }
  return 0;
}

async function listSubscriptionHomes(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => join(root, e.name));
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

async function sweepOnce(ttlMs: number): Promise<void> {
  const root = resolveRoot();
  if (!(await pathExists(root))) return;

  const activeHomes = await getActiveSubscriptionHomes();
  if (!activeHomes) {
    return;
  }

  const homes = await listSubscriptionHomes(root);
  if (!homes.length) return;

  const now = Date.now();
  let removed = 0;
  for (const homePath of homes) {
    const normalized = await normalizePath(homePath);
    if (activeHomes.has(normalized)) continue;
    const used = await lastUsedMs(homePath);
    if (!used) continue;
    if (now - used <= ttlMs) continue;
    try {
      await fs.rm(homePath, { recursive: true, force: true });
      removed += 1;
      logger.info("removed stale codex subscription cache", {
        homePath,
        ageMs: now - used,
      });
    } catch (err) {
      logger.warn("failed to remove stale codex subscription cache", {
        homePath,
        err: `${err}`,
      });
    }
  }
  if (removed > 0) {
    logger.info("codex subscription cache GC sweep complete", {
      removed,
      root,
      ttlMs,
    });
  }
}

export async function touchSubscriptionCacheUsage(codexHome: string): Promise<void> {
  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
  const marker = join(codexHome, LAST_USED_MARKER);
  const now = new Date();
  try {
    await fs.utimes(marker, now, now);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
    await fs.writeFile(marker, "", { mode: 0o600 });
  }
}

export function startCodexSubscriptionCacheGc(): () => void {
  const ttlMs = parsePositiveInt(
    process.env.COCALC_CODEX_SUBSCRIPTION_CACHE_TTL_MS,
    DEFAULT_TTL_MS,
  );
  const sweepMs = Math.max(
    MIN_SWEEP_MS,
    parsePositiveInt(
      process.env.COCALC_CODEX_SUBSCRIPTION_CACHE_SWEEP_MS,
      DEFAULT_SWEEP_MS,
    ),
  );
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sweepOnce(ttlMs);
    } catch (err) {
      logger.warn("codex subscription cache GC tick failed", {
        err: `${err}`,
      });
    } finally {
      running = false;
    }
  };

  const maxJitter = Math.min(5 * 60 * 1000, Math.floor(sweepMs / 2));
  const initialDelay = maxJitter > 0 ? Math.floor(Math.random() * maxJitter) : 0;
  const initial = setTimeout(() => {
    void tick();
  }, initialDelay);
  initial.unref();

  const timer = setInterval(() => {
    void tick();
  }, sweepMs);
  timer.unref();

  logger.info("started codex subscription cache GC", {
    root: resolveRoot(),
    ttlMs,
    sweepMs,
    initialDelayMs: initialDelay,
  });

  return () => {
    clearTimeout(initial);
    clearInterval(timer);
  };
}
