import { accessSync, constants, statSync } from "node:fs";
import { execFileSync } from "node:child_process";

function isUsableDir(dir: string): boolean {
  try {
    const stat = statSync(dir);
    if (!stat.isDirectory()) return false;
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export type PodmanEnvOptions = {
  runAsUser?: string;
};

function userRuntimeDir(user: string): string | undefined {
  try {
    const uid = execFileSync("id", ["-u", user], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!uid) return undefined;
    return `/run/user/${uid}`;
  } catch {
    return undefined;
  }
}

export function podmanEnv(opts: PodmanEnvOptions = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const runAsUser = opts.runAsUser ?? env.COCALC_PODMAN_RUN_AS_USER;
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const configured = env.COCALC_PODMAN_RUNTIME_DIR || env.XDG_RUNTIME_DIR;
  const userRun = runAsUser
    ? userRuntimeDir(runAsUser)
    : typeof uid === "number"
      ? `/run/user/${uid.toString()}`
      : undefined;
  // Podman (especially with crun) expects XDG_RUNTIME_DIR to exist and be writable.
  // On fresh boot, /run/user/<uid> only appears after a user login session, so we
  // rely on systemd linger to ensure it exists, otherwise we fail loudly.
  let runtimeDir = configured && isUsableDir(configured) ? configured : undefined;
  if (!runtimeDir && userRun && isUsableDir(userRun)) {
    runtimeDir = userRun;
  }
  if (!runtimeDir) {
    const userHint =
      runAsUser || env.USER || env.LOGNAME || "the project-host user";
    throw new Error(
      `podman requires XDG_RUNTIME_DIR (expected ${userRun ?? "a user runtime dir"}). ` +
        `Enable linger for ${userHint} (loginctl enable-linger ${userHint}) ` +
        `or set COCALC_PODMAN_RUNTIME_DIR to a writable runtime dir.`,
    );
  }
  env.XDG_RUNTIME_DIR = runtimeDir;
  if (!env.CONTAINERS_CGROUP_MANAGER) {
    env.CONTAINERS_CGROUP_MANAGER = "cgroupfs";
  }
  return env;
}
