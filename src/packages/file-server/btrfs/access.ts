import getLogger from "@cocalc/backend/logger";
import { sudo } from "./util";

const logger = getLogger("file-server:btrfs:access");

function sharedUsers(): { host: string; runner: string } | null {
  const host = (process.env.COCALC_PROJECT_HOST_USER ?? "").trim();
  const runner = (
    process.env.COCALC_PROJECT_RUNNER_USER ??
    process.env.COCALC_PODMAN_RUN_AS_USER ??
    ""
  ).trim();
  if (!host || !runner) return null;
  if (host === runner) return null;
  return { host, runner };
}

export async function applyProjectAccessAcl(path: string): Promise<void> {
  const users = sharedUsers();
  if (!users) return;
  const acl = `u:${users.host}:rwx,u:${users.runner}:rwx`;
  const mode = await sudo({
    command: "chmod",
    args: ["2770", path],
    err_on_exit: false,
    verbose: false,
  });
  if (mode.exit_code) {
    logger.warn("chmod 2770 failed", {
      path,
      host: users.host,
      runner: users.runner,
      stderr: mode.stderr,
    });
  }
  const direct = await sudo({
    command: "setfacl",
    args: ["-m", acl, path],
    err_on_exit: false,
    verbose: false,
  });
  if (direct.exit_code) {
    logger.warn("setfacl failed", {
      path,
      host: users.host,
      runner: users.runner,
      stderr: direct.stderr,
    });
    return;
  }
  const defaults = await sudo({
    command: "setfacl",
    args: ["-d", "-m", acl, path],
    err_on_exit: false,
    verbose: false,
  });
  if (defaults.exit_code) {
    logger.warn("setfacl default ACL failed", {
      path,
      host: users.host,
      runner: users.runner,
      stderr: defaults.stderr,
    });
  }
}
