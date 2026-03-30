import { executeCode } from "@cocalc/backend/execute-code";
import getLogger from "@cocalc/backend/logger";
import type { HostCurrentMetrics } from "@cocalc/conat/hub/api/hosts";
import { dirname } from "node:path";

const logger = getLogger("project-host:storage-metrics");

const DEFAULT_STORAGE_MOUNT = "/mnt/cocalc";
const COMMAND_TIMEOUT_S = Math.max(
  5,
  Number(process.env.COCALC_PROJECT_HOST_METRICS_COMMAND_TIMEOUT_S ?? 20),
);

function parseNonNegativeNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

export function resolveStorageMount(): string {
  const explicit = `${process.env.COCALC_FILE_SERVER_MOUNTPOINT ?? ""}`.trim();
  if (explicit) return explicit;
  const dataDir =
    `${process.env.COCALC_DATA ?? ""}`.trim() ||
    `${process.env.DATA ?? ""}`.trim();
  if (dataDir) return dirname(dataDir);
  return DEFAULT_STORAGE_MOUNT;
}

async function runCommand(
  command: string,
  args: string[],
): Promise<string | undefined> {
  try {
    const result = await executeCode({
      command,
      args,
      timeout: COMMAND_TIMEOUT_S,
      err_on_exit: false,
      env: {
        ...process.env,
        LC_ALL: "C.UTF-8",
        LANG: "C.UTF-8",
      },
    });
    if (result.exit_code !== 0) {
      logger.debug("storage metrics command failed", {
        command,
        args,
        exit_code: result.exit_code,
        stderr: result.stderr,
      });
      return undefined;
    }
    return `${result.stdout ?? ""}`;
  } catch (err) {
    logger.debug("storage metrics command errored", {
      command,
      args,
      err: `${err}`,
    });
    return undefined;
  }
}

function extractFirstNumber(
  output: string,
  pattern: RegExp,
): number | undefined {
  const match = pattern.exec(output);
  return match ? parseNonNegativeNumber(match[1]) : undefined;
}

export function parseBtrfsUsageOutput(
  output: string,
): Partial<HostCurrentMetrics> {
  const disk_device_total_bytes = extractFirstNumber(
    output,
    /^\s*Device size:\s+([0-9]+)/m,
  );
  const disk_device_used_bytes = extractFirstNumber(
    output,
    /^\s*Used:\s+([0-9]+)/m,
  );
  const disk_unallocated_bytes = extractFirstNumber(
    output,
    /^\s*Device unallocated:\s+([0-9]+)/m,
  );
  const btrfs_data_total_bytes = extractFirstNumber(
    output,
    /^Data,[^:]+:\s+Size:([0-9]+),\s+Used:[0-9]+/m,
  );
  const btrfs_data_used_bytes = extractFirstNumber(
    output,
    /^Data,[^:]+:\s+Size:[0-9]+,\s+Used:([0-9]+)/m,
  );
  const btrfs_metadata_total_bytes = extractFirstNumber(
    output,
    /^Metadata,[^:]+:\s+Size:([0-9]+),\s+Used:[0-9]+/m,
  );
  const btrfs_metadata_used_bytes = extractFirstNumber(
    output,
    /^Metadata,[^:]+:\s+Size:[0-9]+,\s+Used:([0-9]+)/m,
  );
  const btrfs_system_total_bytes = extractFirstNumber(
    output,
    /^System,[^:]+:\s+Size:([0-9]+),\s+Used:[0-9]+/m,
  );
  const btrfs_system_used_bytes = extractFirstNumber(
    output,
    /^System,[^:]+:\s+Size:[0-9]+,\s+Used:([0-9]+)/m,
  );
  const globalReserveMatch =
    /^\s*Global reserve:\s+([0-9]+)\s+\(used:\s*([0-9]+)\)/m.exec(output);
  const freeEstimatedMatch =
    /^\s*Free \(estimated\):\s+([0-9]+)(?:\s+\(min:\s*([0-9]+)\))?/m.exec(
      output,
    );
  const disk_available_conservative_bytes = freeEstimatedMatch
    ? parseNonNegativeNumber(freeEstimatedMatch[2] ?? freeEstimatedMatch[1])
    : undefined;

  return {
    disk_device_total_bytes,
    disk_device_used_bytes,
    disk_unallocated_bytes,
    btrfs_data_total_bytes,
    btrfs_data_used_bytes,
    btrfs_metadata_total_bytes,
    btrfs_metadata_used_bytes,
    btrfs_system_total_bytes,
    btrfs_system_used_bytes,
    btrfs_global_reserve_total_bytes: globalReserveMatch
      ? parseNonNegativeNumber(globalReserveMatch[1])
      : undefined,
    btrfs_global_reserve_used_bytes: globalReserveMatch
      ? parseNonNegativeNumber(globalReserveMatch[2])
      : undefined,
    disk_available_conservative_bytes,
  };
}

export function parseDfOutput(output: string): Partial<HostCurrentMetrics> {
  const numericLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => /^[0-9]+\s+[0-9]+\s+[0-9]+$/.test(line));
  if (!numericLine) return {};
  const [totalRaw, usedRaw, availRaw] = numericLine.split(/\s+/);
  return {
    disk_device_total_bytes: parseNonNegativeNumber(totalRaw),
    disk_device_used_bytes: parseNonNegativeNumber(usedRaw),
    disk_available_conservative_bytes: parseNonNegativeNumber(availRaw),
  };
}

export async function readDiskMetrics(
  mount = resolveStorageMount(),
): Promise<Partial<HostCurrentMetrics>> {
  for (const [command, args] of [
    ["btrfs", ["filesystem", "usage", "-b", mount]],
    ["sudo", ["-n", "btrfs", "filesystem", "usage", "-b", mount]],
  ] as const) {
    const btrfsOutput = await runCommand(command, [...args]);
    if (btrfsOutput) {
      const parsed = parseBtrfsUsageOutput(btrfsOutput);
      if (
        parsed.disk_device_total_bytes != null ||
        parsed.btrfs_metadata_total_bytes != null
      ) {
        return parsed;
      }
    }
  }

  const dfOutput = await runCommand("df", [
    "-B1",
    "--output=size,used,avail",
    mount,
  ]);
  return dfOutput ? parseDfOutput(dfOutput) : {};
}
