import getLogger from "@cocalc/backend/logger";
import { readFile } from "node:fs/promises";
import { type BtrfsQuotaMode, btrfsQuotaMode } from "./config";
import { btrfs } from "./util";

const logger = getLogger("file-server:btrfs:quota-mode");

export type ActiveBtrfsQuotaMode = Exclude<BtrfsQuotaMode, "disabled">;

export type BtrfsQuotaRuntimeStatus =
  | {
      enabled: false;
      mode: "disabled";
    }
  | {
      enabled: true;
      mode: ActiveBtrfsQuotaMode;
    };

function quotasNotEnabled(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized.includes("quota not enabled") ||
    normalized.includes("quotas not enabled")
  );
}

function parseBtrfsFilesystemUuid(stdout: string): string | undefined {
  const match = stdout.match(/\buuid:\s*([0-9a-f-]{36})\b/i);
  return match?.[1]?.toLowerCase();
}

async function getBtrfsQuotaSysfsStatus(
  mount: string,
): Promise<BtrfsQuotaRuntimeStatus | undefined> {
  const { stdout } = await btrfs({
    args: ["filesystem", "show", mount],
    verbose: false,
  });
  const uuid = parseBtrfsFilesystemUuid(stdout);
  if (!uuid) {
    logger.warn("unable to parse btrfs filesystem UUID", {
      mount,
      stdout: stdout.trim(),
    });
    return;
  }
  const base = `/sys/fs/btrfs/${uuid}/qgroups`;
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
  return { enabled: true, mode: "qgroup" };
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
  return { enabled: true, mode: "qgroup" };
}

export function btrfsQuotaEnableArgs(
  mount: string,
  mode: ActiveBtrfsQuotaMode,
): string[] {
  return mode === "simple"
    ? ["quota", "enable", "--simple", mount]
    : ["quota", "enable", mount];
}

export async function getBtrfsQuotaRuntimeStatus(
  mount: string,
): Promise<BtrfsQuotaRuntimeStatus> {
  const sysfsStatus = await getBtrfsQuotaSysfsStatus(mount);
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
  const configuredMode = btrfsQuotaMode();
  return {
    enabled: true,
    mode: configuredMode === "simple" ? "simple" : "qgroup",
  };
}

export async function ensureBtrfsQuotaMode(
  mount: string,
): Promise<BtrfsQuotaRuntimeStatus> {
  const desiredMode = btrfsQuotaMode();
  const current = await getBtrfsQuotaRuntimeStatus(mount);

  if (desiredMode === "disabled") {
    if (current.enabled) {
      await btrfs({
        args: ["quota", "disable", mount],
        verbose: false,
      });
    }
    return { enabled: false, mode: "disabled" };
  }

  if (current.enabled && current.mode === desiredMode) {
    return current;
  }

  if (current.enabled) {
    await btrfs({
      args: ["quota", "disable", mount],
      verbose: false,
    });
  }

  await btrfs({
    args: btrfsQuotaEnableArgs(mount, desiredMode),
    verbose: false,
  });

  const status = await getBtrfsQuotaRuntimeStatus(mount);
  if (!status.enabled || status.mode !== desiredMode) {
    throw new Error(
      `btrfs quota mode ${desiredMode} was not active after enable on ${mount}`,
    );
  }
  return status;
}
