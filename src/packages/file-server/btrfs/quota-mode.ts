import getLogger from "@cocalc/backend/logger";
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
  const result = await btrfs({
    args: ["quota", "status", mount],
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
