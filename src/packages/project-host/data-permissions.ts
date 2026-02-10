import { chmod, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("project-host:data-permissions");

const DEFAULT_SWEEP_MS = 2 * 60 * 1000;
const MIN_SWEEP_MS = 30 * 1000;

const PRIVATE_DIRS = ["secrets", "cache", "sync", "rustic", "backup-index"];
const PRIVATE_FILES = ["log", "daemon.pid"];
const SQLITE_PATTERN =
  /^(sqlite\.db|sync-fs\.sqlite)(?:-(?:wal|shm))?$/;

function splitRunnerMode(): boolean {
  const runner =
    `${process.env.COCALC_PODMAN_RUN_AS_USER ?? process.env.COCALC_PROJECT_RUNNER_USER ?? ""}`.trim();
  if (!runner) return false;
  const current =
    `${process.env.COCALC_PROJECT_HOST_USER ?? process.env.USER ?? process.env.LOGNAME ?? ""}`.trim();
  return !!current && runner !== current;
}

function enabled(): boolean {
  const raw = `${process.env.COCALC_HARDEN_DATA_PERMISSIONS ?? "yes"}`
    .trim()
    .toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

function sweepMs(): number {
  const raw = Number(process.env.COCALC_HARDEN_DATA_PERMISSIONS_SWEEP_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SWEEP_MS;
  return Math.max(MIN_SWEEP_MS, Math.floor(raw));
}

async function chmodIfExists(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch {
    // best effort
  }
}

async function hardenDataPermissions(dataDir: string): Promise<void> {
  const split = splitRunnerMode();
  // In split runner mode, the runner user must traverse dataDir to reach
  // rootless podman runtime/storage under dataDir.
  await chmodIfExists(dataDir, split ? 0o711 : 0o700);
  await chmodIfExists(join(dataDir, "project-roots"), split ? 0o711 : 0o700);
  if (split) {
    await chmodIfExists(dirname(dataDir), 0o711);
    await chmodIfExists(join(dataDir, "containers"), 0o711);
    await chmodIfExists(join(dataDir, "containers", "rootless"), 0o711);
  }
  for (const dir of PRIVATE_DIRS) {
    await chmodIfExists(join(dataDir, dir), 0o700);
  }
  await chmodIfExists(join(dataDir, "tmp"), 0o1777);
  for (const file of PRIVATE_FILES) {
    await chmodIfExists(join(dataDir, file), 0o600);
  }
  try {
    const entries = await readdir(dataDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!SQLITE_PATTERN.test(entry.name)) continue;
      await chmodIfExists(join(dataDir, entry.name), 0o600);
    }
  } catch {
    // best effort
  }
}

export function startDataPermissionHardener(dataDir: string): () => void {
  if (!enabled()) {
    logger.info("data permission hardener disabled");
    return () => {};
  }

  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await hardenDataPermissions(dataDir);
    } catch (err) {
      logger.debug("data permission hardener sweep failed", { err: `${err}` });
    } finally {
      running = false;
    }
  };

  const interval = setInterval(() => {
    void run();
  }, sweepMs());
  interval.unref();
  void run();

  logger.info("started data permission hardener", {
    dataDir,
    sweepMs: sweepMs(),
  });

  return () => clearInterval(interval);
}
