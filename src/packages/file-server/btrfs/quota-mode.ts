import getLogger from "@cocalc/backend/logger";
import { readFile } from "node:fs/promises";
import { release } from "node:os";
import { type BtrfsQuotaMode, btrfsQuotaMode } from "./config";
import { btrfs } from "./util";

const logger = getLogger("file-server:btrfs:quota-mode");
const DEFAULT_QUOTA_MODE_CACHE_MS = 5 * 60_000;

type LegacyRuntimeQuotaMode = "legacy-qgroup";
export type ActiveBtrfsQuotaMode = Exclude<BtrfsQuotaMode, "disabled">;

export type BtrfsQuotaRuntimeStatus =
  | {
      enabled: false;
      mode: "disabled";
    }
  | {
      enabled: true;
      mode: ActiveBtrfsQuotaMode | LegacyRuntimeQuotaMode;
    };

type QuotaModeCacheEntry = {
  expires: number;
  details: BtrfsQuotaRuntimeDetails;
};

const quotaModeCache = new Map<string, QuotaModeCacheEntry>();
const quotaModeInflight = new Map<string, Promise<BtrfsQuotaRuntimeDetails>>();

export interface BtrfsQuotaRuntimeDetails {
  status: BtrfsQuotaRuntimeStatus;
  filesystem_uuid: string;
  reconciled: boolean;
}

function quotaModeCacheMs(): number {
  const configured = Number.parseInt(
    `${process.env.COCALC_BTRFS_QUOTA_MODE_CACHE_MS ?? ""}`,
    10,
  );
  if (Number.isFinite(configured) && configured >= 0) {
    return configured;
  }
  return DEFAULT_QUOTA_MODE_CACHE_MS;
}

function quotasNotEnabled(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized.includes("quota not enabled") ||
    normalized.includes("quotas not enabled")
  );
}

export function parseBtrfsFilesystemUuid(stdout: string): string | undefined {
  const match = stdout.match(/\buuid:\s*([0-9a-f-]{36})\b/i);
  return match?.[1]?.toLowerCase();
}

export async function getBtrfsFilesystemUuid(mount: string): Promise<string> {
  const { stdout } = await btrfs({
    args: ["filesystem", "show", mount],
    verbose: false,
  });
  const uuid = parseBtrfsFilesystemUuid(stdout);
  if (!uuid) {
    throw new Error(`unable to parse Btrfs filesystem UUID for ${mount}`);
  }
  return uuid;
}

async function getBtrfsQuotaSysfsStatus(
  filesystemUuid: string,
): Promise<BtrfsQuotaRuntimeStatus | undefined> {
  const base = `/sys/fs/btrfs/${filesystemUuid}/qgroups`;
  try {
    const enabled = (await readFile(`${base}/enabled`, "utf8"))
      .trim()
      .toLowerCase();
    if (enabled === "0" || enabled === "no" || enabled === "false") {
      return { enabled: false, mode: "disabled" };
    }
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { enabled: false, mode: "disabled" };
    }
    throw err;
  }
  try {
    const mode = (await readFile(`${base}/mode`, "utf8")).trim().toLowerCase();
    if (mode.includes("simple") || mode.includes("squota")) {
      return { enabled: true, mode: "simple" };
    }
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      throw err;
    }
  }
  return { enabled: true, mode: "legacy-qgroup" };
}

export function parseBtrfsQuotaStatus(
  stdout: string,
): BtrfsQuotaRuntimeStatus | undefined {
  const enabledMatch = stdout.match(/^\s*Enabled:\s*(yes|no)\s*$/im);
  if (!enabledMatch?.[1]) return;
  if (enabledMatch[1].toLowerCase() === "no") {
    return { enabled: false, mode: "disabled" };
  }
  const modeMatch = stdout.match(/^\s*Mode:\s*(.+?)\s*$/im);
  const modeText = `${modeMatch?.[1] ?? ""}`.trim().toLowerCase();
  if (modeText.includes("simple") || modeText.includes("squota")) {
    return { enabled: true, mode: "simple" };
  }
  return { enabled: true, mode: "legacy-qgroup" };
}

// Simple quotas need Linux 6.7; older kernels reject them with EINVAL (e.g.
// the WSL2 kernel behind Docker Desktop on Windows, 6.6 in 2026). Hosts that
// set COCALC_BTRFS_UNSUPPORTED_QUOTA_MODE=disabled (CoCalc Star) then run
// without per-project disk quotas; every other host fails as before, since it
// must not run unbounded projects and must never fall back to legacy qgroups.
export function simpleQuotasUnsupported(err: unknown): boolean {
  return /invalid argument/i.test(`${(err as any)?.message ?? err}`);
}

function disableQuotasWhenUnsupported(): boolean {
  return (
    `${process.env.COCALC_BTRFS_UNSUPPORTED_QUOTA_MODE ?? ""}`
      .trim()
      .toLowerCase() === "disabled"
  );
}

export function btrfsQuotaEnableArgs(mount: string): string[] {
  return ["quota", "enable", "--simple", mount];
}

export async function getBtrfsQuotaRuntimeStatus(
  mount: string,
  filesystemUuid?: string,
): Promise<BtrfsQuotaRuntimeStatus> {
  const sysfsStatus = await getBtrfsQuotaSysfsStatus(
    filesystemUuid ?? (await getBtrfsFilesystemUuid(mount)),
  );
  if (sysfsStatus) {
    return sysfsStatus;
  }
  const result = await btrfs({
    args: ["qgroup", "show", "-pcre", mount],
    err_on_exit: false,
    verbose: false,
  });
  const parsed = parseBtrfsQuotaStatus(result.stdout);
  if (parsed) {
    return parsed;
  }
  const stderr = `${result.stderr ?? ""}`;
  if (quotasNotEnabled(stderr)) {
    return { enabled: false, mode: "disabled" };
  }
  if (result.exit_code) {
    throw new Error(
      `unable to determine btrfs quota status for ${mount}: ${stderr || result.stdout || result.exit_code}`,
    );
  }
  logger.warn("unable to parse btrfs quota status output; assuming enabled", {
    mount,
    stdout: result.stdout.trim(),
  });
  return {
    enabled: true,
    mode: "legacy-qgroup",
  };
}

async function reconcileBtrfsQuotaMode(
  mount: string,
): Promise<BtrfsQuotaRuntimeDetails> {
  const filesystem_uuid = await getBtrfsFilesystemUuid(mount);
  const desiredMode = btrfsQuotaMode();
  const current = await getBtrfsQuotaRuntimeStatus(mount, filesystem_uuid);

  if (desiredMode === "disabled") {
    if (current.enabled) {
      await btrfs({
        args: ["quota", "disable", mount],
        verbose: false,
      });
    }
    return {
      status: { enabled: false, mode: "disabled" },
      filesystem_uuid,
      reconciled: current.enabled,
    };
  }

  if (current.enabled && current.mode === desiredMode) {
    return { status: current, filesystem_uuid, reconciled: false };
  }

  // Deliberately migrate any existing qgroup-based filesystem to simple quotas.
  // We keep detection code here only so startup can force hosts away from the
  // qgroup mode that caused severe latency and stability problems for CoCalc.
  if (current.enabled) {
    await btrfs({
      args: ["quota", "disable", mount],
      verbose: false,
    });
  }

  try {
    await btrfs({
      args: btrfsQuotaEnableArgs(mount),
      verbose: false,
    });
  } catch (err) {
    if (!simpleQuotasUnsupported(err) || !disableQuotasWhenUnsupported()) {
      throw err;
    }
    // Everything in this process (and processes it starts) now treats
    // quotas as disabled, like COCALC_BTRFS_QUOTA_MODE=disabled.
    process.env.COCALC_BTRFS_QUOTA_MODE = "disabled";
    logger.warn(
      "btrfs simple quotas are not supported by this kernel; running without per-project disk quotas",
      { mount, kernel: release() },
    );
    return {
      status: { enabled: false, mode: "disabled" },
      filesystem_uuid,
      reconciled: current.enabled,
    };
  }

  const status = await getBtrfsQuotaRuntimeStatus(mount, filesystem_uuid);
  if (!status.enabled || status.mode !== desiredMode) {
    throw new Error(
      `btrfs quota mode ${desiredMode} was not active after enable on ${mount}`,
    );
  }
  return { status, filesystem_uuid, reconciled: true };
}

export async function ensureBtrfsQuotaModeDetails(
  mount: string,
): Promise<BtrfsQuotaRuntimeDetails> {
  const now = Date.now();
  const cached = quotaModeCache.get(mount);
  if (cached && cached.expires > now) {
    return cached.details;
  }
  const pending = quotaModeInflight.get(mount);
  if (pending) {
    return await pending;
  }
  const promise = reconcileBtrfsQuotaMode(mount);
  quotaModeInflight.set(mount, promise);
  try {
    const status = await promise;
    const ttlMs = quotaModeCacheMs();
    if (ttlMs > 0) {
      quotaModeCache.set(mount, {
        expires: Date.now() + ttlMs,
        details: status,
      });
    }
    return status;
  } finally {
    if (quotaModeInflight.get(mount) === promise) {
      quotaModeInflight.delete(mount);
    }
  }
}

export async function ensureBtrfsQuotaMode(
  mount: string,
): Promise<BtrfsQuotaRuntimeStatus> {
  return (await ensureBtrfsQuotaModeDetails(mount)).status;
}

export function invalidateBtrfsQuotaMode(mount: string): void {
  quotaModeCache.delete(mount);
}

export function clearBtrfsQuotaModeCacheForTest(): void {
  quotaModeCache.clear();
  quotaModeInflight.clear();
}
