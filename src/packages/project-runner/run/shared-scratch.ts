import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

function truthyEnv(value: string | undefined): boolean {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function unescapeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(parseInt(octal, 8)),
  );
}

export async function isMountPoint(path: string): Promise<boolean> {
  const resolved = await realpath(path);
  if (resolved === "/") return true;
  try {
    const mountInfo = await readFile("/proc/self/mountinfo", "utf8");
    for (const line of mountInfo.split("\n")) {
      const fields = line.split(" ");
      if (fields.length > 4 && unescapeMountInfoPath(fields[4]) === resolved) {
        return true;
      }
    }
  } catch {
    // Non-Linux fallback below is sufficient for ordinary block-device mounts.
  }
  const parent = dirname(resolved);
  if (!parent || parent === resolved) return true;
  const [selfStat, parentStat] = await Promise.all([
    stat(resolved),
    stat(parent),
  ]);
  return selfStat.dev !== parentStat.dev;
}

export async function resolveSharedScratchMount(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ source: string; target: string } | undefined> {
  if (!truthyEnv(env.COCALC_SHARED_SCRATCH_ENABLED)) {
    return undefined;
  }
  const source =
    `${env.COCALC_SHARED_SCRATCH_HOST_MOUNT ?? "/mnt/cocalc-scratch"}`.trim();
  const target =
    `${env.COCALC_SHARED_SCRATCH_PROJECT_MOUNT ?? "/scratch"}`.trim();
  if (!source || !isAbsolute(source)) {
    throw new Error(
      `shared scratch is enabled but COCALC_SHARED_SCRATCH_HOST_MOUNT is not an absolute path: ${source}`,
    );
  }
  if (!target || !isAbsolute(target)) {
    throw new Error(
      `shared scratch is enabled but COCALC_SHARED_SCRATCH_PROJECT_MOUNT is not an absolute path: ${target}`,
    );
  }
  let sourceStat;
  try {
    sourceStat = await stat(source);
  } catch {
    throw new Error(
      `shared scratch is enabled but host mount ${source} does not exist; reconcile the project host or disable shared scratch`,
    );
  }
  if (!sourceStat.isDirectory()) {
    throw new Error(
      `shared scratch is enabled but host mount ${source} is not a directory`,
    );
  }
  if (!(await isMountPoint(source))) {
    throw new Error(
      `shared scratch is enabled but host path ${source} is not mounted; reconcile the project host before starting projects`,
    );
  }
  return { source, target };
}
